/**
 * src/sync/sanitize.ts
 *
 * PII sanitization for anonymous error telemetry.
 *
 * Runs entirely client-side before any network call. The goal is to transmit
 * the structural pattern of a git error (what kind of error it is) while
 * stripping any runtime values that might contain user data (file paths,
 * emails, branch names, commit messages, SHAs, URLs).
 *
 * Design principles:
 *   - Fail safe: when uncertain, redact more, not less
 *   - Never block: sanitization errors must not surface to the user
 *   - Preserve signal: keep enough structure to identify new error patterns
 *   - Deterministic: same input always produces same output (testable)
 */

// ─── Known git error prefixes ─────────────────────────────────────────────────
//
// These are structural strings emitted by git itself, containing no user data.
// When an error starts with one of these prefixes, we can extract a clean
// template and transmit it confidently.
//
// Source: git's strbuf.h, error.c, and common error paths reviewed against
// git 2.x source. These strings are stable across git versions.

const KNOWN_GIT_PREFIXES: string[] = [
  "fatal: refusing to merge unrelated histories",
  "fatal: not a git repository",
  "fatal: pathspec",
  "fatal: unable to access",
  "fatal: repository",
  "fatal: Authentication failed",
  "fatal: Could not read from remote repository",
  "fatal: bad object",
  "fatal: ambiguous argument",
  "fatal: detected dubious ownership",
  "error: failed to push some refs",
  "error: src refspec",
  "error: Your local changes to the following files would be overwritten",
  "error: The following untracked working tree files would be overwritten",
  "error: cannot pull with rebase",
  "error: Pulling is not possible because you have unmerged files",
  "CONFLICT",
  "Automatic merge failed",
  "hint: Updates were rejected",
  "hint: You have divergent branches",
  "remote: Repository not found",
  "remote: Invalid username or password",
  "Permission denied (publickey)",
  "Please make sure you have the correct access rights",
  "Your branch is behind",
  "Your branch is ahead",
  "Your branch and",
  "HEAD detached at",
  "HEAD detached from",
  "nothing to commit",
  "nothing added to commit",
  "no changes added to commit",
  "On branch",                          // prefix only — branch name follows but is stripped
  "Changes not staged for commit",
  "Changes to be committed",
  "Untracked files",
  "You are in",                         // "You are in 'detached HEAD' state"
  "Aborting",
  "warning: LF will be replaced by CRLF",
  "warning: CRLF will be replaced by LF",
  "warning: adding embedded git repository",
  "warning: unable to rmdir",
  "rebase in progress",
  "cherry-pick is now empty",
];

// ─── Regex patterns for PII ───────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // git SSH remote URLs — must run before email (git@host matches the email pattern)
  {
    name: "ssh-remote",
    pattern: /git@[A-Za-z0-9.\-]+:[A-Za-z0-9_.\-\/]+/g,
    replacement: "[remote]",
  },
  // URLs
  {
    name: "url",
    pattern: /https?:\/\/[^\s'"]+/g,
    replacement: "[url]",
  },
  // Email addresses
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[email]",
  },
  // File paths — Unix style
  {
    name: "unix-path",
    pattern: /(\/[A-Za-z0-9_.\-]+){2,}/g,
    replacement: "[path]",
  },
  // File paths — Windows style
  {
    name: "windows-path",
    pattern: /[A-Za-z]:\\(?:[A-Za-z0-9_.\-\\]+)+/g,
    replacement: "[path]",
  },
  // Relative paths (./foo/bar or ../foo)
  {
    name: "relative-path",
    pattern: /\.{1,2}\/[A-Za-z0-9_.\-\/]+/g,
    replacement: "[path]",
  },
  // Full SHAs (40 chars) and abbreviated SHAs longer than 8 chars
  // 8-char SHAs are acceptable as they identify a commit without identifying a user
  {
    name: "sha",
    pattern: /\b[0-9a-f]{9,40}\b/g,
    replacement: "[sha]",
  },
  // Branch names after known git keywords — capture prefix, replace name only
  {
    name: "branch-name",
    pattern: /(On branch |refs\/heads\/|origin\/|HEAD -> )([^\s'"]+)/g,
    replacement: "$1[branch]",
  },
  // Quoted strings — single quotes (git uses these for user-supplied values)
  {
    name: "single-quoted",
    pattern: /'[^']{1,200}'/g,
    replacement: "'[REDACTED]'",
  },
  // Quoted strings — double quotes
  {
    name: "double-quoted",
    pattern: /"[^"]{1,200}"/g,
    replacement: '"[REDACTED]"',
  },
  // Backtick-quoted strings
  {
    name: "backtick-quoted",
    pattern: /`[^`]{1,200}`/g,
    replacement: "`[REDACTED]`",
  },
];

// ─── Core sanitization functions ──────────────────────────────────────────────

/**
 * Apply all PII regex patterns to a string.
 * Order matters: email before quoted strings, paths before generic redaction.
 */
function applyPiiPatterns(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Check if the error text starts with a known git error prefix.
 * Returns the matching prefix or null.
 */
function matchKnownPrefix(errorText: string): string | null {
  const normalized = errorText.trimStart();
  for (const prefix of KNOWN_GIT_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

/**
 * Sanitize a git error message for anonymous telemetry transmission.
 *
 * Two-path approach:
 *
 * PATH A (known prefix): We recognize this error class. Extract the structural
 * template by applying PII stripping. The prefix is safe (git wrote it), but
 * anything after a quote, path separator, or colon may be user data.
 *
 * PATH B (unknown prefix): We don't recognize this error. Apply aggressive
 * redaction — strip all quoted strings and PII patterns. The result may be
 * sparse, but it's enough to identify a new error class worth investigating.
 * We mark it as unknown so we can prioritize review.
 *
 * Both paths go through a final safety pass regardless.
 */
export function sanitizeErrorText(rawError: string): SanitizedError {
  if (!rawError || typeof rawError !== "string") {
    return { text: "", isKnown: false, wasSanitized: false };
  }

  // Truncate before any processing — don't process more than needed
  const truncated = rawError.slice(0, 2000).trim();

  // Take only the first line — subsequent lines often contain user-specific context
  const firstLine = truncated.split("\n")[0].trim();

  const knownPrefix = matchKnownPrefix(firstLine);

  let sanitized: string;
  let isKnown: boolean;

  if (knownPrefix) {
    // PATH A: Known error class
    // The prefix itself is safe. Strip PII from the full first line.
    sanitized = applyPiiPatterns(firstLine);
    isKnown = true;
  } else {
    // PATH B: Unknown error class
    // Apply all PII patterns, then check if anything meaningful remains.
    sanitized = applyPiiPatterns(firstLine);

    // If the result is shorter than 20 chars after stripping, it's probably
    // all user data with no structural signal. Transmit just the first word
    // (the error level: "fatal:", "error:", "warning:") plus a placeholder.
    const structuralContent = sanitized.replace(/\[REDACTED\]|\[path\]|\[email\]|\[url\]|\[remote\]|\[sha\]|\[branch\]|\$1/g, "").trim();
    if (structuralContent.length < 20) {
      const errorLevel = firstLine.split(":")[0] || "error";
      sanitized = `${errorLevel}: [unknown pattern — all content redacted]`;
    }
    isKnown = false;
  }

  // Final safety pass — catches anything the path-specific logic missed
  sanitized = applyPiiPatterns(sanitized);

  // Hard length limit on the final output
  sanitized = sanitized.slice(0, 500);

  return {
    text: sanitized,
    isKnown,
    wasSanitized: sanitized !== firstLine,
  };
}

export interface SanitizedError {
  /** The sanitized error text, safe for transmission */
  text: string;
  /** Whether the error matched a known git error prefix */
  isKnown: boolean;
  /** Whether any content was modified during sanitization */
  wasSanitized: boolean;
}

// ─── Telemetry payload builder ────────────────────────────────────────────────

export interface AnonymousErrorReport {
  error_text: string;
  pattern_matched: string | null;
  is_known_git_error: boolean;
  fix_attempted: boolean;
  fix_succeeded: boolean | null;
  versie_version: string;
}

/**
 * Build a telemetry payload from a raw git error.
 * This is the single function the rest of the codebase calls.
 * Returns null if telemetry is disabled or sanitization yields nothing useful.
 */
export function buildTelemetryPayload(
  rawError: string,
  patternMatched: string | null,
  fixAttempted: boolean,
  fixSucceeded: boolean | null,
  versieVersion: string,
): AnonymousErrorReport | null {
  if (process.env.VERSIE_TELEMETRY === "false") {
    return null;
  }

  const { text, isKnown } = sanitizeErrorText(rawError);

  if (!text) {
    return null;
  }

  return {
    error_text: text,
    pattern_matched: patternMatched,
    is_known_git_error: isKnown,
    fix_attempted: fixAttempted,
    fix_succeeded: fixSucceeded,
    versie_version: versieVersion,
  };
}

import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";
import { createAutoSnapshot } from "../snapshots/manager.js";
import { PATTERNS, type ErrorPattern } from "../errors/patterns.js";
import { track } from "../sync/telemetry.js";
import { syncEvent } from "../sync/cloud.js";
import { sanitizeErrorText } from "../sync/sanitize.js";

export const fixThisErrorSchema = {
  description:
    "Say 'fix this error: [message]' to diagnose and fix a Git error automatically. " +
    "Paste the error message and Versie will explain what happened and fix it.",
  inputSchema: z.object({
    error_message: z
      .string()
      .max(10_000)
      .describe("The error message you received. Paste the full text."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function fixThisError(args: z.infer<typeof fixThisErrorSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);
  const errorText = args.error_message;

  // Find matching pattern
  const pattern = PATTERNS.find((p) => p.match.test(errorText));

  if (!pattern) {
    const { text: sanitizedText, isKnown } = sanitizeErrorText(errorText);
    track("fix_this_error", {
      pattern_matched: null,
      fix_attempted: false,
      fix_succeeded: null,
      error_text: sanitizedText,
      is_known_git_error: isKnown,
    }, config);
    syncEvent(repoPath, {
      type: "error",
      timestamp: new Date().toISOString(),
      message: sanitizedText,
      metadata: { error_type: "unknown" },
    }, config).catch(() => {});
    return (
      `I don't recognize that error yet.\n\n` +
      `Error text:\n${errorText}\n\n` +
      `Try these steps:\n` +
      `  1. Say 'check my project health' for a full diagnosis\n` +
      `  2. Contact support: support@versie.co`
    );
  }

  // Snapshot before destructive operations.
  // If snapshot fails, abort — better to leave the error unfixed than lose work with no recovery.
  if (pattern.snapshotFirst) {
    try {
      await createAutoSnapshot(repoPath);
    } catch (err) {
      throw new Error(
        `Couldn't create a safety snapshot before fixing — your project hasn't been changed. ` +
        `Check that your project folder is accessible and try again. (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  // Execute fix sequence
  const results: Array<{ args: string[]; exitCode: number; stderr: string }> = [];
  for (const cmdArgs of pattern.fix) {
    // Substitute placeholder branch names
    const resolved = cmdArgs.map((a) =>
      a === "{devBranch}" ? config.devBranch : a === "{liveBranch}" ? config.liveBranch : a
    );
    const result = await git(resolved, repoPath);
    results.push({ args: resolved, exitCode: result.exitCode, stderr: result.stderr });
    if (result.exitCode !== 0 && pattern.stopOnError !== false) {
      break;
    }
  }

  const failed = results.find((r) => r.exitCode !== 0);

  if (failed) {
    track("fix_this_error", {
      pattern_matched: pattern.id,
      fix_attempted: true,
      fix_succeeded: false,
      error_text: sanitizeErrorText(errorText).text,
      is_known_git_error: true,
    }, config);
    syncEvent(repoPath, {
      type: "error",
      timestamp: new Date().toISOString(),
      message: sanitizeErrorText(errorText).text,
      metadata: { error_type: pattern.id },
    }, config).catch(() => {});
    return (
      `${pattern.explanation}\n\n` +
      `I tried to fix it automatically but ran into another issue:\n${failed.stderr}\n\n` +
      `Please contact support: support@versie.co`
    );
  }

  const now = new Date().toISOString();
  track("fix_this_error", {
    pattern_matched: pattern.id,
    fix_attempted: true,
    fix_succeeded: true,
    error_text: sanitizeErrorText(errorText).text,
    is_known_git_error: true,
  }, config);
  syncEvent(repoPath, {
    type: "error",
    timestamp: now,
    message: sanitizeErrorText(errorText).text,
    metadata: { error_type: pattern.id, resolved_at: now },
  }, config).catch(() => {});
  return `${pattern.explanation}\n\n${pattern.successMessage ?? "Fixed! Try what you were doing again."}`;
}

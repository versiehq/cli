/**
 * src/sync/sanitize.test.ts
 *
 * Tests for the PII sanitization module.
 *
 * These tests are legally significant: they document the specific PII
 * categories we claim to strip and verify that stripping actually works.
 * Any change to sanitize.ts must maintain all tests in this file.
 *
 * Run: npm test -- sanitize
 */

import { sanitizeErrorText, buildTelemetryPayload } from "./sanitize.js";

describe("sanitizeErrorText", () => {

  // ─── Known git errors (PATH A) ─────────────────────────────────────────────

  describe("known git error prefixes", () => {
    test("pure structural error - no PII present - passes through cleanly", () => {
      const raw = "fatal: refusing to merge unrelated histories";
      const { text, isKnown } = sanitizeErrorText(raw);
      expect(text).toBe("fatal: refusing to merge unrelated histories");
      expect(isKnown).toBe(true);
    });

    test("pathspec error - strips file path in quotes", () => {
      const raw = "fatal: pathspec 'src/components/UserProfile.tsx' did not match any files in HEAD";
      const { text, isKnown } = sanitizeErrorText(raw);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("UserProfile");
      expect(text).not.toContain("src/components");
      expect(isKnown).toBe(true);
    });

    test("pathspec error - strips email address in file path", () => {
      const raw = "fatal: pathspec 'src/auth/admin@company.com.ts' did not match any files in HEAD";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("admin@company.com");
      expect(text).not.toContain("company.com");
    });

    test("push error - strips remote URL", () => {
      const raw = "error: failed to push some refs to 'https://github.com/username/private-repo.git'";
      const { text, isKnown } = sanitizeErrorText(raw);
      expect(text).not.toContain("username");
      expect(text).not.toContain("private-repo");
      expect(text).not.toContain("github.com/username");
      expect(isKnown).toBe(true);
    });

    test("push error - strips SSH remote", () => {
      const raw = "error: failed to push some refs to 'git@github.com:myorg/secret-project.git'";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("myorg");
      expect(text).not.toContain("secret-project");
    });

    test("overwrite error - strips file names", () => {
      const raw = "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/config/database-credentials.ts";
      const { text, isKnown } = sanitizeErrorText(raw);
      // Takes only first line
      expect(text).not.toContain("database-credentials");
      expect(text).not.toContain("src/config");
      expect(isKnown).toBe(true);
    });

    test("not a git repo - no PII to strip", () => {
      const raw = "fatal: not a git repository (or any of the parent directories): .git";
      const { text, isKnown } = sanitizeErrorText(raw);
      expect(isKnown).toBe(true);
      expect(text.length).toBeGreaterThan(20);
    });

    test("SHA in error - long SHA stripped, short SHA preserved", () => {
      const raw = "fatal: bad object abcdef1234567890abcdef1234567890abcdef12";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("abcdef1234567890");
      expect(text).toContain("[sha]");
    });

    test("On branch - strips branch name", () => {
      const raw = "On branch feature/johns-secret-feature";
      const { text, isKnown } = sanitizeErrorText(raw);
      expect(text).not.toContain("johns-secret-feature");
      expect(isKnown).toBe(true);
    });
  });

  // ─── PII stripping cases ──────────────────────────────────────────────────

  describe("PII pattern stripping", () => {
    test("strips email addresses", () => {
      const raw = "fatal: pathspec 'john.doe@example.com' did not match";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toMatch(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    });

    test("strips Unix file paths", () => {
      const raw = "error: cannot open /home/alice/projects/my-startup/src/index.ts";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("/home/alice");
      expect(text).not.toContain("my-startup");
    });

    test("strips Windows file paths", () => {
      const raw = "error: cannot open C:\\Users\\alice\\Documents\\Projects\\my-app\\index.js";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("my-app");
    });

    test("strips URLs with personal identifiers", () => {
      const raw = "fatal: unable to access 'https://github.com/alice/private-repo.git/'";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("private-repo");
    });

    test("strips SSH remotes", () => {
      const raw = "Permission denied (publickey). Could not read from remote repository: git@github.com:alice/private.git";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("private");
    });

    test("strips content in single quotes", () => {
      const raw = "error: branch 'feature/my-secret-feature-name' not found";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("my-secret-feature-name");
      expect(text).toContain("[REDACTED]");
    });

    test("strips content in double quotes", () => {
      const raw = `warning: adding embedded git repository "vendor/alice-private-lib"`;
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice-private-lib");
    });
  });

  // ─── Unknown git errors (PATH B) ──────────────────────────────────────────

  describe("unknown git error patterns", () => {
    test("unknown error - marks as not known", () => {
      const raw = "git: 'some-custom-git-extension' is not a git command";
      const { isKnown } = sanitizeErrorText(raw);
      expect(isKnown).toBe(false);
    });

    test("unknown error - still strips PII from content", () => {
      const raw = "custom-hook failed: /home/alice/.git/hooks/pre-commit exited with code 1";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("/home/");
    });

    test("unknown error that is entirely user data - falls back to error level only", () => {
      const raw = "fatal: 'alice@company.com/secret-project.git' — totally custom message";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("secret-project");
      // Should still have some structural content
      expect(text.length).toBeGreaterThan(5);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("empty string", () => {
      const { text } = sanitizeErrorText("");
      expect(text).toBe("");
    });

    test("null/undefined input", () => {
      // @ts-expect-error intentional bad input test
      const { text } = sanitizeErrorText(null);
      expect(text).toBe("");
    });

    test("very long error - truncated", () => {
      const longError = "fatal: " + "a".repeat(3000);
      const { text } = sanitizeErrorText(longError);
      expect(text.length).toBeLessThanOrEqual(500);
    });

    test("multi-line error - only first line processed", () => {
      const multiline = "error: failed to push some refs to 'origin'\nhint: Updates were rejected because the remote contains work you do not have locally.\nhint: This is usually caused by another repository pushing to the same ref.";
      const { text } = sanitizeErrorText(multiline);
      expect(text).not.toContain("Updates were rejected");
      expect(text).not.toContain("\n");
    });

    test("same input always produces same output (deterministic)", () => {
      const raw = "fatal: pathspec 'src/user-data.ts' did not match any files in HEAD";
      const r1 = sanitizeErrorText(raw);
      const r2 = sanitizeErrorText(raw);
      expect(r1.text).toBe(r2.text);
    });

    test("normal git error with no PII is not modified", () => {
      const raw = "fatal: refusing to merge unrelated histories";
      const { wasSanitized } = sanitizeErrorText(raw);
      expect(wasSanitized).toBe(false);
    });
  });

  // ─── Commit message content (high-risk) ───────────────────────────────────
  // Git sometimes surfaces commit messages in error output.
  // These can contain anything the user typed.

  describe("commit message content in errors", () => {
    test("does not transmit commit message content embedded in error", () => {
      const raw = "error: commit 'a1b2c3d4 — Add payment gateway for acme-corp@client.com' is not reachable";
      const { text } = sanitizeErrorText(raw);
      expect(text).not.toContain("acme-corp");
      expect(text).not.toContain("client.com");
      expect(text).not.toContain("Add payment gateway");
    });
  });
});

// ─── buildTelemetryPayload ─────────────────────────────────────────────────

describe("buildTelemetryPayload", () => {
  const origEnv = process.env.VERSIE_TELEMETRY;

  afterEach(() => {
    process.env.VERSIE_TELEMETRY = origEnv;
  });

  test("returns null when VERSIE_TELEMETRY=false", () => {
    process.env.VERSIE_TELEMETRY = "false";
    const result = buildTelemetryPayload(
      "fatal: refusing to merge unrelated histories",
      null, false, null, "1.0.0"
    );
    expect(result).toBeNull();
  });

  test("returns payload when telemetry is enabled", () => {
    process.env.VERSIE_TELEMETRY = "true";
    const result = buildTelemetryPayload(
      "fatal: refusing to merge unrelated histories",
      null, false, null, "1.0.0"
    );
    expect(result).not.toBeNull();
    expect(result!.error_text).toContain("refusing to merge");
    expect(result!.is_known_git_error).toBe(true);
  });

  test("payload never contains raw file paths", () => {
    process.env.VERSIE_TELEMETRY = "true";
    const result = buildTelemetryPayload(
      "fatal: pathspec '/home/alice/secret-project/src/index.ts' did not match",
      "pathspec-not-found", true, false, "1.0.0"
    );
    expect(result!.error_text).not.toContain("alice");
    expect(result!.error_text).not.toContain("secret-project");
  });

  test("payload never contains email addresses", () => {
    process.env.VERSIE_TELEMETRY = "true";
    const result = buildTelemetryPayload(
      "fatal: pathspec 'admin@company.com.ts' did not match any files",
      null, true, false, "1.0.0"
    );
    expect(result!.error_text).not.toMatch(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/);
  });
});

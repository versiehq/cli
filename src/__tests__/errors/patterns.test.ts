import { describe, it, expect } from "vitest";
import { PATTERNS } from "../../errors/patterns.js";

function matchId(errorText: string): string | null {
  return PATTERNS.find((p) => p.match.test(errorText))?.id ?? null;
}

describe("error pattern matching", () => {
  it("matches not-a-repo", () => {
    expect(matchId("fatal: not a git repository (or any parent)")).toBe("not-a-repo");
  });

  it("matches local-changes-overwritten", () => {
    expect(matchId("error: Your local changes would be overwritten by merge")).toBe(
      "local-changes-overwritten"
    );
  });

  it("matches merge-conflict", () => {
    expect(matchId("CONFLICT (content): Merge conflict in src/index.ts")).toBe("merge-conflict");
  });

  it("matches detached-head", () => {
    expect(matchId("HEAD detached at a1b2c3d")).toBe("detached-head");
  });

  it("matches push-rejected (non-fast-forward)", () => {
    expect(matchId(" ! [rejected]  main -> main (non-fast-forward)")).toBe("push-rejected");
  });

  it("matches push-rejected (failed to push some refs)", () => {
    expect(matchId("error: failed to push some refs to 'github.com:user/repo'")).toBe(
      "push-rejected"
    );
  });

  it("matches unrelated-histories", () => {
    expect(matchId("fatal: refusing to merge unrelated histories")).toBe("unrelated-histories");
  });

  it("matches no-upstream", () => {
    expect(matchId("fatal: The current branch has no upstream branch.")).toBe("no-upstream");
  });

  it("matches divergent-branches", () => {
    expect(matchId("hint: Need to specify how to reconcile divergent branches.")).toBe(
      "divergent-branches"
    );
  });

  it("matches permission-denied-ssh", () => {
    expect(matchId("git@github.com: Permission denied (publickey).")).toBe("permission-denied-ssh");
  });

  it("matches lock-file", () => {
    expect(matchId("fatal: Unable to create '/repo/.git/index.lock': File exists.")).toBe(
      "lock-file"
    );
  });

  it("matches checkout-blocked", () => {
    expect(matchId("error: cannot switch branches: you have local changes")).toBe(
      "checkout-blocked"
    );
  });

  it("matches checkout-blocked (Please commit or stash)", () => {
    expect(matchId("Please commit or stash them before you switch branches.")).toBe(
      "checkout-blocked"
    );
  });

  it("matches corrupt-repo", () => {
    expect(matchId("error: broken link from tree")).toBe("corrupt-repo");
  });

  it("matches wrong-branch", () => {
    expect(matchId("You are not currently on branch main.")).toBe("wrong-branch");
  });

  it("matches merge-conflict-deploy", () => {
    expect(matchId("Automatic merge failed; fix conflicts and then commit the result.")).toBe(
      "merge-conflict-deploy"
    );
  });

  it("matches email-privacy (GH007)", () => {
    expect(matchId("remote: error: GH007: Your push would publish a private email address.")).toBe(
      "email-privacy"
    );
  });

  it("returns null for unrecognized error", () => {
    expect(matchId("some completely unknown error message xyz")).toBeNull();
  });

  it("all 15 patterns are present", () => {
    expect(PATTERNS).toHaveLength(15);
  });

  it("all patterns have required fields", () => {
    for (const p of PATTERNS) {
      expect(p.id, `${p.id} missing id`).toBeTruthy();
      expect(p.match, `${p.id} missing match`).toBeInstanceOf(RegExp);
      expect(p.explanation, `${p.id} missing explanation`).toBeTruthy();
      expect(Array.isArray(p.fix), `${p.id} fix is not array`).toBe(true);
      expect(typeof p.snapshotFirst, `${p.id} snapshotFirst wrong type`).toBe("boolean");
    }
  });

  it("patterns that need snapshots before fix have snapshotFirst=true", () => {
    const snapshotIds = PATTERNS.filter((p) => p.snapshotFirst).map((p) => p.id);
    expect(snapshotIds).toContain("detached-head");
    expect(snapshotIds).toContain("merge-conflict-deploy");
    expect(snapshotIds).toContain("corrupt-repo");
  });

  it("{devBranch} and {liveBranch} placeholders appear only in fix arrays", () => {
    for (const p of PATTERNS) {
      for (const step of p.fix) {
        for (const arg of step) {
          if (arg.startsWith("{")) {
            expect(["{devBranch}", "{liveBranch}"]).toContain(arg);
          }
        }
      }
    }
  });
});

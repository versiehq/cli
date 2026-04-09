import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

vi.mock("../../git/branches.js", () => ({
  checkFirstRun: vi.fn(),
  ensureOnDev: vi.fn(),
  getDeployGap: vi.fn(),
  resolveWorkingDir: vi.fn(),
  isClaudeWorktree: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("../../git/safety.js", () => ({
  classifyPushFailure: vi.fn(),
}));

vi.mock("../../sync/cloud.js", () => ({
  syncEvent: vi.fn(),
}));

vi.mock("../../sync/heartbeat.js", () => ({
  sendHeartbeat: vi.fn(),
}));

vi.mock("../../sync/telemetry.js", () => ({
  track: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir, isClaudeWorktree } from "../../git/branches.js";
import { classifyPushFailure } from "../../git/safety.js";
import { saveMyWork } from "../../tools/save-my-work.js";

const mockGit = vi.mocked(git);
const mockEnsureOnDev = vi.mocked(ensureOnDev);
const mockGetDeployGap = vi.mocked(getDeployGap);
const mockResolveWorkingDir = vi.mocked(resolveWorkingDir);
const mockClassifyPushFailure = vi.mocked(classifyPushFailure);
const mockCheckFirstRun = vi.mocked(checkFirstRun);
const mockIsClaudeWorktree = vi.mocked(isClaudeWorktree);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr = ""): GitResult {
  return { stdout: "", stderr, exitCode: 1 };
}

// Proper git porcelain v1 format: XY<space>filename
// " M" = unmodified in index, modified in worktree
const SINGLE_FILE = " M src/foo.ts";
// Two files in a named subdirectory → generateMessage returns area-based message ("Updated components")
const TWO_FILES_AREA = " M components/Button.tsx\n M components/Nav.tsx";

const CONFIG = { liveBranch: "main", devBranch: "versie-dev" };
const REPO = "/fake/repo";

beforeEach(() => {
  // resetAllMocks clears queued mockResolvedValueOnce values AND implementations,
  // preventing mock state from leaking between tests.
  vi.resetAllMocks();
  mockIsClaudeWorktree.mockReturnValue(false);
  mockResolveWorkingDir.mockResolvedValue(REPO);
  mockEnsureOnDev.mockResolvedValue(CONFIG);
  mockGetDeployGap.mockResolvedValue({ count: 1, summaries: ["Updated footer"] });
  mockClassifyPushFailure.mockResolvedValue(null);
  mockCheckFirstRun.mockResolvedValue(null);
});

// Mock a complete successful save: status, add, commit, push, rev-parse HEAD, diff-tree
function mockSuccessfulSave(statusOutput: string) {
  mockGit
    .mockResolvedValueOnce(ok(statusOutput)) // status --porcelain
    .mockResolvedValueOnce(ok())             // add -A
    .mockResolvedValueOnce(ok())             // commit
    .mockResolvedValueOnce(ok())             // push
    .mockResolvedValueOnce(ok("abc123"))     // rev-parse HEAD
    .mockResolvedValueOnce(ok(""));          // diff-tree
}

describe("saveMyWork", () => {
  it("returns 'already saved' message when there are no changes", async () => {
    mockGit.mockResolvedValueOnce(ok("")); // status --porcelain returns empty
    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/already saved/i);
  });

  it("saves files and reports the commit message", async () => {
    mockSuccessfulSave(TWO_FILES_AREA);

    const result = await saveMyWork({ repo_path: REPO });
    // Two files in components/ → "Updated components"
    expect(result).toMatch(/Saved!/i);
    expect(result).toMatch(/components/i);
  });

  it("uses provided description as commit message", async () => {
    mockSuccessfulSave(SINGLE_FILE);

    await saveMyWork({ repo_path: REPO, description: "My custom message" });

    const commitCall = mockGit.mock.calls.find((c) => Array.isArray(c[0]) && c[0].includes("commit"));
    expect(commitCall?.[0]).toContain("My custom message");
  });

  it("generates a message from porcelain status when no description provided", async () => {
    mockSuccessfulSave(TWO_FILES_AREA);

    const result = await saveMyWork({ repo_path: REPO });
    // Auto-generated area message used — save succeeded
    expect(result).toMatch(/Saved!/i);
  });

  it("prompts for description when auto-generated message is a single filename", async () => {
    mockGit.mockResolvedValueOnce(ok(SINGLE_FILE)); // only status needed — returns early

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/describe this change/i);
    expect(result).toMatch(/60 characters/i);
  });

  it("mentions live app was not affected", async () => {
    mockSuccessfulSave(SINGLE_FILE);

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/live app wasn't affected/i);
  });

  it("shows deploy gap reminder when more than 1 save pending", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 5, summaries: [] });
    mockSuccessfulSave(SINGLE_FILE);

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/5 saves/i);
    expect(result).toMatch(/ship it/i);
  });

  it("does not show gap reminder when only 1 save pending", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockSuccessfulSave(SINGLE_FILE);

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).not.toMatch(/saves waiting/i);
  });

  it("retries push after pull --rebase on diverged history rejection", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE)) // status
      .mockResolvedValueOnce(ok())             // add -A
      .mockResolvedValueOnce(ok())             // commit
      .mockResolvedValueOnce(fail("rejected")) // push fails
      .mockResolvedValueOnce(ok())             // pull --rebase
      .mockResolvedValueOnce(ok())             // retry push
      .mockResolvedValueOnce(ok("abc123"))     // rev-parse HEAD
      .mockResolvedValueOnce(ok(""));          // diff-tree

    mockClassifyPushFailure.mockResolvedValue(null); // unrecognized → rebase path

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/Saved!/i);
  });

  it("throws when push fails even after retry", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("rejected"))      // push fails
      .mockResolvedValueOnce(ok())                  // pull --rebase
      .mockResolvedValueOnce(fail("still rejected")); // retry fails

    mockClassifyPushFailure.mockResolvedValue(null);

    await expect(
      saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" })
    ).rejects.toThrow(/couldn't sync to GitHub/i);
  });

  it("returns no-remote message when project has no GitHub remote", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Repository not found")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "This project isn't connected to GitHub yet."
    );

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/isn't connected to GitHub/i);
  });

  it("returns SSH auth message when SSH key is not authorized", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Permission denied (publickey)")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — your SSH key may not be authorized."
    );

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/SSH key/i);
  });

  it("returns HTTPS sign-in message when GitHub credentials are missing", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("could not read Username")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — it looks like you're not signed in."
    );

    const result = await saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/not signed in/i);
  });

  it("throws when git commit fails", async () => {
    mockGit
      .mockResolvedValueOnce(ok(SINGLE_FILE))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("nothing to commit")); // commit fails

    await expect(
      saveMyWork({ repo_path: REPO, description: "Fixed nav alignment" })
    ).rejects.toThrow(/Save failed/i);
  });
});

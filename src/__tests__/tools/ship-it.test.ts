import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

vi.mock("../../git/branches.js", () => ({
  checkFirstRun: vi.fn(),
  ensureInitialized: vi.fn(),
  getDeployGap: vi.fn(),
  resolveWorkingDir: vi.fn(),
}));

vi.mock("../../git/safety.js", () => ({
  checkNoWorktrees: vi.fn(),
  classifyPushFailure: vi.fn(),
}));

vi.mock("../../snapshots/manager.js", () => ({
  createAutoSnapshot: vi.fn(),
  createReleaseTag: vi.fn(),
}));

vi.mock("../../tools/save-my-work.js", () => ({
  saveMyWork: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { checkFirstRun, ensureInitialized, getDeployGap, resolveWorkingDir } from "../../git/branches.js";
import { checkNoWorktrees, classifyPushFailure } from "../../git/safety.js";
import { createReleaseTag } from "../../snapshots/manager.js";
import { saveMyWork } from "../../tools/save-my-work.js";
import { shipIt } from "../../tools/ship-it.js";

const mockGit = vi.mocked(git);
const mockEnsureInitialized = vi.mocked(ensureInitialized);
const mockGetDeployGap = vi.mocked(getDeployGap);
const mockResolveWorkingDir = vi.mocked(resolveWorkingDir);
const mockCheckFirstRun = vi.mocked(checkFirstRun);
const mockCheckNoWorktrees = vi.mocked(checkNoWorktrees);
const mockClassifyPushFailure = vi.mocked(classifyPushFailure);
const mockCreateReleaseTag = vi.mocked(createReleaseTag);
const mockSaveMyWork = vi.mocked(saveMyWork);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr = ""): GitResult {
  return { stdout: "", stderr, exitCode: 1 };
}

const CONFIG = { liveBranch: "main", devBranch: "versie-dev" };
const REPO = "/fake/repo";

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveWorkingDir.mockResolvedValue(REPO);
  mockCheckFirstRun.mockResolvedValue(null);
  mockEnsureInitialized.mockResolvedValue(CONFIG);
  mockCheckNoWorktrees.mockResolvedValue({ ok: true });
  mockCreateReleaseTag.mockResolvedValue("versie/release/v1");
  mockSaveMyWork.mockResolvedValue("Saved!");
  mockClassifyPushFailure.mockResolvedValue(null); // default: unrecognized failure → throw
});

describe("shipIt", () => {
  it("returns warning when active worktrees are detected", async () => {
    mockCheckNoWorktrees.mockResolvedValue({ ok: false, message: "Active worktree session open." });
    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/worktree/i);
    expect(mockGit).not.toHaveBeenCalled();
  });

  it("returns 'already up to date' when nothing to deploy", async () => {
    mockGit.mockResolvedValue(ok("")); // status --porcelain
    mockGetDeployGap.mockResolvedValue({ count: 0, summaries: [] });
    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/already up to date/i);
  });

  it("saves uncommitted work before deploying", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts")) // status
      .mockResolvedValueOnce(ok()) // checkout main
      .mockResolvedValueOnce(ok()) // pull
      .mockResolvedValueOnce(ok()) // merge
      .mockResolvedValueOnce(ok()) // push
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 2, summaries: ["Add login", "Fix bug"] });

    await shipIt({ repo_path: REPO });
    expect(mockSaveMyWork).toHaveBeenCalledWith({ repo_path: REPO });
  });

  it("does not call saveMyWork when working directory is already clean", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // status --porcelain (clean)
      .mockResolvedValueOnce(ok()) // checkout main
      .mockResolvedValueOnce(ok()) // pull
      .mockResolvedValueOnce(ok()) // merge
      .mockResolvedValueOnce(ok()) // push
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: ["Fix bug"] });

    await shipIt({ repo_path: REPO });
    expect(mockSaveMyWork).not.toHaveBeenCalled();
  });

  it("returns conflict message and aborts merge on conflict", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // status
      .mockResolvedValueOnce(ok()) // checkout main
      .mockResolvedValueOnce(ok()) // pull
      .mockResolvedValueOnce(fail("Automatic merge failed; fix conflicts")) // merge fails
      .mockResolvedValueOnce(ok()) // merge --abort
      .mockResolvedValueOnce(ok()) // checkout versie-dev
      .mockResolvedValueOnce(ok("src/index.ts")); // diff --name-only --diff-filter=U

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: ["Fix bug"] });

    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/paused the release/i);
    expect(result).toMatch(/src\/index\.ts/);
    expect(result).toMatch(/ship it/i);
  });

  it("returns to versie-dev after conflict", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // status
      .mockResolvedValueOnce(ok()) // checkout main
      .mockResolvedValueOnce(ok()) // pull
      .mockResolvedValueOnce(fail("Automatic merge failed")) // merge fails
      .mockResolvedValueOnce(ok()) // merge --abort
      .mockResolvedValueOnce(ok()) // checkout versie-dev  ← happens before diff
      .mockResolvedValueOnce(ok("conflict.ts")); // diff --name-only

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });

    await shipIt({ repo_path: REPO });

    // checkout versie-dev is the 6th call (index 5), diff is last — verify checkout happened
    const checkoutCall = mockGit.mock.calls.find(
      (c) => c[0][0] === "checkout" && c[0][1] === "versie-dev"
    );
    expect(checkoutCall).toBeDefined();
  });

  it("returns success message with deploy summary", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // status
      .mockResolvedValueOnce(ok()) // checkout main
      .mockResolvedValueOnce(ok()) // pull
      .mockResolvedValueOnce(ok()) // merge
      .mockResolvedValueOnce(ok()) // push
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({
      count: 2,
      summaries: ["Added payment form", "Fixed header"],
    });

    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/Shipped!/i);
    expect(result).toMatch(/2 changes/i);
    expect(result).toMatch(/Added payment form/);
    expect(result).toMatch(/Fixed header/);
    expect(result).toMatch(/versie\/release\/v1/);
  });

  it("returns to versie-dev after successful deploy", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: ["Fix bug"] });

    await shipIt({ repo_path: REPO });

    const lastCall = mockGit.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual(["checkout", "versie-dev"]);
  });

  it("throws and returns to dev when push fails with unrecognized error", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("permission denied")) // push fails
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockClassifyPushFailure.mockResolvedValue(null);

    await expect(shipIt({ repo_path: REPO })).rejects.toThrow(/Deploy failed/i);

    const lastCall = mockGit.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual(["checkout", "versie-dev"]);
  });

  it("returns soft message and goes to dev when push fails with no remote", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Repository not found")) // push fails
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockClassifyPushFailure.mockResolvedValue("This project isn't connected to GitHub yet.");

    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/isn't connected to GitHub/i);
    expect(result).toMatch(/ship it/i);

    const checkoutCall = mockGit.mock.calls.find(
      (c) => c[0][0] === "checkout" && c[0][1] === "versie-dev"
    );
    expect(checkoutCall).toBeDefined();
  });

  it("returns SSH auth message when push fails on SSH remote", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Permission denied (publickey)")) // push fails
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — your SSH key may not be authorized."
    );

    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/SSH key/i);
    expect(result).toMatch(/ship it/i);
  });

  it("returns HTTPS auth message when push fails on HTTPS remote", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("could not read Username")) // push fails
      .mockResolvedValueOnce(ok()); // checkout versie-dev

    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — it looks like you're not signed in."
    );

    const result = await shipIt({ repo_path: REPO });
    expect(result).toMatch(/not signed in/i);
    expect(result).toMatch(/ship it/i);
  });
});

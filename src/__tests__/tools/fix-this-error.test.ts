import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

vi.mock("../../git/branches.js", () => ({
  ensureInitialized: vi.fn(),
  resolveWorkingDir: vi.fn(),
}));

vi.mock("../../snapshots/manager.js", () => ({
  createAutoSnapshot: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { ensureInitialized, resolveWorkingDir } from "../../git/branches.js";
import { createAutoSnapshot } from "../../snapshots/manager.js";
import { fixThisError } from "../../tools/fix-this-error.js";

const mockGit = vi.mocked(git);
const mockEnsureInitialized = vi.mocked(ensureInitialized);
const mockCreateAutoSnapshot = vi.mocked(createAutoSnapshot);
const mockResolveWorkingDir = vi.mocked(resolveWorkingDir);

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
  mockEnsureInitialized.mockResolvedValue(CONFIG);
  mockCreateAutoSnapshot.mockResolvedValue("versie/snapshot/2024-01-01T00-00-00-000Z");
});

describe("fixThisError", () => {
  it("returns helpful message for unrecognized errors", async () => {
    const result = await fixThisError({
      error_message: "completely unknown xyz error",
      repo_path: REPO,
    });
    expect(result).toMatch(/don't recognize/i);
    expect(result).toMatch(/check my project health/i);
    expect(result).toMatch(/support@versie\.co/i);
  });

  it("matches the not-a-repo pattern and applies fix", async () => {
    mockGit.mockResolvedValue(ok());
    const result = await fixThisError({
      error_message: "fatal: not a git repository",
      repo_path: REPO,
    });
    expect(mockGit).toHaveBeenCalledWith(["init"], REPO);
    expect(result).toMatch(/save my work/i);
  });

  it("creates snapshot before destructive fix (detached-head)", async () => {
    mockGit.mockResolvedValue(ok());
    await fixThisError({
      error_message: "HEAD detached at a1b2c3d",
      repo_path: REPO,
    });
    expect(mockCreateAutoSnapshot).toHaveBeenCalledWith(REPO);
  });

  it("does not create snapshot for non-destructive fixes (push-rejected)", async () => {
    mockGit.mockResolvedValue(ok());
    await fixThisError({
      error_message: "error: failed to push some refs to 'github.com:user/repo'",
      repo_path: REPO,
    });
    expect(mockCreateAutoSnapshot).not.toHaveBeenCalled();
  });

  it("substitutes {devBranch} placeholder with actual branch name", async () => {
    mockGit.mockResolvedValue(ok());
    await fixThisError({
      error_message: "HEAD detached at a1b2c3d",
      repo_path: REPO,
    });
    const checkoutCall = mockGit.mock.calls.find((c) => c[0].includes("checkout"));
    expect(checkoutCall?.[0]).toContain("versie-dev");
    expect(checkoutCall?.[0]).not.toContain("{devBranch}");
  });

  it("substitutes {liveBranch} placeholder in fix steps", async () => {
    mockGit.mockResolvedValue(ok());
    await fixThisError({
      error_message: "fatal: refusing to merge unrelated histories",
      repo_path: REPO,
    });
    const pullCall = mockGit.mock.calls.find((c) => c[0].includes("pull"));
    expect(pullCall?.[0]).toContain("main");
    expect(pullCall?.[0]).not.toContain("{liveBranch}");
  });

  it("returns explanation + successMessage on successful fix", async () => {
    mockGit.mockResolvedValue(ok());
    const result = await fixThisError({
      error_message: "error: failed to push some refs",
      repo_path: REPO,
    });
    // push-rejected pattern: pulls then pushes
    expect(result).toMatch(/Synced and saved/i);
  });

  it("reports the failing step when a fix command fails", async () => {
    mockGit
      .mockResolvedValueOnce(ok()) // first step succeeds
      .mockResolvedValueOnce(fail("permission denied")); // second step fails

    const result = await fixThisError({
      error_message: "error: failed to push some refs",
      repo_path: REPO,
    });
    expect(result).toMatch(/ran into another issue/i);
    expect(result).toMatch(/permission denied/i);
    expect(result).toMatch(/support@versie\.co/i);
  });

  it("throws when snapshot creation fails before destructive fix", async () => {
    mockCreateAutoSnapshot.mockRejectedValue(new Error("disk full"));
    await expect(
      fixThisError({
        error_message: "HEAD detached at a1b2c3d",
        repo_path: REPO,
      })
    ).rejects.toThrow(/safety snapshot/i);
  });

  it("continues executing fix steps even on failure for stopOnError=false patterns", async () => {
    // corrupt-repo pattern has stopOnError: false
    mockGit
      .mockResolvedValueOnce(fail("fsck found errors")) // fsck fails
      .mockResolvedValueOnce(ok()); // gc still runs

    await fixThisError({
      error_message: "error: broken link from tree",
      repo_path: REPO,
    });

    const gcCall = mockGit.mock.calls.find((c) => c[0].includes("gc"));
    expect(gcCall).toBeDefined();
  });

  it("returns plain-language explanation (no git jargon in explanation)", async () => {
    mockGit.mockResolvedValue(ok());
    const result = await fixThisError({
      error_message: "fatal: not a git repository",
      repo_path: REPO,
    });
    // Should not contain raw git terminology in the explanation part
    expect(result).not.toMatch(/\bgit init\b/); // the git command itself shouldn't appear in user output
  });
});

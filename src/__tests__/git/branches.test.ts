import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { readConfig } from "../../utils/config.js";
import { getDeployGap, ensureOnDev } from "../../git/branches.js";

const mockGit = vi.mocked(git);
const mockReadConfig = vi.mocked(readConfig);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const REPO = "/fake/repo";
const CONFIG = { liveBranch: "main", devBranch: "versie-dev" };

beforeEach(() => {
  vi.clearAllMocks();
  mockReadConfig.mockReturnValue(CONFIG);
});

describe("getDeployGap", () => {
  // Helper: normal fetch sequence (no rollback) — fetch, aheadCheck (empty), update-ref, then log
  function mockNormalFetch(logOutput = "") {
    mockGit
      .mockResolvedValueOnce(ok(""))        // fetch
      .mockResolvedValueOnce(ok(""))        // aheadCheck — empty = no rollback
      .mockResolvedValueOnce(ok(""))        // update-ref
      .mockResolvedValueOnce(ok(logOutput)); // log
  }

  it("returns count=0 and empty summaries when nothing to deploy", async () => {
    mockNormalFetch();
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap).toEqual({ count: 0, summaries: [] });
  });

  it("counts commits correctly", async () => {
    mockNormalFetch("abc1234 Updated footer\ndef5678 Fixed header");
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.count).toBe(2);
  });

  it("strips commit hashes from summaries", async () => {
    mockNormalFetch("abc1234 Updated footer\ndef5678 Fixed header");
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.summaries).toEqual(["Updated footer", "Fixed header"]);
  });

  it("calls fetch, aheadCheck, update-ref, then log with origin/main when fetch succeeds", async () => {
    mockNormalFetch();
    await getDeployGap(REPO, CONFIG);
    expect(mockGit).toHaveBeenNthCalledWith(1, ["fetch", "origin", "main"], REPO);
    expect(mockGit).toHaveBeenNthCalledWith(2, ["log", "origin/main..main", "--oneline"], REPO);
    expect(mockGit).toHaveBeenNthCalledWith(3, ["update-ref", "refs/heads/main", "origin/main"], REPO);
    expect(mockGit).toHaveBeenNthCalledWith(4, ["log", "origin/main..versie-dev", "--oneline"], REPO);
  });

  it("sets dashboardRollbackDetected when local main is ahead of origin", async () => {
    mockGit
      .mockResolvedValueOnce(ok(""))                      // fetch
      .mockResolvedValueOnce(ok("abc1234 Merge dev\n"))   // aheadCheck — has commits = rollback
      .mockResolvedValueOnce(ok(""))                      // update-ref
      .mockResolvedValueOnce(ok("def5678 New save\n"));   // log
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.dashboardRollbackDetected).toBe(true);
  });

  it("does not set dashboardRollbackDetected in normal state", async () => {
    mockNormalFetch("abc1234 New save");
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.dashboardRollbackDetected).toBeUndefined();
  });

  it("falls back to local live branch and skips ahead-check/update-ref when fetch fails", async () => {
    mockGit
      .mockResolvedValueOnce({ stdout: "", stderr: "network error", exitCode: 1 }) // fetch fails
      .mockResolvedValueOnce(ok("")); // log (no aheadCheck or update-ref)
    await getDeployGap(REPO, CONFIG);
    expect(mockGit).toHaveBeenNthCalledWith(2, ["log", "main..versie-dev", "--oneline"], REPO);
  });

  it("uses provided config without calling readConfig again", async () => {
    mockNormalFetch();
    await getDeployGap(REPO, CONFIG);
    expect(mockReadConfig).not.toHaveBeenCalled();
  });
});

describe("ensureOnDev", () => {
  it("does not switch branch when already on versie-dev", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie-dev")) // branch --show-current
      .mockResolvedValueOnce(ok("origin")); // git config branch.versie-dev.remote — already set

    await ensureOnDev(REPO, CONFIG);
    expect(mockGit).toHaveBeenCalledWith(["branch", "--show-current"], REPO);
    expect(mockGit).not.toHaveBeenCalledWith(["checkout", "versie-dev"], REPO);
  });

  it("switches to versie-dev when on a different branch", async () => {
    mockGit
      .mockResolvedValueOnce(ok("main")) // branch --show-current
      .mockResolvedValueOnce(ok()) // checkout versie-dev
      .mockResolvedValueOnce(ok("origin")); // git config branch.versie-dev.remote — set

    await ensureOnDev(REPO, CONFIG);
    expect(mockGit).toHaveBeenCalledWith(["checkout", "versie-dev"], REPO);
  });

  it("writes tracking config when upstream is not set", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie-dev")) // branch --show-current
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // git config branch.versie-dev.remote — not set
      .mockResolvedValueOnce(ok()) // git config branch.versie-dev.remote origin
      .mockResolvedValueOnce(ok()); // git config branch.versie-dev.merge refs/heads/versie-dev

    await ensureOnDev(REPO, CONFIG);
    expect(mockGit).toHaveBeenCalledWith(
      ["config", "branch.versie-dev.remote", "origin"],
      REPO
    );
    expect(mockGit).toHaveBeenCalledWith(
      ["config", "branch.versie-dev.merge", "refs/heads/versie-dev"],
      REPO
    );
  });

  it("does not write tracking config when upstream is already set", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie-dev")) // branch --show-current
      .mockResolvedValueOnce(ok("origin")); // git config branch.versie-dev.remote — already set

    await ensureOnDev(REPO, CONFIG);
    expect(mockGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(["config", "branch.versie-dev.remote", "origin"]),
      REPO
    );
  });

  it("returns the config", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie-dev"))
      .mockResolvedValueOnce(ok("origin"));
    const result = await ensureOnDev(REPO, CONFIG);
    expect(result).toEqual(CONFIG);
  });
});

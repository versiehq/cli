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
  checkIsRepo: vi.fn(),
  checkNoWorktrees: vi.fn(),
  checkDeployConfig: vi.fn(),
}));

vi.mock("../../snapshots/manager.js", () => ({
  listCheckpoints: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { checkFirstRun, ensureInitialized, getDeployGap, resolveWorkingDir } from "../../git/branches.js";
import { checkIsRepo, checkNoWorktrees, checkDeployConfig } from "../../git/safety.js";
import { listCheckpoints } from "../../snapshots/manager.js";
import { checkHealth } from "../../tools/check-health.js";

const mockGit = vi.mocked(git);
const mockEnsureInitialized = vi.mocked(ensureInitialized);
const mockGetDeployGap = vi.mocked(getDeployGap);
const mockResolveWorkingDir = vi.mocked(resolveWorkingDir);
const mockCheckIsRepo = vi.mocked(checkIsRepo);
const mockCheckNoWorktrees = vi.mocked(checkNoWorktrees);
const mockCheckDeployConfig = vi.mocked(checkDeployConfig);
const mockListCheckpoints = vi.mocked(listCheckpoints);
const mockCheckFirstRun = vi.mocked(checkFirstRun);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const CONFIG = { liveBranch: "main", devBranch: "versie-dev" };
const REPO = "/fake/repo";

function setupDefaults() {
  mockResolveWorkingDir.mockResolvedValue(REPO);
  mockCheckFirstRun.mockResolvedValue(null);
  mockCheckIsRepo.mockResolvedValue({ ok: true });
  mockEnsureInitialized.mockResolvedValue(CONFIG);
  mockGetDeployGap.mockResolvedValue({ count: 0, summaries: [] });
  mockCheckNoWorktrees.mockResolvedValue({ ok: true });
  mockCheckDeployConfig.mockResolvedValue(null);
  mockListCheckpoints.mockResolvedValue([]);
  // branch --show-current, status --porcelain, remote
  mockGit
    .mockResolvedValueOnce(ok("versie-dev"))
    .mockResolvedValueOnce(ok(""))
    .mockResolvedValueOnce(ok("origin"));
}

beforeEach(() => {
  vi.resetAllMocks();
  setupDefaults();
});

describe("checkHealth", () => {
  it("returns early error when not a git repo", async () => {
    mockCheckIsRepo.mockResolvedValue({ ok: false, message: "Not a repo. Run: git init" });
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/Not a repo/i);
    expect(mockGit).not.toHaveBeenCalled();
  });

  it("reports workspace branch as healthy", async () => {
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/workspace/i);
    expect(result).toContain("✓");
  });

  it("switches back to versie-dev when user is on live branch", async () => {
    mockGit.mockReset();
    mockGit
      .mockResolvedValueOnce(ok("main")) // branch --show-current → on live branch!
      .mockResolvedValueOnce(ok()) // checkout versie-dev
      .mockResolvedValueOnce(ok("")) // status
      .mockResolvedValueOnce(ok("origin")); // remote

    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/live version/i);
    expect(result).toMatch(/switched/i);
    const checkoutCall = mockGit.mock.calls.find(
      (c) => c[0][0] === "checkout" && c[0][1] === "versie-dev"
    );
    expect(checkoutCall).toBeDefined();
  });

  it("reports unsaved changes count", async () => {
    mockGit.mockReset();
    mockGit
      .mockResolvedValueOnce(ok("versie-dev"))
      .mockResolvedValueOnce(ok("M src/a.ts\nM src/b.ts\nA src/c.ts"))
      .mockResolvedValueOnce(ok("origin"));

    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/3 unsaved/i);
    expect(result).toMatch(/save my work/i);
  });

  it("reports healthy deploy status when fully synced", async () => {
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/up to date/i);
  });

  it("reports small deploy gap as informational", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 3, summaries: [] });
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/3 save/i);
    expect(result).toMatch(/ship it/i);
  });

  it("warns when deploy gap is large", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 12, summaries: [] });
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/12 saves/i);
    expect(result).toMatch(/⚠/);
  });

  it("reports not connected to GitHub when no remote", async () => {
    mockGit.mockReset();
    mockGit
      .mockResolvedValueOnce(ok("versie-dev"))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("")); // no remote

    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/GitHub/i);
    expect(result).toMatch(/⚠/);
  });

  it("warns about active worktrees", async () => {
    mockCheckNoWorktrees.mockResolvedValue({
      ok: false,
      message: "Active worktree session detected.",
    });
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/worktree/i);
  });

  it("reports checkpoint count", async () => {
    mockListCheckpoints.mockResolvedValue([
      "checkpoint/alpha",
      "checkpoint/beta",
    ]);
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/2 checkpoints/i);
  });

  it("includes deploy platform warning when misconfigured", async () => {
    mockCheckDeployConfig.mockResolvedValue(
      "Your Vercel project may be set to deploy from every save."
    );
    const result = await checkHealth({ repo_path: REPO });
    expect(result).toMatch(/Vercel/i);
  });
});

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
  it("returns count=0 and empty summaries when nothing to deploy", async () => {
    mockGit.mockResolvedValue(ok(""));
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap).toEqual({ count: 0, summaries: [] });
  });

  it("counts commits correctly", async () => {
    mockGit.mockResolvedValue(ok("abc1234 Updated footer\ndef5678 Fixed header"));
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.count).toBe(2);
  });

  it("strips commit hashes from summaries", async () => {
    mockGit.mockResolvedValue(ok("abc1234 Updated footer\ndef5678 Fixed header"));
    const gap = await getDeployGap(REPO, CONFIG);
    expect(gap.summaries).toEqual(["Updated footer", "Fixed header"]);
  });

  it("calls git log with correct branch range", async () => {
    mockGit.mockResolvedValue(ok(""));
    await getDeployGap(REPO, CONFIG);
    expect(mockGit).toHaveBeenCalledWith(
      ["log", "main..versie-dev", "--oneline"],
      REPO
    );
  });

  it("uses provided config without calling readConfig again", async () => {
    mockGit.mockResolvedValue(ok(""));
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

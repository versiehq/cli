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
  isClaudeWorktree: vi.fn().mockReturnValue(false),
}));

vi.mock("../../utils/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("../../git/safety.js", () => ({
  classifyPushFailure: vi.fn(),
}));

import { git } from "../../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir } from "../../git/branches.js";
import { classifyPushFailure } from "../../git/safety.js";
import { saveMyWork } from "../../tools/save-my-work.js";

const mockGit = vi.mocked(git);
const mockEnsureOnDev = vi.mocked(ensureOnDev);
const mockGetDeployGap = vi.mocked(getDeployGap);
const mockResolveWorkingDir = vi.mocked(resolveWorkingDir);
const mockClassifyPushFailure = vi.mocked(classifyPushFailure);
const mockCheckFirstRun = vi.mocked(checkFirstRun);

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
  mockEnsureOnDev.mockResolvedValue(CONFIG);
  mockGetDeployGap.mockResolvedValue({ count: 1, summaries: ["Updated footer"] });
  mockClassifyPushFailure.mockResolvedValue(null);
  mockCheckFirstRun.mockResolvedValue(null);
});

describe("saveMyWork", () => {
  it("returns 'already saved' message when there are no changes", async () => {
    mockGit.mockResolvedValue(ok("")); // status --porcelain returns empty
    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/already saved/i);
  });

  it("saves files and reports count", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/index.ts\nM src/app.ts")) // status
      .mockResolvedValueOnce(ok()) // add -A
      .mockResolvedValueOnce(ok()) // commit
      .mockResolvedValueOnce(ok()); // push

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/2 files/);
    expect(result).toMatch(/Saved!/i);
  });

  it("uses provided description as commit message", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/index.ts")) // status
      .mockResolvedValueOnce(ok()) // add -A
      .mockResolvedValueOnce(ok()) // commit
      .mockResolvedValueOnce(ok()); // push

    await saveMyWork({ repo_path: REPO, description: "My custom message" });

    const commitCall = mockGit.mock.calls.find((c) => c[0].includes("commit"));
    expect(commitCall?.[0]).toContain("My custom message");
  });

  it("generates a message from porcelain status when no description provided", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/index.ts")) // status
      .mockResolvedValueOnce(ok()) // add -A
      .mockResolvedValueOnce(ok()) // commit
      .mockResolvedValueOnce(ok()); // push

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/index\.ts/i);
  });

  it("mentions live app was not affected", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/live app wasn't affected/i);
  });

  it("shows deploy gap reminder when more than 1 save pending", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 5, summaries: [] });
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/5 saves/i);
    expect(result).toMatch(/ship it/i);
  });

  it("does not show gap reminder when only 1 save pending", async () => {
    mockGetDeployGap.mockResolvedValue({ count: 1, summaries: [] });
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).not.toMatch(/saves waiting/i);
  });

  it("retries push after pull --rebase on diverged history rejection", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts")) // status
      .mockResolvedValueOnce(ok()) // add -A
      .mockResolvedValueOnce(ok()) // commit
      .mockResolvedValueOnce(fail("rejected")) // push fails
      .mockResolvedValueOnce(ok()) // pull --rebase
      .mockResolvedValueOnce(ok()); // retry push

    mockClassifyPushFailure.mockResolvedValue(null); // unrecognized → rebase path

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/Saved!/i);
  });

  it("throws when push fails even after retry", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("rejected")) // push fails
      .mockResolvedValueOnce(ok()) // pull --rebase
      .mockResolvedValueOnce(fail("still rejected")); // retry fails

    mockClassifyPushFailure.mockResolvedValue(null);

    await expect(saveMyWork({ repo_path: REPO })).rejects.toThrow(/couldn't sync to GitHub/i);
  });

  it("returns no-remote message when project has no GitHub remote", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Repository not found")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "This project isn't connected to GitHub yet."
    );

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/isn't connected to GitHub/i);
  });

  it("returns SSH auth message when SSH key is not authorized", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("Permission denied (publickey)")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — your SSH key may not be authorized."
    );

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/SSH key/i);
  });

  it("returns HTTPS sign-in message when GitHub credentials are missing", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("could not read Username")); // push fails

    mockClassifyPushFailure.mockResolvedValue(
      "Couldn't sync to GitHub — it looks like you're not signed in."
    );

    const result = await saveMyWork({ repo_path: REPO });
    expect(result).toMatch(/Saved on your computer/i);
    expect(result).toMatch(/not signed in/i);
  });

  it("throws when git commit fails", async () => {
    mockGit
      .mockResolvedValueOnce(ok("M src/foo.ts"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("nothing to commit")); // commit fails

    await expect(saveMyWork({ repo_path: REPO })).rejects.toThrow(/Save failed/i);
  });
});

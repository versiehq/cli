import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

import { git } from "../../git/executor.js";
import {
  checkIsRepo,
  checkCleanWorkdir,
  checkNoWorktrees,
  checkHasRemote,
  checkDeployConfig,
} from "../../git/safety.js";

const mockGit = vi.mocked(git);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr = ""): GitResult {
  return { stdout: "", stderr, exitCode: 1 };
}

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "versie-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkIsRepo", () => {
  it("returns ok when inside a git repo", async () => {
    mockGit.mockResolvedValue(ok("true"));
    expect(await checkIsRepo(dir)).toEqual({ ok: true });
  });

  it("returns not ok with hint when not a repo", async () => {
    mockGit.mockResolvedValue(fail("fatal: not a git repository"));
    const result = await checkIsRepo(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/git init/);
  });
});

describe("checkCleanWorkdir", () => {
  it("returns ok when working directory is clean", async () => {
    mockGit.mockResolvedValue(ok(""));
    expect(await checkCleanWorkdir(dir)).toEqual({ ok: true });
  });

  it("returns not ok when there are uncommitted changes", async () => {
    mockGit.mockResolvedValue(ok("M src/index.ts\nA src/new.ts"));
    const result = await checkCleanWorkdir(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unsaved/i);
  });
});

describe("checkNoWorktrees", () => {
  it("returns ok with only the main worktree", async () => {
    mockGit.mockResolvedValue(ok("worktree /repo\nHEAD abc123\nbranch refs/heads/main"));
    expect(await checkNoWorktrees(dir)).toEqual({ ok: true });
  });

  it("returns not ok when additional worktrees are present", async () => {
    mockGit.mockResolvedValue(
      ok(
        "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree /other\nHEAD def456\nbranch refs/heads/feature"
      )
    );
    const result = await checkNoWorktrees(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/worktree/i);
  });
});

describe("checkHasRemote", () => {
  it("returns ok when remote is configured", async () => {
    mockGit.mockResolvedValue(ok("origin"));
    expect(await checkHasRemote(dir)).toEqual({ ok: true });
  });

  it("returns not ok when no remote is configured", async () => {
    mockGit.mockResolvedValue(ok(""));
    const result = await checkHasRemote(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/GitHub/i);
  });
});

describe("checkDeployConfig", () => {
  it("returns null when no deploy config files are present", async () => {
    expect(await checkDeployConfig(dir, "main")).toBeNull();
  });

  it("warns when vercel.json exists without a github key", async () => {
    writeFileSync(join(dir, "vercel.json"), JSON.stringify({ version: 2 }));
    const result = await checkDeployConfig(dir, "main");
    expect(result).toMatch(/Vercel/i);
    expect(result).toMatch(/main/);
  });

  it("returns null when vercel.json has a github key (already configured)", async () => {
    writeFileSync(
      join(dir, "vercel.json"),
      JSON.stringify({ version: 2, github: { enabled: true } })
    );
    expect(await checkDeployConfig(dir, "main")).toBeNull();
  });

  it("warns when netlify.toml exists without the production branch set", async () => {
    writeFileSync(join(dir, "netlify.toml"), '[build]\n  command = "npm run build"\n');
    const result = await checkDeployConfig(dir, "main");
    expect(result).toMatch(/Netlify/i);
    expect(result).toMatch(/main/);
  });

  it("returns null when netlify.toml has the correct production branch", async () => {
    writeFileSync(
      join(dir, "netlify.toml"),
      '[context.production]\n  branch = "main"\n'
    );
    expect(await checkDeployConfig(dir, "main")).toBeNull();
  });
});

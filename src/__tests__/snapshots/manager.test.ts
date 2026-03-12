import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitResult } from "../../git/executor.js";

vi.mock("../../git/executor.js", () => ({
  git: vi.fn(),
  isSuccess: (r: GitResult) => r.exitCode === 0,
}));

import { git } from "../../git/executor.js";
import {
  createAutoSnapshot,
  createReleaseTag,
  createCheckpoint,
  listCheckpoints,
  findCheckpoint,
} from "../../snapshots/manager.js";

const mockGit = vi.mocked(git);

function ok(stdout = ""): GitResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr = ""): GitResult {
  return { stdout: "", stderr, exitCode: 1 };
}

const REPO = "/fake/repo";

beforeEach(() => vi.clearAllMocks());

describe("createAutoSnapshot", () => {
  it("creates a snapshot tag with versie/snapshot/ prefix", async () => {
    mockGit.mockResolvedValue(ok());
    const tag = await createAutoSnapshot(REPO);
    expect(tag).toMatch(/^versie\/snapshot\//);
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(["tag", "-a", tag, "-m", expect.any(String)]),
      REPO
    );
  });
});

describe("createReleaseTag", () => {
  it("creates v1 when no previous release tags exist", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // tag -l (no existing)
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const tag = await createReleaseTag(REPO);
    expect(tag).toBe("versie/release/v1");
  });

  it("increments correctly from existing tags", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie/release/v3\nversie/release/v2\nversie/release/v1"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const tag = await createReleaseTag(REPO);
    expect(tag).toBe("versie/release/v4");
  });

  it("handles non-sequential tags by finding the true max", async () => {
    mockGit
      .mockResolvedValueOnce(ok("versie/release/v10\nversie/release/v2"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const tag = await createReleaseTag(REPO);
    expect(tag).toBe("versie/release/v11");
  });
});

describe("listCheckpoints", () => {
  it("returns empty array when no checkpoints exist", async () => {
    mockGit.mockResolvedValue(ok(""));
    expect(await listCheckpoints(REPO)).toEqual([]);
  });

  it("returns checkpoint tags sorted by creation date", async () => {
    mockGit.mockResolvedValue(
      ok("versie/checkpoint/beta\nversie/checkpoint/alpha\nversie/checkpoint/mvp")
    );
    const result = await listCheckpoints(REPO);
    expect(result).toEqual(["versie/checkpoint/beta", "versie/checkpoint/alpha", "versie/checkpoint/mvp"]);
  });
});

describe("findCheckpoint", () => {
  it("returns null when no checkpoints match", async () => {
    mockGit.mockResolvedValue(ok("versie/checkpoint/alpha\nversie/checkpoint/beta"));
    expect(await findCheckpoint(REPO, "gamma")).toBeNull();
  });

  it("finds checkpoint by partial name match", async () => {
    mockGit.mockResolvedValue(ok("versie/checkpoint/my-mvp\nversie/checkpoint/beta"));
    expect(await findCheckpoint(REPO, "mvp")).toBe("versie/checkpoint/my-mvp");
  });

  it("match is case-insensitive", async () => {
    mockGit.mockResolvedValue(ok("versie/checkpoint/MyFeature"));
    expect(await findCheckpoint(REPO, "myfeature")).toBe("versie/checkpoint/MyFeature");
  });
});

describe("createCheckpoint", () => {
  it("creates a checkpoint and returns atLimit=false when below limit", async () => {
    // listCheckpoints returns 3 existing
    mockGit
      .mockResolvedValueOnce(ok("versie/checkpoint/a\nversie/checkpoint/b\nversie/checkpoint/c"))
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const result = await createCheckpoint(REPO, "my feature");
    expect(result.atLimit).toBe(false);
    expect(result.tagName).toBe("versie/checkpoint/my-feature");
  });

  it("returns atLimit=true when at the 5-checkpoint limit", async () => {
    mockGit.mockResolvedValueOnce(
      ok(
        "versie/checkpoint/a\nversie/checkpoint/b\nversie/checkpoint/c\n" +
          "versie/checkpoint/d\nversie/checkpoint/e"
      )
    );

    const result = await createCheckpoint(REPO, "sixth");
    expect(result.atLimit).toBe(true);
    expect(result.tagName).toBe("");
    // Should not have tried to create the tag
    expect(mockGit).toHaveBeenCalledTimes(1);
  });

  it("sanitizes checkpoint names to safe tag characters", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // listCheckpoints
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const result = await createCheckpoint(REPO, "My Feature! v2.0");
    expect(result.tagName).toBe("versie/checkpoint/my-feature--v2-0");
  });

  it("returns atLimit=true when creating the fifth checkpoint (at limit after create)", async () => {
    // 4 existing → after this one = 5 = at limit
    mockGit
      .mockResolvedValueOnce(
        ok("versie/checkpoint/a\nversie/checkpoint/b\nversie/checkpoint/c\nversie/checkpoint/d")
      )
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await createCheckpoint(REPO, "fifth");
    expect(result.atLimit).toBe(true);
    expect(result.tagName).toBe("versie/checkpoint/fifth");
  });

  it("throws when git tag command fails", async () => {
    mockGit
      .mockResolvedValueOnce(ok("")) // listCheckpoints
      .mockResolvedValueOnce(fail("tag already exists")); // tag -a fails

    await expect(createCheckpoint(REPO, "dupe")).rejects.toThrow(/Failed to create checkpoint/);
  });
});

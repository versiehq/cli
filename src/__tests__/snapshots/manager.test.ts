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
  it("creates a snapshot tag with snapshot/ prefix", async () => {
    mockGit.mockResolvedValue(ok());
    const tag = await createAutoSnapshot(REPO);
    expect(tag).toMatch(/^snapshot\//);
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
    expect(tag).toBe("v1");
  });

  it("increments correctly from existing tags", async () => {
    mockGit
      .mockResolvedValueOnce(ok("v3\nv2\nv1"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const tag = await createReleaseTag(REPO);
    expect(tag).toBe("v4");
  });

  it("handles non-sequential tags by finding the true max", async () => {
    mockGit
      .mockResolvedValueOnce(ok("v10\nv2"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const tag = await createReleaseTag(REPO);
    expect(tag).toBe("v11");
  });
});

describe("listCheckpoints", () => {
  it("returns empty array when no checkpoints exist", async () => {
    mockGit.mockResolvedValue(ok(""));
    expect(await listCheckpoints(REPO)).toEqual([]);
  });

  it("returns checkpoint tags sorted by creation date", async () => {
    mockGit.mockResolvedValue(
      ok("checkpoint/beta\ncheckpoint/alpha\ncheckpoint/mvp")
    );
    const result = await listCheckpoints(REPO);
    expect(result).toEqual(["checkpoint/beta", "checkpoint/alpha", "checkpoint/mvp"]);
  });
});

describe("findCheckpoint", () => {
  it("returns null when no checkpoints match", async () => {
    mockGit.mockResolvedValue(ok("checkpoint/alpha|alpha\ncheckpoint/beta|beta"));
    expect(await findCheckpoint(REPO, "gamma")).toBeNull();
  });

  it("finds checkpoint by partial name match", async () => {
    mockGit.mockResolvedValue(ok("checkpoint/my-mvp|my mvp\ncheckpoint/beta|beta"));
    expect(await findCheckpoint(REPO, "mvp")).toBe("checkpoint/my-mvp");
  });

  it("match is case-insensitive", async () => {
    mockGit.mockResolvedValue(ok("checkpoint/MyFeature|MyFeature"));
    expect(await findCheckpoint(REPO, "myfeature")).toBe("checkpoint/MyFeature");
  });
});

describe("createCheckpoint", () => {
  it("creates a checkpoint with sanitized name", async () => {
    mockGit
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const result = await createCheckpoint(REPO, "my feature");
    expect(result.tagName).toBe("checkpoint/my-feature");
  });

  it("allows unlimited checkpoints (no limit enforcement)", async () => {
    mockGit
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const result = await createCheckpoint(REPO, "tenth");
    expect(result.tagName).toBe("checkpoint/tenth");
  });

  it("sanitizes checkpoint names to safe tag characters", async () => {
    mockGit
      .mockResolvedValueOnce(ok()) // tag -a
      .mockResolvedValueOnce(ok()); // push

    const result = await createCheckpoint(REPO, "My Feature! v2.0");
    expect(result.tagName).toBe("checkpoint/my-feature--v2-0");
  });

  it("throws when git tag command fails", async () => {
    mockGit
      .mockResolvedValueOnce(fail("tag already exists")); // tag -a fails

    await expect(createCheckpoint(REPO, "dupe")).rejects.toThrow(/Failed to create checkpoint/);
  });
});

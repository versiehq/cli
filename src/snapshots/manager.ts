import { git, isSuccess } from "../git/executor.js";
import { logger } from "../utils/logger.js";

const CHECKPOINT_PREFIX = "versie/checkpoint";
const SNAPSHOT_PREFIX = "versie/snapshot";
const RELEASE_PREFIX = "versie/release";
const FREE_CHECKPOINT_LIMIT = 5;

/**
 * Create an auto-snapshot before a destructive operation.
 * Auto-snapshots are unlimited — they're not user-visible checkpoints.
 */
export async function createAutoSnapshot(repoPath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tagName = `${SNAPSHOT_PREFIX}/${timestamp}`;
  await git(["tag", "-a", tagName, "-m", `Auto-snapshot before operation`], repoPath);
  logger.debug(`Auto-snapshot created: ${tagName}`);
  return tagName;
}

/**
 * Create a named user checkpoint on versie-dev.
 * Enforces the 5-checkpoint limit on the free tier.
 * Returns { tagName, limitReached } — caller decides whether to show upgrade prompt.
 */
export async function createCheckpoint(
  repoPath: string,
  name: string
): Promise<{ tagName: string; atLimit: boolean }> {
  const existing = await listCheckpoints(repoPath);

  if (existing.length >= FREE_CHECKPOINT_LIMIT) {
    return { tagName: "", atLimit: true };
  }

  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
  const tagName = `${CHECKPOINT_PREFIX}/${safeName}`;

  const result = await git(
    ["tag", "-a", tagName, "-m", name],
    repoPath
  );

  if (!isSuccess(result)) {
    throw new Error(`Failed to create checkpoint: ${result.stderr}`);
  }

  // Push tag to remote (best effort)
  await git(["push", "origin", tagName], repoPath);

  logger.info(`Checkpoint created: ${tagName}`);
  return { tagName, atLimit: existing.length + 1 >= FREE_CHECKPOINT_LIMIT };
}

/** List all user checkpoints (not auto-snapshots) */
export async function listCheckpoints(repoPath: string): Promise<string[]> {
  const result = await git(
    ["tag", "-l", `${CHECKPOINT_PREFIX}/*`, "--sort=-creatordate"],
    repoPath
  );
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Create an auto-release tag after ship_it.
 * Tags go on the live branch after merge.
 * Returns the tag name (e.g. versie/release/v3).
 */
export async function createReleaseTag(repoPath: string): Promise<string> {
  const result = await git(
    ["tag", "-l", `${RELEASE_PREFIX}/*`, "--sort=-creatordate"],
    repoPath
  );
  const existing = result.stdout.split("\n").filter(Boolean);

  // Find highest existing version number
  let maxNum = 0;
  for (const tag of existing) {
    const match = tag.match(/versie\/release\/v(\d+)/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }

  const nextNum = maxNum + 1;
  const tagName = `${RELEASE_PREFIX}/v${nextNum}`;

  await git(["tag", "-a", tagName, "-m", `Release v${nextNum}`], repoPath);
  await git(["push", "origin", tagName], repoPath);

  logger.info(`Release tag created: ${tagName}`);
  return tagName;
}

/** Find a checkpoint by partial name match */
export async function findCheckpoint(
  repoPath: string,
  query: string
): Promise<string | null> {
  // Fetch tag name + annotation message together so we can search both
  const result = await git(
    ["tag", "-l", `${CHECKPOINT_PREFIX}/*`, "--sort=-creatordate", "--format=%(refname:short)|%(subject)"],
    repoPath
  );

  const entries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const pipeIdx = line.indexOf("|");
      return {
        tag: line.slice(0, pipeIdx).trim(),
        subject: line.slice(pipeIdx + 1).trim(),
      };
    });

  if (entries.length === 0) return null;

  // Normalize query: strip noise words users append ("checkpoint", "restore"),
  // then convert spaces to hyphens to match sanitized tag slugs.
  const lower = query.toLowerCase();
  const stripped = lower.replace(/\bcheckpoint\b/g, "").trim();
  const normalized = stripped.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

  // Try matches in order of specificity
  const found =
    entries.find((e) => e.tag.toLowerCase().includes(lower)) ??           // exact slug match
    entries.find((e) => e.subject.toLowerCase().includes(lower)) ??       // annotation contains full query
    entries.find((e) => normalized && e.tag.toLowerCase().includes(normalized)) ??    // slug with spaces→hyphens
    entries.find((e) => stripped && e.subject.toLowerCase().includes(stripped));      // annotation stripped

  return found?.tag ?? null;
}

/** Find a release tag by partial match (e.g. "v2" or "release") */
export async function findRelease(
  repoPath: string,
  query: string
): Promise<string | null> {
  const result = await git(
    ["tag", "-l", `${RELEASE_PREFIX}/*`, "--sort=-creatordate"],
    repoPath
  );
  const tags = result.stdout.split("\n").filter(Boolean);
  const lower = query.toLowerCase();
  return tags.find((t) => t.toLowerCase().includes(lower)) ?? null;
}

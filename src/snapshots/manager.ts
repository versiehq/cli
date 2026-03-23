import { git, isSuccess } from "../git/executor.js";
import { readConfig, writeConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

const CHECKPOINT_PREFIX = "checkpoint";
const SNAPSHOT_PREFIX = "snapshot";

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
 * Checkpoints are unlimited in all tiers.
 */
export async function createCheckpoint(
  repoPath: string,
  name: string
): Promise<{ tagName: string }> {
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
  return { tagName };
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
 * Tags as v1, v2, v3 — clean standard format, visible on GitHub releases.
 * Determines next version by scanning ALL v* git tags (local + fetched remote)
 * so numbering stays correct even if config is wiped or the repo had existing releases.
 * Stores the tag name in config.releases so Versie can identify its own releases later.
 */
export async function createReleaseTag(repoPath: string): Promise<string> {
  // Scan all v[0-9]* tags to find the current highest version
  const gitTagsResult = await git(["tag", "-l", "v[0-9]*"], repoPath);
  const gitTags = gitTagsResult.stdout.split("\n").filter(Boolean);

  let maxNum = 0;
  for (const tag of gitTags) {
    const match = tag.match(/^v(\d+)/); // handles v1, v1.0.0, v1.2.3
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }

  // Also check config.releases in case local tags aren't fully fetched
  const config = readConfig(repoPath);
  for (const tag of config?.releases ?? []) {
    const match = tag.match(/^v(\d+)$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }

  const nextNum = maxNum + 1;
  const tagName = `v${nextNum}`;

  await git(["tag", "-a", tagName, "-m", `Release v${nextNum}`], repoPath);
  await git(["push", "origin", tagName], repoPath);

  // Track in config so we can identify Versie-created releases in timeline / go-back-to
  if (config) {
    writeConfig(repoPath, { ...config, releases: [...(config.releases ?? []), tagName] });
  }

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

/** Find a Versie-created release tag by partial match (e.g. "v2", "2", "last release") */
export async function findRelease(
  repoPath: string,
  query: string
): Promise<string | null> {
  const config = readConfig(repoPath);
  const releases = config?.releases ?? [];
  if (releases.length === 0) return null;

  const lower = query.toLowerCase().trim();
  // "last release" / "latest" → most recent (last in array)
  if (/\b(last|latest|most recent)\b/.test(lower)) {
    return releases[releases.length - 1] ?? null;
  }
  // Match by exact tag ("v2") or bare number ("2")
  return (
    releases.find((t) => t.toLowerCase() === lower) ??
    releases.find((t) => t.toLowerCase() === `v${lower}`) ??
    releases.find((t) => t.toLowerCase().includes(lower)) ??
    null
  );
}

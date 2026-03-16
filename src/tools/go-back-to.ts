import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";
import { createAutoSnapshot, findCheckpoint, findRelease } from "../snapshots/manager.js";

export const goBackToSchema = {
  description:
    "Say 'go back to [checkpoint name or time]' to restore an earlier version. " +
    "Say 'go back to live' to reset to what's currently live.",
  inputSchema: z.object({
    target: z
      .string()
      .max(500)
      .describe(
        "What to restore to. Examples: 'live version', 'yesterday', 'before I added payments', 'mvp-ready'"
      ),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

const LIVE_PATTERNS =
  /\b(live|deployed|production|what.s live|current site|last deploy|last release)\b/i;

export async function goBackTo(args: z.infer<typeof goBackToSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);
  const target = args.target;

  // Always snapshot current state before a destructive restore.
  // If snapshot fails, abort — better to do nothing than lose work with no recovery point.
  try {
    await createAutoSnapshot(repoPath);
  } catch (err) {
    throw new Error(
      `Couldn't create a safety snapshot before restoring — your work hasn't been changed. ` +
      `Check that your project folder is accessible and try again. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  // Case 1: Restore versie-dev to match the live branch
  if (LIVE_PATTERNS.test(target)) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", config.liveBranch], repoPath);
    const pushResult = await git(
      ["push", "--force-with-lease", "origin", config.devBranch],
      repoPath
    );
    if (pushResult.exitCode !== 0) {
      // Local-only repo or push failed — still report success locally
    }

    const gitNote = config.showGitCommands ? `\n(git: reset --hard ${config.liveBranch} · push --force-with-lease)` : "";
    return (
      `Restored to the live version. Your workspace now matches what's live.\n` +
      `Your previous work was saved as a snapshot in case you need it.${gitNote}`
    );
  }

  // Case 2: Try to find a named checkpoint
  const checkpoint = await findCheckpoint(repoPath, target);
  if (checkpoint) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", checkpoint], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const name = checkpoint.replace("checkpoint/", "");
    const gitNote = config.showGitCommands ? `\n(git: reset --hard ${checkpoint} · push --force-with-lease)` : "";
    return (
      `Restored to checkpoint '${name}'.\n` +
      `Your live app wasn't affected — only your workspace was updated.\n` +
      `Your previous work was saved as a snapshot in case you need it.${gitNote}`
    );
  }

  // Case 3: Try to find a named release tag (e.g. "v2", "2", "last release")
  const releaseTag = await findRelease(repoPath, target);
  if (releaseTag) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", releaseTag], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const gitNote = config.showGitCommands ? `\n(git: reset --hard ${releaseTag} · push --force-with-lease)` : "";
    return (
      `Restored to ${releaseTag} — your workspace now matches that shipped version.\n` +
      `Your live app wasn't affected — only your workspace was updated.\n` +
      `Your previous work was saved as a snapshot in case you need it.${gitNote}`
    );
  }

  // Case 4: Search commit history for matching message or date
  const logResult = await git(
    [
      "log",
      config.devBranch,
      "--oneline",
      "--format=%H|%s|%ar",
      "-50",
    ],
    repoPath
  );

  const entries = logResult.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, relDate] = line.split("|");
      return { hash, message, relDate };
    });

  const lower = target.toLowerCase();
  const match = entries.find(
    (e) =>
      e.message?.toLowerCase().includes(lower) ||
      e.relDate?.toLowerCase().includes(lower)
  );

  if (match) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", match.hash], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const gitNote = config.showGitCommands ? `\n(git: reset --hard ${match.hash} · push --force-with-lease)` : "";
    return (
      `Restored to '${match.message}' (${match.relDate}).\n` +
      `Your live app wasn't affected — only your workspace was updated.\n` +
      `Your previous work was saved as a snapshot in case you need it.${gitNote}`
    );
  }

  // Nothing found
  return (
    `I couldn't find '${target}' in your project history.\n\n` +
    `Try:\n` +
    `  - 'live version' — go back to what's currently live\n` +
    `  - A checkpoint name (say 'show my timeline' to see checkpoints)\n` +
    `  - A description like 'before I changed the header'`
  );
}

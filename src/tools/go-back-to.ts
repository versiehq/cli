import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureInitialized } from "../git/branches.js";
import { createAutoSnapshot, findCheckpoint } from "../snapshots/manager.js";
import { resolveRepoPath } from "../utils/config.js";

export const goBackToSchema = {
  description:
    "Restore your workspace to an earlier version. Say 'live version' to go back to " +
    "what's currently deployed. Say a checkpoint name or describe a point in time to " +
    "restore your work history.",
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
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

const LIVE_PATTERNS =
  /\b(live|deployed|production|what.s live|current site|last deploy|last release)\b/i;

export async function goBackTo(args: z.infer<typeof goBackToSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);
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

    return (
      `Restored to the live version. Your workspace now matches what's deployed.\n` +
      `Your previous work was saved as a snapshot in case you need it.`
    );
  }

  // Case 2: Try to find a named checkpoint
  const checkpoint = await findCheckpoint(repoPath, target);
  if (checkpoint) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", checkpoint], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const name = checkpoint.replace("versie/checkpoint/", "");
    return (
      `Restored to checkpoint '${name}'.\n` +
      `Your live app wasn't affected — only your workspace was updated.\n` +
      `Your previous work was saved as a snapshot in case you need it.`
    );
  }

  // Case 3: Search commit history for matching message or date
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

    return (
      `Restored to '${match.message}' (${match.relDate}).\n` +
      `Your live app wasn't affected — only your workspace was updated.\n` +
      `Your previous work was saved as a snapshot in case you need it.`
    );
  }

  // Nothing found
  return (
    `I couldn't find '${target}' in your project history.\n\n` +
    `Try:\n` +
    `  - 'live version' — go back to what's currently deployed\n` +
    `  - A checkpoint name (say 'show my timeline' to see checkpoints)\n` +
    `  - A description like 'before I changed the header'`
  );
}

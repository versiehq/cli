import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureInitialized, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { checkNoWorktrees } from "../git/safety.js";
import { createAutoSnapshot, createReleaseTag } from "../snapshots/manager.js";
import { saveMyWork } from "./save-my-work.js";

export const shipItSchema = {
  description:
    "Deploy your current work to the live version. This updates your live app with " +
    "everything you've saved since your last deploy. Your work is saved first automatically, " +
    "and a release checkpoint is created so you can always roll back.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function shipIt(args: z.infer<typeof shipItSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const config = await ensureInitialized(repoPath);

  // Safety: warn about active worktrees
  const worktreeCheck = await checkNoWorktrees(repoPath);
  if (!worktreeCheck.ok) {
    return `⚠ ${worktreeCheck.message}`;
  }

  // Step 1: Save any uncommitted changes first
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (statusResult.stdout.trim()) {
    await saveMyWork({ repo_path: repoPath });
  }

  // Step 2: Get deploy gap before merge (pass config to avoid re-reading)
  const gap = await getDeployGap(repoPath, config);
  if (gap.count === 0) {
    return "Your live app is already up to date — nothing new to deploy.";
  }

  // Step 3: Switch to live branch and pull latest
  await git(["checkout", config.liveBranch], repoPath);
  const pullResult = await git(["pull"], repoPath);
  if (pullResult.exitCode !== 0) {
    // If pull fails (no remote, no upstream), try without remote
    await git(["pull", "--allow-unrelated-histories"], repoPath);
  }

  // Step 4: Merge versie-dev into live branch
  const mergeResult = await git(["merge", config.devBranch, "--no-edit"], repoPath);
  if (mergeResult.exitCode !== 0) {
    // Conflict — abort and return to dev
    await git(["merge", "--abort"], repoPath);
    await git(["checkout", config.devBranch], repoPath);

    // Find conflicting files
    const conflictResult = await git(
      ["diff", "--name-only", "--diff-filter=U"],
      repoPath
    );
    const files = conflictResult.stdout.split("\n").filter(Boolean);
    const fileList = files.length > 0 ? `\n  - ${files.join("\n  - ")}` : "";

    return (
      `Your work and the live version both changed the same file${files.length !== 1 ? "s" : ""}:${fileList}\n\n` +
      `I've paused the deploy. Fix the conflicts in those files, then say 'ship it' again.`
    );
  }

  // Step 5: Push live branch
  const pushResult = await git(["push"], repoPath);
  if (pushResult.exitCode !== 0) {
    // Push failed — go back to dev and report
    await git(["checkout", config.devBranch], repoPath);
    throw new Error(`Deploy failed while pushing: ${pushResult.stderr}`);
  }

  // Step 6: Create release tag on live branch, then switch back to dev
  const releaseTag = await createReleaseTag(repoPath);
  await git(["checkout", config.devBranch], repoPath);

  // Build report
  const summaryLines =
    gap.summaries.length > 0
      ? "\n" + gap.summaries.map((s) => `  - ${s}`).join("\n")
      : "";

  return (
    `Shipped! ✓ Your live app is updating now.\n` +
    `Deployed ${gap.count} change${gap.count === 1 ? "" : "s"} since your last deploy:${summaryLines}\n` +
    `\nRelease saved as ${releaseTag} — you can always roll back to this point.`
  );
}

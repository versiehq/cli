import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { checkNoWorktrees, classifyPushFailure, checkDeployConfig } from "../git/safety.js";
import { createAutoSnapshot, createReleaseTag } from "../snapshots/manager.js";
import { saveMyWork } from "./save-my-work.js";

export const shipItSchema = {
  description:
    "Say 'ship it' to go live. Auto-saves first, then pushes everything to the live version.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

export async function shipIt(args: z.infer<typeof shipItSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
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
    return "Your live app is already up to date — nothing new to ship.";
  }

  // Step 2b: Pre-ship deploy platform check — warn before touching the live branch
  const deployWarning = await checkDeployConfig(repoPath, config.liveBranch);
  if (deployWarning) {
    return (
      `⚠ Hold on — ${deployWarning}\n\n` +
      `Fix this in your platform settings first, then say "ship it" again. ` +
      `Say "help with shipping setup" for step-by-step instructions.`
    );
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
      `I've paused the release. Fix the conflicts in those files, then say 'ship it' again.`
    );
  }

  // Step 5: Push live branch
  let pushResult = await git(["push"], repoPath);

  // First-time push: live branch has no upstream yet — set it automatically
  if (pushResult.exitCode !== 0 && /no upstream branch|no tracking information|has no upstream/i.test(pushResult.stderr)) {
    pushResult = await git(["push", "-u", "origin", config.liveBranch], repoPath);
  }

  if (pushResult.exitCode !== 0) {
    await git(["checkout", config.devBranch], repoPath);
    const failureMsg = await classifyPushFailure(repoPath, pushResult.stderr);
    if (failureMsg !== null) {
      return `Your work is saved, but it didn't go live.\n\n${failureMsg}\n\nOnce that's fixed, say 'ship it' again.`;
    }
    throw new Error(`Shipping failed while pushing: ${pushResult.stderr}`);
  }

  // Step 6: Create release tag on live branch, then switch back to dev
  const releaseTag = await createReleaseTag(repoPath);
  await git(["checkout", config.devBranch], repoPath);

  const changeCount = `${gap.count} change${gap.count === 1 ? "" : "s"}`;

  const gitNote = config.showGitCommands
    ? `\n(git: merge ${config.devBranch} → ${config.liveBranch} · push · tag ${releaseTag})`
    : "";

  if (config.verbose) {
    const summaryLines = gap.summaries.length > 0
      ? "\n" + gap.summaries.map((s) => `  - ${s}`).join("\n")
      : "";
    return (
      `Shipped! ✓ Your live app is updating now.\n` +
      `Shipped ${changeCount} since you last shipped:${summaryLines}\n` +
      `\nRelease saved as ${releaseTag} — you can always roll back to this point.${gitNote}`
    );
  }

  const summary = gap.summaries.length > 0 ? ` — ${gap.summaries.slice(0, 2).join(", ")}${gap.summaries.length > 2 ? "…" : ""}` : "";
  return `Shipped! ${changeCount} live${summary}. (${releaseTag})${gitNote}`;
}

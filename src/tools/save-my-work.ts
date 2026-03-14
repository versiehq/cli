import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir, isClaudeWorktree } from "../git/branches.js";
import { classifyPushFailure } from "../git/safety.js";

export const saveMyWorkSchema = {
  description:
    "Say 'save my work' to save current progress. " +
    "Your work is saved to your workspace — your live app won't change until you say 'ship it'.",
  inputSchema: z.object({
    description: z
      .string()
      .optional()
      .describe("Optional short description of what you changed."),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Auto-set in Claude Code; ask the user in Claude Desktop."),
  }),
};

export async function saveMyWork(args: z.infer<typeof saveMyWorkSchema.inputSchema>): Promise<string> {
  const inWorktree = isClaudeWorktree(args.repo_path);
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureOnDev(repoPath);

  // Check for changes
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (!statusResult.stdout.trim()) {
    return "Everything is already saved — no new changes since your last save.";
  }

  // Stage all changes
  await git(["add", "-A"], repoPath);

  // Generate commit message from diff stat, or use provided description
  let message = args.description ?? "";
  if (!message) {
    const diffStat = await git(["diff", "--cached", "--stat"], repoPath);
    message = generateMessage(diffStat.stdout);
  }

  // Commit
  const commitResult = await git(["commit", "-m", message], repoPath);
  if (commitResult.exitCode !== 0) {
    throw new Error(`Save failed: ${commitResult.stderr}`);
  }

  const fileCount = countFiles(statusResult.stdout);
  const savedMsg = `Saved on your computer! ${fileCount} file${fileCount === 1 ? "" : "s"} updated — ${message}.`;

  // Push to dev branch, setting upstream tracking so plain `git push` works in terminal
  const pushResult = await git(["push", "-u", "origin", config.devBranch], repoPath);
  if (pushResult.exitCode !== 0) {
    const failureMsg = await classifyPushFailure(repoPath, pushResult.stderr);
    if (failureMsg !== null) {
      return `${savedMsg}\n\n${failureMsg}`;
    }

    // Likely diverged history — try pull --rebase then retry
    await git(["pull", "--rebase", "origin", config.devBranch], repoPath);
    const retryPush = await git(["push", "-u", "origin", config.devBranch], repoPath);
    if (retryPush.exitCode !== 0) {
      throw new Error(
        `Saved locally but couldn't sync to GitHub: ${retryPush.stderr}`
      );
    }
  }

  // Get deploy gap for context (pass config to avoid re-reading)
  const gap = await getDeployGap(repoPath, config);
  const gapNote =
    gap.count > 1
      ? `\n${gap.count} saves ready to ship — say 'ship it' when ready.`
      : "";

  const worktreeNote = inWorktree
    ? "\n\n(You're working through Claude's session — saves always go to your workspace, not your live app. Say 'ship it' when you're ready to go live.)"
    : "";

  const gitNote = config.showGitCommands ? `\n(git: add · commit · push origin ${config.devBranch})` : "";
  return `Saved! ${fileCount} file${fileCount === 1 ? "" : "s"} updated — ${message}. (Your live app wasn't affected.)${gapNote}${worktreeNote}${gitNote}`;
}

function generateMessage(diffStat: string): string {
  if (!diffStat.trim()) return "Updated project files";
  const lines = diffStat.split("\n").filter((l) => l.includes("|"));
  if (lines.length === 0) return "Updated project files";
  if (lines.length === 1) {
    const file = lines[0].split("|")[0].trim().split("/").pop() ?? "file";
    return `Updated ${file}`;
  }
  return `Updated ${lines.length} files`;
}

function countFiles(porcelain: string): number {
  return porcelain.split("\n").filter(Boolean).length;
}

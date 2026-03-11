import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureOnDev, getDeployGap } from "../git/branches.js";
import { resolveRepoPath } from "../utils/config.js";

export const saveMyWorkSchema = {
  description:
    "Save your current progress. Your work is saved to your workspace — " +
    "your live app won't change until you say 'ship it'.",
  inputSchema: z.object({
    description: z
      .string()
      .optional()
      .describe("Optional short description of what you changed."),
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function saveMyWork(args: z.infer<typeof saveMyWorkSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);
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

  // Push to dev branch
  const pushResult = await git(["push", "origin", config.devBranch], repoPath);
  if (pushResult.exitCode !== 0) {
    // Try pull --rebase then push again
    await git(["pull", "--rebase", "origin", config.devBranch], repoPath);
    const retryPush = await git(["push", "origin", config.devBranch], repoPath);
    if (retryPush.exitCode !== 0) {
      throw new Error(
        `Saved locally but couldn't sync to GitHub: ${retryPush.stderr}`
      );
    }
  }

  // Get deploy gap for context (pass config to avoid re-reading)
  const gap = await getDeployGap(repoPath, config);
  const fileCount = countFiles(statusResult.stdout);
  const gapNote =
    gap.count > 1
      ? `\n${gap.count} saves waiting to deploy — say 'ship it' when ready.`
      : "";

  return `Saved! ${fileCount} file${fileCount === 1 ? "" : "s"} updated — ${message}. (Your live app wasn't affected.)${gapNote}`;
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

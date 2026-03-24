import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir, isClaudeWorktree } from "../git/branches.js";
import { classifyPushFailure } from "../git/safety.js";
import { track } from "../sync/telemetry.js";
import { syncEvent } from "../sync/cloud.js";

export const saveMyWorkSchema = {
  description:
    "Say 'save my work' to save current progress. " +
    "Your work is saved to your workspace — your live app won't change until you say 'ship it'.",
  inputSchema: z.object({
    description: z
      .string()
      .optional()
      .describe("Plain-language past-tense summary of what changed (e.g. 'Updated homepage hero text', 'Fixed typo in contact form'). If you know what the user was working on, provide this — otherwise omit it and the tool will generate one automatically."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
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

  // Generate commit message from pre-stage status, or use provided description
  const message = args.description || generateMessage(statusResult.stdout);

  // Commit
  const commitResult = await git(["commit", "-m", message], repoPath);
  if (commitResult.exitCode !== 0) {
    throw new Error(`Save failed: ${commitResult.stderr}`);
  }

  const savedMsg = `Saved on your computer! ${message}.`;

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

  const gitNote = config.showGitCommands
    ? `\n\`\`\`\ngit add -A\ngit commit -m "${message}"\ngit push origin ${config.devBranch}\n\`\`\``
    : "";
  track("save_my_work");
  const hashResult = await git(["rev-parse", "HEAD"], repoPath);
  syncEvent(repoPath, {
    type: "save",
    timestamp: new Date().toISOString(),
    commit_hash: hashResult.stdout.trim(),
    message,
    files_changed: statusResult.stdout.split("\n").filter(Boolean).length,
  });
  return `Saved! ${message}. (Your live app wasn't affected.)${gapNote}${worktreeNote}${gitNote}`;
}

function generateMessage(porcelain: string): string {
  const lines = porcelain.split("\n").filter(Boolean);
  if (lines.length === 0) return "Updated project files";

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of lines) {
    const xy = line.slice(0, 2);
    // Porcelain v1: "XY filename" or "XY old -> new" (rename). Use regex to avoid
    // off-by-one if the filename starts with a letter that looks like a status char.
    const rest = line.match(/^.{2} (.+)$/)?.[1] ?? line.slice(3);
    const file = (rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest).split("/").pop() ?? "file";
    if (xy.includes("D")) deleted.push(file);
    else if (xy === "??" || xy.includes("A")) added.push(file);
    else modified.push(file);
  }

  // Single file — be specific
  if (lines.length === 1) {
    if (added.length)    return `Added ${added[0]}`;
    if (deleted.length)  return `Deleted ${deleted[0]}`;
    if (modified.length) return `Updated ${modified[0]}`;
  }

  // Multiple files — lead with the dominant change type
  if (added.length > 0 && modified.length === 0 && deleted.length === 0) {
    return added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} files`;
  }
  if (deleted.length > 0 && added.length === 0 && modified.length === 0) {
    return deleted.length === 1 ? `Deleted ${deleted[0]}` : `Deleted ${deleted.length} files`;
  }
  if (added.length > 0 && modified.length > 0) {
    return `Added ${added[0]} and updated ${modified.length} file${modified.length === 1 ? "" : "s"}`;
  }

  return `Updated ${lines.length} files`;
}

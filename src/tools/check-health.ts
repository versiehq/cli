import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { runSetupFlow, ensureInitialized, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { checkIsRepo, checkDeployConfig, checkNoWorktrees } from "../git/safety.js";
import { listCheckpoints } from "../snapshots/manager.js";
import { readConfig, writeConfig } from "../utils/config.js";

export const checkHealthSchema = {
  description:
    "Say 'setup versie', 'check health', 'project health', 'get started', or 'check my project' to initialize or check project status. " +
    "If the user provides a GitHub SSH URL (e.g. 'set up versie with git@github.com:you/repo.git'), pass it as github_url. " +
    "For 'show git commands' or 'hide git commands', call this tool with show_git_commands set to 'on' or 'off'.",
  inputSchema: z.object({
    github_url: z
      .string()
      .optional()
      .describe("Set to any git@github.com:... URL that appears in the user's message — even if they only paste the URL or say 'set up versie with git@github.com:you/repo.git'. Always extract and pass the URL; never ignore it."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
    workspace_name: z
      .string()
      .optional()
      .describe("Optional name for the workspace branch. Defaults to 'versie-dev'. Only used during first-time setup — if the user says something like 'call my workspace dev' or 'use dev as the branch name', pass it here."),
    show_git_commands: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'on' when the user says 'show git commands', 'off' when they say 'hide git commands'. Toggles whether Versie tools append the underlying git operations to their output."),
  }),
};

export async function checkHealth(args: z.infer<typeof checkHealthSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);

  // Handle settings toggle — works regardless of setup state
  if (args.show_git_commands !== undefined) {
    const config = readConfig(repoPath);
    if (!config) return "Versie isn't set up yet — say 'versie setup' to get started.";
    writeConfig(repoPath, { ...config, showGitCommands: args.show_git_commands === "on" });
    return args.show_git_commands === "on"
      ? "Git commands on — tools will now show the underlying git operations."
      : "Git commands off — tools will show plain output again.";
  }

  const welcome = await runSetupFlow(repoPath, args.github_url, args.workspace_name);
  if (welcome) {
    // Only run deploy checks after actual completion (config written by ensureInitialized).
    // Intermediate messages (e.g. "waiting for SSH URL") return before config is written.
    const config = readConfig(repoPath);
    if (config) {
      const deployWarning = await checkDeployConfig(repoPath, config.liveBranch);
      if (deployWarning) {
        return (
          welcome +
          `\n\n⚠️ **One more thing:** ${deployWarning}\n` +
          `Say **"help with shipping setup"** and I'll walk you through fixing it.`
        );
      }
    }
    return welcome;
  }

  // 1. Verify git repo
  const repoCheck = await checkIsRepo(repoPath);
  if (!repoCheck.ok) {
    if (!args.repo_path) {
      return "Which project do you want to check? Tell me the folder path (e.g. 'check my project at /Users/me/my-app').";
    }
    return `⚠ ${repoCheck.message}`;
  }

  const config = await ensureInitialized(repoPath);
  const checks: string[] = [];

  // 2. Current branch
  const branchResult = await git(["branch", "--show-current"], repoPath);
  const branch = branchResult.stdout;
  if (branch === config.liveBranch) {
    checks.push(`⚠ You were on the live version — switched you back to your workspace`);
    await git(["checkout", config.devBranch], repoPath);
  } else if (branch === config.devBranch) {
    checks.push(`✓ Working in your workspace (${config.devBranch})`);
  } else {
    checks.push(`⚠ You're in an unexpected place ('${branch}') — switching to your workspace`);
    await git(["checkout", config.devBranch], repoPath);
  }

  // 3-8: Run all remaining checks in parallel (branch is already resolved above)
  const [statusResult, gap, remoteResult, worktreeCheck, checkpoints, deployWarning] =
    await Promise.all([
      git(["status", "--porcelain"], repoPath),
      getDeployGap(repoPath, config),
      git(["remote"], repoPath),
      checkNoWorktrees(repoPath),
      listCheckpoints(repoPath),
      checkDeployConfig(repoPath, config.liveBranch),
    ]);

  // 3. Uncommitted changes
  if (statusResult.stdout.trim()) {
    const count = statusResult.stdout.split("\n").filter(Boolean).length;
    checks.push(`ℹ ${count} unsaved change${count === 1 ? "" : "s"} — say 'save my work' to save`);
  } else {
    checks.push(`✓ All changes saved`);
  }

  // 4. Deploy gap
  if (gap.count === 0) {
    checks.push(`✓ Your live app is up to date with your latest work`);
  } else if (gap.count <= 5) {
    checks.push(`ℹ ${gap.count} save${gap.count === 1 ? "" : "s"} not yet shipped — say 'ship it' when ready`);
  } else {
    checks.push(`⚠ ${gap.count} saves not yet shipped — consider shipping soon`);
  }

  // 5. Remote connection
  if (!remoteResult.stdout.trim()) {
    checks.push(`⚠ Project isn't connected to GitHub yet`);
  } else {
    checks.push(`✓ Connected to GitHub`);
  }

  // 6. Active worktrees
  if (!worktreeCheck.ok) {
    checks.push(`⚠ Active worktree session detected — changes made there can bypass Versie's protection`);
  }

  // 7. Checkpoint count
  if (checkpoints.length > 0) {
    checks.push(`✓ ${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"} saved`);
  }

  // 8. Deploy platform config
  const deployWarningMsg = deployWarning;
  if (deployWarningMsg) {
    checks.push(`⚠ ${deployWarningMsg}`);
  }

  return checks.join("\n\n");
}

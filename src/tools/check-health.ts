import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { checkIsRepo, checkDeployConfig, checkNoWorktrees } from "../git/safety.js";
import { listCheckpoints } from "../snapshots/manager.js";
import { readConfig, writeConfig } from "../utils/config.js";

export const checkHealthSchema = {
  description:
    "Say 'setup versie', 'check health', 'project health', 'get started', or 'check my project' to initialize or check project status. " +
    "Say 'turn on/off verbose mode' to toggle detailed output. " +
    "Say 'show git commands' or 'hide git commands' to toggle showing the underlying git operations. " +
    "If the user provides a GitHub SSH URL (e.g. 'set up versie with git@github.com:you/repo.git'), pass it as github_url.",
  inputSchema: z.object({
    github_url: z
      .string()
      .optional()
      .describe("GitHub SSH URL provided by the user (e.g. git@github.com:you/repo.git). Only set when the user explicitly gives a URL to connect their project to GitHub."),
    verbose: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'on' to enable verbose output for all tools, 'off' to return to brief output. Only set when user explicitly asks to change verbose mode."),
    show_git_commands: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'on' to show underlying git commands in output, 'off' to hide them. Only set when user explicitly asks to toggle this."),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

export async function checkHealth(args: z.infer<typeof checkHealthSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath, args.github_url);
  if (welcome) {
    // If Versie was just initialized (config now exists), also check deploy platform
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

  // Verbose mode toggle
  if (args.verbose !== undefined) {
    const config = readConfig(repoPath);
    if (config) {
      writeConfig(repoPath, { ...config, verbose: args.verbose === "on" });
      return args.verbose === "on"
        ? "Verbose mode on — tools will now show detailed output."
        : "Verbose mode off — tools will now show brief output.";
    }
  }

  // Show git commands toggle
  if (args.show_git_commands !== undefined) {
    const config = readConfig(repoPath);
    if (config) {
      writeConfig(repoPath, { ...config, showGitCommands: args.show_git_commands === "on" });
      return args.show_git_commands === "on"
        ? "Git commands on — tools will now show the underlying git operations in parentheses."
        : "Git commands off — tools will show plain output again.";
    }
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

  return checks.join("\n");
}

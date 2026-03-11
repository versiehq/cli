import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureInitialized, getDeployGap } from "../git/branches.js";
import { checkIsRepo, checkDeployConfig, checkNoWorktrees } from "../git/safety.js";
import { listCheckpoints } from "../snapshots/manager.js";
import { resolveRepoPath } from "../utils/config.js";

export const checkHealthSchema = {
  description:
    "Check your project's health — branch status, unsaved changes, deploy gap, and configuration.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function checkHealth(args: z.infer<typeof checkHealthSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);

  // 1. Verify git repo
  const repoCheck = await checkIsRepo(repoPath);
  if (!repoCheck.ok) {
    return `⚠ ${repoCheck.message}`;
  }

  const config = await ensureInitialized(repoPath);
  const checks: string[] = [];

  // 2. Current branch
  const branchResult = await git(["branch", "--show-current"], repoPath);
  const branch = branchResult.stdout;
  if (branch === config.liveBranch) {
    checks.push(`⚠ You were on the live branch — switched you back to your workspace`);
    await git(["checkout", config.devBranch], repoPath);
  } else if (branch === config.devBranch) {
    checks.push(`✓ Working in your workspace (${config.devBranch})`);
  } else {
    checks.push(`⚠ You're on branch '${branch}' — switching to your workspace`);
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
    checks.push(`ℹ ${gap.count} save${gap.count === 1 ? "" : "s"} not yet deployed — say 'ship it' when ready`);
  } else {
    checks.push(`⚠ ${gap.count} saves not yet deployed — consider deploying soon`);
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

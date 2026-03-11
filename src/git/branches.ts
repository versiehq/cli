import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./executor.js";
import { readConfig, writeConfig, type VersieConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

const DEV_BRANCH = "versie-dev";

export { VersieConfig };

/**
 * Ensure Versie is initialized for this repo.
 * If not yet set up, runs first-run setup:
 *   - detects live branch (main/master)
 *   - creates versie-dev from current HEAD
 *   - pushes to remote
 *   - writes .versie/config.json
 *   - adds .versie/ to .gitignore
 * Returns the config.
 */
export async function ensureInitialized(repoPath: string): Promise<VersieConfig> {
  const existing = readConfig(repoPath);
  if (existing) return existing;

  logger.info("First run — setting up Versie for this project");

  // Detect live branch
  const liveBranch = await detectLiveBranch(repoPath);

  // Stash uncommitted changes if any, so we can create versie-dev safely
  const statusResult = await git(["status", "--porcelain"], repoPath);
  const hasUncommitted = statusResult.stdout.trim().length > 0;
  if (hasUncommitted) {
    await git(["stash", "push", "-m", "versie-init-stash"], repoPath);
    logger.info("Stashed uncommitted changes before setup");
  }

  // Create or checkout versie-dev
  const devExists = await git(["rev-parse", "--verify", DEV_BRANCH], repoPath);
  if (devExists.exitCode !== 0) {
    await git(["checkout", "-b", DEV_BRANCH], repoPath);
    // Push to remote (best effort — local-only repos are fine too)
    const pushResult = await git(["push", "-u", "origin", DEV_BRANCH], repoPath);
    if (pushResult.exitCode !== 0) {
      logger.debug("No remote or push failed — continuing with local-only setup");
    }
  } else {
    await git(["checkout", DEV_BRANCH], repoPath);
  }

  // Apply stash if we stashed earlier
  if (hasUncommitted) {
    await git(["stash", "pop"], repoPath);
  }

  // Write config
  const config: VersieConfig = { liveBranch, devBranch: DEV_BRANCH };
  writeConfig(repoPath, config);

  // Add .versie/ to .gitignore
  const gitignorePath = join(repoPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".versie")) {
      writeFileSync(gitignorePath, content + "\n.versie/\n", "utf-8");
    }
  }

  logger.info(`Versie initialized: live=${liveBranch}, dev=${DEV_BRANCH}`);
  return config;
}

/** Switch to versie-dev if not already on it. Accepts optional pre-resolved config to avoid re-reading. */
export async function ensureOnDev(repoPath: string, config?: VersieConfig): Promise<VersieConfig> {
  const resolvedConfig = config ?? await ensureInitialized(repoPath);
  const current = await git(["branch", "--show-current"], repoPath);
  if (current.stdout !== resolvedConfig.devBranch) {
    await git(["checkout", resolvedConfig.devBranch], repoPath);
  }
  return resolvedConfig;
}

export interface DeployGap {
  count: number;
  summaries: string[]; // commit messages (no hashes)
}

/** How many commits are on dev but not yet on live */
export async function getDeployGap(repoPath: string, config?: VersieConfig): Promise<DeployGap> {
  const resolvedConfig = config ?? await ensureInitialized(repoPath);
  const result = await git(
    ["log", `${resolvedConfig.liveBranch}..${resolvedConfig.devBranch}`, "--oneline"],
    repoPath
  );
  if (!result.stdout) return { count: 0, summaries: [] };
  const lines = result.stdout.split("\n").filter(Boolean);
  return {
    count: lines.length,
    summaries: lines.map((l) => l.replace(/^[a-f0-9]+ /, "")),
  };
}

/** Detect the default live branch (main or master) */
async function detectLiveBranch(repoPath: string): Promise<string> {
  // Try reading from remote HEAD
  const headRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath);
  if (headRef.exitCode === 0 && headRef.stdout) {
    const branch = headRef.stdout.replace("refs/remotes/origin/", "");
    if (branch) return branch;
  }
  // Fallback: check local branches
  const branches = await git(["branch", "--list"], repoPath);
  if (branches.stdout.includes("master") && !branches.stdout.includes(" main")) {
    return "master";
  }
  return "main";
}

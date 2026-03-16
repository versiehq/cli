import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { git } from "./executor.js";
import { readConfig, writeConfig, type VersieConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Call at the top of every tool handler (after resolveWorkingDir).
 * If Versie hasn't been set up in this repo yet, runs initialization and
 * returns a welcome message. Returns null if already initialized so the tool
 * continues its normal flow.
 */
export async function checkFirstRun(repoPath: string, githubUrl?: string): Promise<string | null> {
  // Check 1: Is this a git repo?
  const gitCheck = await git(["rev-parse", "--git-dir"], repoPath);
  if (gitCheck.exitCode !== 0) {
    const name = getProjectName(repoPath);

    if (await isGhAvailable()) {
      // Auto-setup: init, commit, create GitHub repo, push — all without user running anything
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      try {
        await execFileAsync("gh", ["repo", "create", name, "--private", "--source=.", "--push"], {
          cwd: repoPath, env: process.env, timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string; message?: string };
        const msg = ((err.stderr ?? "") + (err.stdout ?? "") + (err.message ?? "")).trim();
        return (
          `I saved a local copy of your work but couldn't create the GitHub repo automatically.\n\n` +
          `Details: ${msg}\n\n` +
          `Go to [github.com/new](https://github.com/new), create an empty private repo, copy the SSH URL, then tell me:\n` +
          `**"set up versie with git@github.com:you/your-repo.git"**`
        );
      }
      await ensureInitialized(repoPath);
      return `Versie is set up! Your work saves safely here — your live app only changes when you say "ship it".\nSay **"save my work"** to save, **"ship it"** to go live, or **"list commands"** to see all options.`;
    }

    if (githubUrl) {
      // User provided the GitHub URL — do the full local + remote setup
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      return await connectRemote(repoPath, githubUrl);
    }

    if (await isSshGithubAvailable()) {
      // SSH works — run local setup, then ask for the URL (one step instead of five)
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      return (
        `I've saved a local copy of your work. Now I just need a GitHub repo to back it up.\n\n` +
        `1. Go to [github.com/new](https://github.com/new) and create a new repository (name it anything — keep it private for now, skip the README)\n` +
        `2. Copy the **SSH URL** from the "Quick setup" box — it looks like \`git@github.com:you/your-repo.git\`\n` +
        `3. Come back and tell me: **"set up versie with git@github.com:you/your-repo.git"** (replace with your URL)`
      );
    }

    return (
      `This folder isn't set up as a project yet.\n\n` +
      `The easiest way to get started is the GitHub CLI:\n` +
      `1. Install it: \`brew install gh\` (or download from https://cli.github.com)\n` +
      `2. Sign in: \`gh auth login\` — opens your browser\n` +
      `3. Come back and say "versie setup" — I'll handle everything from there`
    );
  }

  // Check 2: Is there a remote?
  const remoteCheck = await git(["remote"], repoPath);
  if (remoteCheck.exitCode === 0 && !remoteCheck.stdout.trim()) {
    const name = getProjectName(repoPath);

    if (await isGhAvailable()) {
      try {
        await execFileAsync("gh", ["repo", "create", name, "--private", "--source=.", "--push"], {
          cwd: repoPath, env: process.env, timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string; message?: string };
        const msg = ((err.stderr ?? "") + (err.stdout ?? "") + (err.message ?? "")).trim();
        return (
          `Your project has local history but I couldn't connect it to GitHub automatically.\n\n` +
          `Details: ${msg}\n\n` +
          `Go to [github.com/new](https://github.com/new), create an empty private repo, copy the SSH URL, then tell me:\n` +
          `**"set up versie with git@github.com:you/your-repo.git"**`
        );
      }
      await ensureInitialized(repoPath);
      return `Versie is set up! Your work saves safely here — your live app only changes when you say "ship it".\nSay **"save my work"** to save, **"ship it"** to go live, or **"list commands"** to see all options.`;
    }

    if (githubUrl) {
      return await connectRemote(repoPath, githubUrl);
    }

    if (await isSshGithubAvailable()) {
      return (
        `Your project has local history but isn't connected to GitHub yet.\n\n` +
        `1. Go to [github.com/new](https://github.com/new) and create a new **empty** repository (no README or .gitignore — keep it private for now)\n` +
        `2. Copy the **SSH URL** from the "Quick setup" box\n` +
        `3. Tell me: **"set up versie with git@github.com:you/your-repo.git"** (replace with your URL)`
      );
    }

    return (
      `Your project has local history but isn't connected to GitHub.\n\n` +
      `Install the GitHub CLI to connect automatically:\n` +
      `1. Run: \`brew install gh\`\n` +
      `2. Run: \`gh auth login\`\n` +
      `3. Come back and say "versie setup"`
    );
  }

  if (readConfig(repoPath) !== null) {
    ensureCursorRules(repoPath); // backfill for projects initialized before this feature
    return null;
  }
  await ensureInitialized(repoPath);
  return (
    `Versie is set up! Your work saves safely here — your live app only changes when you say "ship it".\n` +
    `Say **"save my work"** to save, **"ship it"** to go live, or **"list commands"** to see all options.`
  );
}

/** Run git init + add -A + commit locally. Returns an error string on failure, null on success. */
async function runLocalInit(repoPath: string): Promise<string | null> {
  const initResult = await git(["init"], repoPath);
  if (initResult.exitCode !== 0) {
    return `Something went wrong starting version history: ${initResult.stderr}`;
  }
  await git(["add", "-A"], repoPath);
  const commitResult = await git(["commit", "-m", "Initial save"], repoPath);
  if (commitResult.exitCode !== 0) {
    // Nothing to commit (empty dir) — make an empty commit so the branch exists
    await git(["commit", "--allow-empty", "-m", "Initial save"], repoPath);
  }
  return null;
}

/** Connect an existing local repo to a GitHub remote and push. Returns success message or error. */
async function connectRemote(repoPath: string, githubUrl: string): Promise<string> {
  const remoteResult = await git(["remote", "add", "origin", githubUrl], repoPath);
  if (remoteResult.exitCode !== 0) {
    return `Couldn't connect to that URL — make sure you copied the SSH URL correctly from GitHub (it should start with \`git@github.com:\`).`;
  }
  const pushResult = await git(["push", "-u", "origin", "HEAD"], repoPath);
  if (pushResult.exitCode !== 0) {
    return `Couldn't push to GitHub. Make sure the repository is empty and you have access.\n\nDetails: ${pushResult.stderr}`;
  }
  await ensureInitialized(repoPath);
  return `Versie is set up! Your work saves safely here — your live app only changes when you say "ship it".\nSay **"save my work"** to save, **"ship it"** to go live, or **"list commands"** to see all options.`;
}

async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5_000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

async function isSshGithubAvailable(): Promise<boolean> {
  try {
    // ssh -T always exits non-zero for GitHub — check output for success message
    await execFileAsync(
      "ssh",
      ["-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5", "git@github.com"],
      { timeout: 8_000, env: process.env }
    );
    return true;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return ((e.stdout ?? "") + (e.stderr ?? "")).toLowerCase().includes("successfully authenticated");
  }
}

function getProjectName(repoPath: string): string {
  return repoPath.split("/").filter(Boolean).pop() ?? "my-project";
}

const DEV_BRANCH = "versie-dev";

/** Write .cursor/rules/versie.mdc so Cursor's AI auto-discovers Versie tools and knows the project path. */
function ensureCursorRules(repoPath: string): void {
  // Never write outside a real project directory
  if (!existsSync(join(repoPath, ".git"))) return;
  const cursorRulesDir = join(repoPath, ".cursor", "rules");
  const cursorRulesPath = join(cursorRulesDir, "versie.mdc");
  const content = `---
description: Versie version control tools are available in this project
globs:
alwaysApply: true
---
Use the Versie MCP tools for all save, deploy, and version control operations in this project.
Always pass repo_path="${repoPath}" when calling any Versie MCP tool. Never ask the user for the project path.
Say "save my work" to save, "ship it" to deploy, "list commands" to see all options.
`;
  // Write if missing or if the hardcoded path has changed (e.g. project moved)
  if (existsSync(cursorRulesPath) && readFileSync(cursorRulesPath, "utf-8") === content) return;
  mkdirSync(cursorRulesDir, { recursive: true });
  writeFileSync(cursorRulesPath, content, "utf-8");
}

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

  // Push live branch to remote so it exists on GitHub from the start (best effort)
  const livePush = await git(["push", "-u", "origin", liveBranch], repoPath);
  if (livePush.exitCode !== 0) {
    logger.debug("Could not push live branch to remote — continuing with local-only setup");
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

  // Add .versie/ to .gitignore (create the file if it doesn't exist yet)
  const gitignorePath = join(repoPath, ".gitignore");
  const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (!gitignoreContent.includes(".versie")) {
    writeFileSync(gitignorePath, gitignoreContent + (gitignoreContent.endsWith("\n") || gitignoreContent === "" ? "" : "\n") + ".versie/\n", "utf-8");
  }

  ensureCursorRules(repoPath);

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
  // Ensure upstream tracking is written into .git/config so `git push` (no args)
  // works from the terminal. We write it directly — pure local, no network needed.
  const trackingRemote = await git(
    ["config", `branch.${resolvedConfig.devBranch}.remote`],
    repoPath
  );
  if (trackingRemote.exitCode !== 0) {
    await git(["config", `branch.${resolvedConfig.devBranch}.remote`, "origin"], repoPath);
    await git(["config", `branch.${resolvedConfig.devBranch}.merge`, `refs/heads/${resolvedConfig.devBranch}`], repoPath);
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

/**
 * Resolve the working directory for git operations.
 * If called from inside a linked worktree (e.g. Claude Code's .claude/worktrees/),
 * returns the main worktree root instead so config and init work correctly.
 */
/** Returns true when running inside a Claude Code/Desktop conversation worktree. */
export function isClaudeWorktree(repoPath?: string): boolean {
  return (repoPath ?? process.cwd()).includes("/.claude/worktrees/");
}

export async function resolveWorkingDir(repoPath?: string): Promise<string> {
  const base = repoPath ?? process.cwd();
  const result = await git(["rev-parse", "--git-common-dir"], base);
  if (result.exitCode !== 0) return base;
  const commonDir = result.stdout.trim();
  // In a main worktree, --git-common-dir returns ".git" (relative path)
  // In a linked worktree, it returns an absolute path like /path/to/repo/.git
  if (!commonDir.startsWith("/")) return base;
  if (commonDir.endsWith("/.git")) return commonDir.slice(0, -5);
  return dirname(commonDir);
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

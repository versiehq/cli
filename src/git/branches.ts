import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { git } from "./executor.js";
import { readConfig, writeConfig, type VersieConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { track } from "../sync/telemetry.js";

const execFileAsync = promisify(execFile);

/** Completion message shown after successful setup — must stay in sync with SKILL.md step 10. */
const SETUP_COMPLETE_MESSAGE =
  `Versie is set up! Your work saves safely here — your live app only changes when you say "ship it." Save freely.\n\n` +
  `Say **"save my work"** to save, **"ship it"** to go live, or **"list commands"** to see all options.\n\n` +
  `Before your first ship: if you have your GitHub repo connected to Vercel, Netlify, or another platform, ` +
  `say **"help with shipping setup"** so only "ship it" triggers live deployments — not every save.\n\n` +
  `**Want your ship history on the dashboard?** If you haven't already, run **\`versie login\`** in your terminal or AI tool to connect this project to versie.co.\n\n` +
  `Versie collects anonymous usage data to help improve error detection. Say **"turn off telemetry"** anytime to opt out.`;

/**
 * Lightweight guard called at the top of every tool except check_health.
 * If Versie isn't set up for this project, returns a redirect message.
 * Returns null if the project is ready so the tool continues its normal flow.
 */
export async function checkFirstRun(repoPath: string): Promise<string | null> {
  if (readConfig(repoPath) !== null) return null;
  return "Versie isn't set up for this project yet. Say **'versie setup'** or **'check my project health'** to get started.";
}

/**
 * Full setup flow — called only by check_health.
 * Handles git init, GitHub connection, and Versie initialization.
 * Returns a welcome/setup/instructions message, or null if already initialized.
 */
export async function runSetupFlow(repoPath: string, githubUrl?: string, devBranchName?: string): Promise<string | null> {
  // Check 1: Does this project have its OWN git repo?
  // Using --show-toplevel so we detect both "no git at all" and "inside a parent git repo"
  // (e.g. ~/workspace/vtest when ~ is accidentally a git repo). In either case we need
  // to run git init at repoPath to isolate this project's history.
  const gitRoot = await git(["rev-parse", "--show-toplevel"], repoPath);
  const hasOwnGit = gitRoot.exitCode === 0 && gitRoot.stdout.trim() === repoPath;
  if (!hasOwnGit) {
    const name = getProjectName(repoPath);

    if (await isGhAvailable()) {
      // Auto-setup: init, commit, create GitHub repo, push — all without user running anything
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      let ghUrl = "";
      try {
        const ghResult = await execFileAsync("gh", ["repo", "create", name, "--private", "--source=.", "--push"], {
          cwd: repoPath, env: process.env, timeout: 30_000,
        });
        ghUrl = (ghResult.stdout ?? "").trim();
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
      await ensureInitialized(repoPath, devBranchName);
      track("first_run");
      const ghLine = ghUrl
        ? `✓ Created and connected your GitHub repo: ${ghUrl}\n\n`
        : `✓ Created and connected a private GitHub repo for this project.\n\n`;
      return ghLine + SETUP_COMPLETE_MESSAGE;
    }

    if (githubUrl) {
      // User provided the GitHub URL — do the full local + remote setup
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      return await connectRemote(repoPath, githubUrl, devBranchName);
    }

    if (await isSshGithubAvailable()) {
      // SSH works — run local setup, then ask for the URL (one step instead of five)
      const initErr = await runLocalInit(repoPath);
      if (initErr) return initErr;
      ensureCursorRulesSetupPending(repoPath);
      return (
        `I've saved a local copy of your work. Now I just need a GitHub repo to back it up.\n\n` +
        `1. Go to [github.com/new](https://github.com/new) and create a new repository (name it anything — keep it private for now, skip the README)\n` +
        `2. Copy the **SSH URL** from the "Quick setup" box — it looks like \`git@github.com:you/your-repo.git\`\n` +
        `3. Tell me: **"set up versie with git@github.com:you/your-repo.git"** (with your actual URL)`
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
      let ghUrl = "";
      try {
        const ghResult = await execFileAsync("gh", ["repo", "create", name, "--private", "--source=.", "--push"], {
          cwd: repoPath, env: process.env, timeout: 30_000,
        });
        ghUrl = (ghResult.stdout ?? "").trim();
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
      await ensureInitialized(repoPath, devBranchName);
      track("first_run");
      const ghLine = ghUrl
        ? `✓ Created and connected your GitHub repo: ${ghUrl}\n\n`
        : `✓ Created and connected a private GitHub repo for this project.\n\n`;
      return ghLine + SETUP_COMPLETE_MESSAGE;
    }

    if (githubUrl) {
      return await connectRemote(repoPath, githubUrl, devBranchName);
    }

    if (await isSshGithubAvailable()) {
      ensureCursorRulesSetupPending(repoPath);
      return (
        `Your project has local history but isn't connected to GitHub yet.\n\n` +
        `1. Go to [github.com/new](https://github.com/new) and create a new **empty** repository (no README or .gitignore — keep it private for now)\n` +
        `2. Copy the **SSH URL** from the "Quick setup" box\n` +
        `3. Tell me: **"set up versie with git@github.com:you/your-repo.git"** (with your actual URL)`
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
    // Sanity check: config exists but verify git root still matches. A project can end up
    // with a Versie config but git running against a parent repo (e.g. if setup ran before
    // this project had its own .git). If so, fall through and re-initialize.
    const rootCheck = await git(["rev-parse", "--show-toplevel"], repoPath);
    if (rootCheck.exitCode !== 0 || rootCheck.stdout.trim() !== repoPath) {
      logger.info("Versie config exists but git root does not match — re-initializing");
      // fall through to ensureInitialized below
    } else {
      ensureCursorRules(repoPath); // backfill for projects initialized before this feature
      return null;
    }
  }
  await ensureInitialized(repoPath, devBranchName);
  return SETUP_COMPLETE_MESSAGE;
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
async function connectRemote(repoPath: string, githubUrl: string, devBranchName?: string): Promise<string> {
  const remoteResult = await git(["remote", "add", "origin", githubUrl], repoPath);
  if (remoteResult.exitCode !== 0) {
    return `Couldn't connect to that URL — make sure you copied the SSH URL correctly from GitHub (it should start with \`git@github.com:\`).`;
  }
  const pushResult = await git(["push", "-u", "origin", "HEAD"], repoPath);
  if (pushResult.exitCode !== 0) {
    return `Couldn't push to GitHub. Make sure the repository is empty and you have access.\n\nDetails: ${pushResult.stderr}`;
  }
  await ensureInitialized(repoPath, devBranchName);
  return SETUP_COMPLETE_MESSAGE;
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

/**
 * Write a temporary .cursor/rules/versie.mdc that tells Cursor exactly what to do
 * when the user pastes a GitHub URL. Called while waiting for the URL, before
 * setup is complete. Overwritten by ensureCursorRules once setup finishes.
 */
function ensureCursorRulesSetupPending(repoPath: string): void {
  if (!existsSync(join(repoPath, ".git"))) return;
  const cursorRulesDir = join(repoPath, ".cursor", "rules");
  const cursorRulesPath = join(cursorRulesDir, "versie.mdc");
  // Don't overwrite if the final rules are already written
  if (existsSync(cursorRulesPath) && readFileSync(cursorRulesPath, "utf-8").includes("alwaysApply: true") && !readFileSync(cursorRulesPath, "utf-8").includes("setup is in progress")) return;
  const content = `---
description: Versie version control setup in progress
globs:
alwaysApply: true
---
Versie setup is in progress for this project. When the user provides or pastes a GitHub SSH URL (format: git@github.com:user/repo.git):
- Immediately call the check_health Versie MCP tool
- Pass the URL as the github_url parameter
- Pass repo_path="${repoPath}"
- Do not run any git commands yourself — Versie handles the GitHub connection
`;
  try {
    mkdirSync(cursorRulesDir, { recursive: true });
    writeFileSync(cursorRulesPath, content, "utf-8");
  } catch {
    // Non-critical — setup can continue without cursor rules
  }
}

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
`;
  // Write if missing or if the hardcoded path has changed (e.g. project moved)
  if (existsSync(cursorRulesPath) && readFileSync(cursorRulesPath, "utf-8") === content) return;
  mkdirSync(cursorRulesDir, { recursive: true });
  writeFileSync(cursorRulesPath, content, "utf-8");
}

/** Write .claude/settings.json to disable worktrees — they bypass Versie's dev/live model. */
function ensureClaudeSettings(repoPath: string): void {
  if (!existsSync(join(repoPath, ".git"))) return;
  const claudeDir = join(repoPath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  const worktreeHook = {
    hooks: [
      {
        type: "command",
        command: "echo 'Versie manages your branches — worktrees are disabled to keep your dev/live model safe.' && exit 1",
      },
    ],
  };

  // Merge into existing settings if present
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Corrupted file — overwrite
    }
  }

  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;
  // Don't overwrite if user already has a WorktreeCreate hook
  if (hooks.WorktreeCreate) return;

  hooks.WorktreeCreate = [worktreeHook];
  existing.hooks = hooks;

  const content = JSON.stringify(existing, null, 2) + "\n";
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, content, "utf-8");
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
export async function ensureInitialized(repoPath: string, devBranchName?: string): Promise<VersieConfig> {
  const existing = readConfig(repoPath);
  if (existing) return existing;

  const dev = devBranchName ?? DEV_BRANCH;
  logger.info(`First run — setting up Versie for this project (workspace: ${dev})`);

  // Detect live branch
  const liveBranch = await detectLiveBranch(repoPath);

  // Stash uncommitted changes if any, so we can create the workspace branch safely
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

  // Create or checkout workspace branch
  const devExists = await git(["rev-parse", "--verify", dev], repoPath);
  if (devExists.exitCode !== 0) {
    await git(["checkout", "-b", dev], repoPath);
    // Push to remote (best effort — local-only repos are fine too)
    const pushResult = await git(["push", "-u", "origin", dev], repoPath);
    if (pushResult.exitCode !== 0) {
      logger.debug("No remote or push failed — continuing with local-only setup");
    }
  } else {
    await git(["checkout", dev], repoPath);
  }

  // Apply stash if we stashed earlier
  if (hasUncommitted) {
    await git(["stash", "pop"], repoPath);
  }

  // Write config
  const config: VersieConfig = { liveBranch, devBranch: dev };
  writeConfig(repoPath, config);

  // Add .versie/ to .gitignore (create the file if it doesn't exist yet)
  const gitignorePath = join(repoPath, ".gitignore");
  const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (!gitignoreContent.includes(".versie")) {
    writeFileSync(gitignorePath, gitignoreContent + (gitignoreContent.endsWith("\n") || gitignoreContent === "" ? "" : "\n") + ".versie/\n", "utf-8");
  }

  ensureCursorRules(repoPath);
  ensureClaudeSettings(repoPath);

  logger.info(`Versie initialized: live=${liveBranch}, dev=${dev}`);
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
  dashboardRollbackDetected?: boolean; // true when origin/main was rolled back from the dashboard
}

/** How many commits are on dev but not yet on live */
export async function getDeployGap(repoPath: string, config?: VersieConfig): Promise<DeployGap> {
  const resolvedConfig = config ?? await ensureInitialized(repoPath);

  // Fetch the live branch from remote so dashboard rollbacks are reflected.
  // Best-effort — if the network is unavailable or there's no remote, fall back
  // to the local ref without blocking the health check.
  const fetchResult = await git(
    ["fetch", "origin", resolvedConfig.liveBranch],
    repoPath
  );
  let liveRef: string;
  let dashboardRollbackDetected = false;
  if (fetchResult.exitCode === 0) {
    liveRef = `origin/${resolvedConfig.liveBranch}`;

    // Check if local live branch has commits that origin doesn't — this means
    // origin was force-pushed back (dashboard rollback). Normal case: they match.
    const aheadCheck = await git(
      ["log", `origin/${resolvedConfig.liveBranch}..${resolvedConfig.liveBranch}`, "--oneline"],
      repoPath
    );
    if (aheadCheck.stdout.trim()) {
      dashboardRollbackDetected = true;
    }

    // Sync local live branch to match origin — a dashboard rollback force-pushes
    // origin/main to an older commit, leaving local main diverged. Updating the
    // local ref here keeps `ship it` (which does `git pull`) from failing.
    await git(
      ["update-ref", `refs/heads/${resolvedConfig.liveBranch}`, `origin/${resolvedConfig.liveBranch}`],
      repoPath
    );
  } else {
    liveRef = resolvedConfig.liveBranch;
  }

  const result = await git(
    ["log", `${liveRef}..${resolvedConfig.devBranch}`, "--oneline"],
    repoPath
  );
  if (!result.stdout) return { count: 0, summaries: [] };
  const lines = result.stdout.split("\n").filter(Boolean);
  return {
    count: lines.length,
    summaries: lines.map((l) => l.replace(/^[a-f0-9]+ /, "")),
    ...(dashboardRollbackDetected && { dashboardRollbackDetected: true }),
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
  // process.cwd() in an MCP subprocess is wherever the server was launched (often ~),
  // not the user's project. We require repo_path to always be passed by the client.
  // If missing, throw so the tool returns a clear error rather than silently using the wrong dir.
  if (!repoPath) {
    throw new Error("repo_path is required — pass the absolute path to your project folder.");
  }
  const base = repoPath;
  // Only resolve the git common directory when inside a Claude Code worktree.
  // Without this guard, a project inside a parent git repo (e.g. ~/workspace/vtest
  // when ~ is accidentally a git repo) would resolve to the parent root instead.
  if (!base.includes("/.claude/worktrees/")) return base;
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

import { git } from "./executor.js";
import { logger } from "../utils/logger.js";

export interface SafetyCheck {
  ok: boolean;
  message?: string;
}

/** Verify the path is a git repository */
export async function checkIsRepo(repoPath: string): Promise<SafetyCheck> {
  const result = await git(["rev-parse", "--is-inside-work-tree"], repoPath);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      message: "This folder isn't set up as a project yet. Run: git init",
    };
  }
  return { ok: true };
}

/** Check for uncommitted changes (returns ok=false if there are changes) */
export async function checkCleanWorkdir(repoPath: string): Promise<SafetyCheck> {
  const result = await git(["status", "--porcelain"], repoPath);
  if (result.stdout.trim()) {
    return {
      ok: false,
      message: "You have unsaved changes.",
    };
  }
  return { ok: true };
}

/** Check for active worktrees beyond the main one */
export async function checkNoWorktrees(repoPath: string): Promise<SafetyCheck> {
  const result = await git(["worktree", "list", "--porcelain"], repoPath);
  const entries = result.stdout.split("\n\n").filter((e) => e.includes("worktree "));
  if (entries.length > 1) {
    logger.debug(`Active worktrees detected: ${entries.length}`);
    return {
      ok: false,
      message:
        "You have an active worktree session open. Changes made in a worktree " +
        "can bypass Versie's protection if merged directly to your live branch. " +
        "Save and close the worktree before shipping.",
    };
  }
  return { ok: true };
}

/** Check if a remote is configured */
export async function checkHasRemote(repoPath: string): Promise<SafetyCheck> {
  const result = await git(["remote"], repoPath);
  if (!result.stdout.trim()) {
    return {
      ok: false,
      message: "Your project isn't connected to GitHub yet.",
    };
  }
  return { ok: true };
}

/** Check that the deploy platform is configured to deploy only from the live branch */
export async function checkDeployConfig(
  repoPath: string,
  liveBranch: string
): Promise<string | null> {
  // Vercel: check vercel.json for branch config
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const vercelConfig = join(repoPath, "vercel.json");
    if (existsSync(vercelConfig)) {
      const cfg = JSON.parse(readFileSync(vercelConfig, "utf-8")) as Record<string, unknown>;
      // If no "github" key or ignoreCommand missing, they're deploying from all branches
      if (!cfg.github) {
        return (
          "Your Vercel project may be set to deploy from every save, not just when you ship. " +
          `Go to Vercel → Project Settings → Git, and set the Production Branch to '${liveBranch}'.`
        );
      }
    }

    // Netlify: netlify.toml
    const netlifyConfig = join(repoPath, "netlify.toml");
    if (existsSync(netlifyConfig)) {
      const content = readFileSync(netlifyConfig, "utf-8");
      if (!content.includes(`branch = "${liveBranch}"`) && !content.includes(`branch = '${liveBranch}'`)) {
        return (
          "Your Netlify project may be set to deploy from every save, not just when you ship. " +
          `In netlify.toml, set: [context.production] / branch = "${liveBranch}"`
        );
      }
    }
  } catch {
    // Config file issues — skip, non-critical
  }

  return null; // No issue found
}

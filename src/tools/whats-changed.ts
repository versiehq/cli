import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir } from "../git/branches.js";

export const whatsChangedSchema = {
  description:
    "Say 'what's changed' or 'what's not live yet' to see changes. " +
    "Ask 'since last save' for uncommitted changes, or 'since last ship' for what's saved but not live yet.",
  inputSchema: z.object({
    since: z
      .enum(["last save", "last ship"])
      .optional()
      .describe("'last save' for uncommitted changes, 'last ship' for what's not live yet."),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

export async function whatsChanged(args: z.infer<typeof whatsChangedSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureOnDev(repoPath);

  const mode = args.since ?? "last save";

  if (mode === "last ship") {
    const gap = await getDeployGap(repoPath, config);
    const gitNote = config.showGitCommands ? `\n(git: log ${config.liveBranch}..${config.devBranch})` : "";
    if (gap.count === 0) {
      return `Everything you've saved is already live — nothing new to ship.${gitNote}`;
    }
    const lines = gap.summaries.map((s) => `  - ${s}`).join("\n");
    return (
      `Here's what you've saved since you last shipped:\n${lines}\n\n` +
      `${gap.count} save${gap.count === 1 ? "" : "s"} ready to go live. Say 'ship it' when ready.${gitNote}`
    );
  }

  // Default: uncommitted changes since last save
  const statusResult = await git(["status", "--porcelain"], repoPath);
  const gitNote = config.showGitCommands ? `\n(git: status)` : "";
  if (!statusResult.stdout.trim()) {
    return `No changes since your last save — everything is saved.${gitNote}`;
  }

  const [diffResult, stagedResult] = await Promise.all([
    git(["diff", "--stat"], repoPath),
    git(["diff", "--cached", "--stat"], repoPath),
  ]);

  // git diff --stat misses untracked files — extract them from git status --porcelain
  const untrackedFiles = statusResult.stdout
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim());

  const parts: string[] = [];
  if (stagedResult.stdout.trim()) parts.push(stagedResult.stdout.trim());
  if (diffResult.stdout.trim()) parts.push(diffResult.stdout.trim());
  if (untrackedFiles.length > 0) {
    parts.push(`New files:\n${untrackedFiles.map((f) => `  ${f}`).join("\n")}`);
  }

  const summary = parts.join("\n") || statusResult.stdout;
  return `Changes since your last save:\n${summary}\n\nSay 'save my work' to save these.${gitNote}`;
}

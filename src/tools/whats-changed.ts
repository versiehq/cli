import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureOnDev, getDeployGap, resolveWorkingDir } from "../git/branches.js";

export const whatsChangedSchema = {
  description:
    "See what's changed. Ask 'since last save' to see uncommitted changes, " +
    "or 'since last deploy' to see what you've built that isn't live yet.",
  inputSchema: z.object({
    since: z
      .enum(["last save", "last deploy"])
      .optional()
      .describe("'last save' for uncommitted changes, 'last deploy' for what's not live yet."),
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function whatsChanged(args: z.infer<typeof whatsChangedSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const config = await ensureOnDev(repoPath);

  const mode = args.since ?? "last save";

  if (mode === "last deploy") {
    const gap = await getDeployGap(repoPath, config);
    if (gap.count === 0) {
      return "Everything you've saved is already live — nothing new since your last deploy.";
    }
    const lines = gap.summaries.map((s) => `  - ${s}`).join("\n");
    return (
      `Here's what you've built since your last deploy:\n${lines}\n\n` +
      `${gap.count} save${gap.count === 1 ? "" : "s"} ready to go live. Say 'ship it' to deploy.`
    );
  }

  // Default: uncommitted changes since last save
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (!statusResult.stdout.trim()) {
    return "No changes since your last save — everything is saved.";
  }

  const [diffResult, stagedResult] = await Promise.all([
    git(["diff", "--stat"], repoPath),
    git(["diff", "--cached", "--stat"], repoPath),
  ]);

  const parts: string[] = [];
  if (stagedResult.stdout.trim()) parts.push(stagedResult.stdout.trim());
  if (diffResult.stdout.trim()) parts.push(diffResult.stdout.trim());

  const summary = parts.join("\n") || statusResult.stdout;
  return `Changes since your last save:\n${summary}\n\nSay 'save my work' to save these.`;
}

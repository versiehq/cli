import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureOnDev } from "../git/branches.js";
import { createCheckpoint, listCheckpoints } from "../snapshots/manager.js";
import { resolveRepoPath } from "../utils/config.js";

export const createCheckpointSchema = {
  description:
    "Create a named bookmark so you can always return to this exact point. " +
    "Great for marking milestones before making big changes.",
  inputSchema: z.object({
    name: z
      .string()
      .max(100)
      .describe("A name for this checkpoint. Examples: 'working-login', 'before-redesign', 'mvp'"),
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function createCheckpointTool(args: z.infer<typeof createCheckpointSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);
  await ensureOnDev(repoPath);

  // Save uncommitted changes first
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (statusResult.stdout.trim()) {
    await git(["add", "-A"], repoPath);
    await git(["commit", "-m", `Checkpoint: ${args.name}`], repoPath);
    await git(["push", "origin", "versie-dev"], repoPath);
  }

  const result = await createCheckpoint(repoPath, args.name);

  if (result.atLimit && !result.tagName) {
    // Already at limit before creating
    const existing = await listCheckpoints(repoPath);
    const names = existing.map((t) => `  - ${t.replace("versie/checkpoint/", "")}`).join("\n");
    return (
      `You've reached the 5-checkpoint limit. Your current checkpoints:\n${names}\n\n` +
      `Upgrade to Pro for unlimited checkpoints — versie.co.`
    );
  }

  const limitNote = result.atLimit
    ? "\n\nYou're now at the 5-checkpoint limit. Upgrade to Pro for unlimited checkpoints — versie.co."
    : "";

  return `Checkpoint '${args.name}' saved — you can always return to this point.${limitNote}`;
}

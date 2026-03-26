import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, resolveWorkingDir } from "../git/branches.js";
import { createCheckpoint } from "../snapshots/manager.js";
import { track } from "../sync/telemetry.js";
import { syncEvent } from "../sync/cloud.js";

export const createCheckpointSchema = {
  description:
    "Say 'create a checkpoint' to bookmark this moment so you can always return to it. " +
    "Great for marking milestones before making big changes. " +
    "A checkpoint saves to your workspace only — do NOT call ship_it after this unless the user explicitly asks to deploy.",
  inputSchema: z.object({
    name: z
      .string()
      .max(100)
      .describe("A name for this checkpoint. Examples: 'working-login', 'before-redesign', 'mvp'"),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function createCheckpointTool(args: z.infer<typeof createCheckpointSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureOnDev(repoPath);

  // Save uncommitted changes first
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (statusResult.stdout.trim()) {
    await git(["add", "-A"], repoPath);
    await git(["commit", "-m", `Checkpoint: ${args.name}`], repoPath);
    await git(["push", "origin", "versie-dev"], repoPath);
  }

  const result = await createCheckpoint(repoPath, args.name);

  const gitNote = config.showGitCommands ? `\n\`\`\`\ngit tag -a "${result.tagName}" -m "${args.name}"\ngit push origin "${result.tagName}"\n\`\`\`` : "";
  track("create_checkpoint", {}, config);
  const hashResult = await git(["rev-parse", "HEAD"], repoPath);
  syncEvent(repoPath, {
    type: "checkpoint",
    timestamp: new Date().toISOString(),
    commit_hash: hashResult.stdout.trim(),
    message: args.name,
    metadata: { tag: result.tagName },
  }, config);
  return `Checkpoint '${args.name}' saved — you can always return to this point.${gitNote}`;
}

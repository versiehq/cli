import { z } from "zod/v4";
import { getDeployGap } from "../git/branches.js";
import { resolveRepoPath, readConfig } from "../utils/config.js";

export const listCommandsSchema = {
  description:
    "Show everything Versie can do — all available commands and what they do.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function listCommands(args: z.infer<typeof listCommandsSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);
  const config = readConfig(repoPath);

  const isSetUp = config !== null;

  // If set up, show deploy gap as context
  let statusLine = "";
  if (isSetUp && config) {
    try {
      const gap = await getDeployGap(repoPath, config);
      statusLine = gap.count === 0
        ? "✓ Your live app is up to date.\n\n"
        : `ℹ ${gap.count} save${gap.count === 1 ? "" : "s"} not yet deployed.\n\n`;
    } catch {
      // ignore
    }
  }

  return (
    `${statusLine}Versie commands:\n\n` +
    `SAVING & DEPLOYING\n` +
    `  save my work        Save progress (live app unchanged)\n` +
    `  ship it             Deploy to your live app\n` +
    `  save and ship       Save + deploy in one step\n\n` +
    `HISTORY\n` +
    `  what's changed      Unsaved changes since last save\n` +
    `  what's not live yet Saved but not yet deployed\n` +
    `  show my timeline    Full save + deploy history\n\n` +
    `RESTORING\n` +
    `  go back to live        Reset workspace to what's deployed\n` +
    `  go back to [name/time] Restore a checkpoint or earlier version\n` +
    `  create a checkpoint    Bookmark this moment (5 free, unlimited Pro)\n\n` +
    `DIAGNOSTICS\n` +
    `  check my project health   Full status report\n` +
    `  fix this error: [msg]     Diagnose and fix a Git error\n` +
    `  help with my deploy       Configure Vercel/Netlify/Railway\n\n` +
    `support@versie.co`
  );
}

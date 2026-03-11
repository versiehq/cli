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
  if (isSetUp) {
    try {
      const gap = await getDeployGap(repoPath);
      if (gap.count === 0) {
        statusLine = "✓ Your live app is up to date.\n\n";
      } else {
        statusLine = `ℹ ${gap.count} save${gap.count === 1 ? "" : "s"} not yet deployed.\n\n`;
      }
    } catch {
      // ignore
    }
  }

  return (
    `${statusLine}Here's what you can ask Versie to do:\n\n` +
    `SAVING & DEPLOYING\n` +
    `  "save my work"          Save your progress (live app stays unchanged)\n` +
    `  "ship it"               Deploy your work to your live app\n` +
    `  "save and ship"         Save then immediately deploy\n\n` +
    `HISTORY & CHANGES\n` +
    `  "what's changed"        See changes since your last save\n` +
    `  "what's not live yet"   See saves that haven't been deployed\n` +
    `  "show my timeline"      Full history — your work and deploy events\n\n` +
    `RESTORING\n` +
    `  "go back to live"       Reset your workspace to match what's deployed\n` +
    `  "go back to [name]"     Restore to a named checkpoint\n` +
    `  "go back to [time]"     Restore to a point in your history\n\n` +
    `CHECKPOINTS\n` +
    `  "create a checkpoint"   Bookmark this moment (5 free, unlimited with Pro)\n\n` +
    `DIAGNOSTICS\n` +
    `  "check my project health"         Full status report\n` +
    `  "fix this error: [error text]"    Diagnose and fix a Git error\n` +
    `  "help with my deploy setup"       Set up Vercel/Netlify correctly\n\n` +
    `Need help? support@versie.co`
  );
}

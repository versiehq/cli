import { z } from "zod/v4";
import { checkFirstRun, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { readConfig } from "../utils/config.js";

export const listCommandsSchema = {
  description:
    "Say 'list commands' or 'versie help' to see all available Versie commands.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Auto-set in Claude Code; ask the user in Claude Desktop."),
  }),
};

export async function listCommands(args: z.infer<typeof listCommandsSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = readConfig(repoPath);

  const isSetUp = config !== null;

  // If set up, show deploy gap as context
  let statusLine = "";
  if (isSetUp && config) {
    try {
      const gap = await getDeployGap(repoPath, config);
      statusLine = gap.count === 0
        ? "✓ Your live app is up to date.\n\n"
        : `ℹ ${gap.count} save${gap.count === 1 ? "" : "s"} not yet shipped.\n\n`;
    } catch {
      // ignore
    }
  }

  return (
    `${statusLine}` +
    `**Saving & Shipping**\n` +
    `- \`save my work\` — Save progress (live app unchanged)\n` +
    `- \`ship it\` — Ship your work live\n` +
    `- \`save and ship\` — Save + ship in one step\n\n` +
    `**History**\n` +
    `- \`what's changed\` — Unsaved changes since last save\n` +
    `- \`what's not live yet\` — Saved but not yet shipped\n` +
    `- \`show my timeline\` — Full save + ship history\n\n` +
    `**Restoring**\n` +
    `- \`go back to live\` — Reset workspace to what's live\n` +
    `- \`go back to [name/time]\` — Restore a checkpoint or earlier version\n` +
    `- \`create a checkpoint\` — Bookmark this moment (5 free, unlimited Pro)\n\n` +
    `**Diagnostics**\n` +
    `- \`check my project health\` — Full status report\n` +
    `- \`fix this error: [message]\` — Diagnose and fix a Git error\n` +
    `- \`help with my deploy\` — Configure Vercel/Netlify/Railway to only go live when you ship\n\n` +
    `support@versie.co`
  );
}

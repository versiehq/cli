import { z } from "zod/v4";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig, writeConfig } from "../utils/config.js";

export const configureSettingsSchema = {
  description:
    "Fallback for toggling Versie settings. Prefer check_health with show_git_commands param instead. " +
    "Only use this if check_health was already called in this conversation.",
  inputSchema: z.object({
    show_git_commands: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'on' to show underlying git commands in output, 'off' to hide them."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function configureSettings(args: z.infer<typeof configureSettingsSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;

  const config = readConfig(repoPath);
  if (!config) return "Versie isn't set up yet. Say 'versie setup' to get started.";

  if (args.show_git_commands !== undefined) {
    writeConfig(repoPath, { ...config, showGitCommands: args.show_git_commands === "on" });
    return args.show_git_commands === "on"
      ? "Git commands on — tools will now show the underlying git operations."
      : "Git commands off — tools will show plain output again.";
  }

  return `Show git commands: ${config.showGitCommands ? "on" : "off"}`;
}

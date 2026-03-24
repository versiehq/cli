import { z } from "zod/v4";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig, writeConfig } from "../utils/config.js";

export const configureSettingsSchema = {
  description:
    "Fallback for toggling Versie settings, or for connecting Versie to the dashboard with an API key. " +
    "Use when the user says 'connect versie to my dashboard', 'my versie key is...', 'disconnect from dashboard', " +
    "'turn off telemetry', or 'opt out of telemetry'. " +
    "For 'show/hide git commands', prefer check_health with show_git_commands param instead.",
  inputSchema: z.object({
    show_git_commands: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'on' to show underlying git commands in output, 'off' to hide them."),
    api_key: z
      .string()
      .max(200)
      .optional()
      .describe("Versie Pro API key from versie.co/settings. Set to 'disconnect' to remove the key and disable cloud sync."),
    telemetry: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'off' to opt out of anonymous telemetry, 'on' to opt back in."),
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

  if (args.api_key !== undefined) {
    if (args.api_key === "disconnect") {
      const { apiKey: _removed, ...rest } = config;
      writeConfig(repoPath, rest);
      return "Disconnected from the Versie dashboard. Your saves and ships will continue working — they just won't sync to the dashboard.";
    }
    writeConfig(repoPath, { ...config, apiKey: args.api_key });
    return "Connected! Your saves, ships, and checkpoints will now sync to the Versie dashboard.";
  }

  if (args.telemetry !== undefined) {
    writeConfig(repoPath, { ...config, telemetry: args.telemetry === "on" });
    return args.telemetry === "on"
      ? "Telemetry on — anonymous usage data will be collected to help improve Versie."
      : "Telemetry off — no usage data will be collected from this project.";
  }

  if (args.show_git_commands !== undefined) {
    writeConfig(repoPath, { ...config, showGitCommands: args.show_git_commands === "on" });
    return args.show_git_commands === "on"
      ? "Git commands on — tools will now show the underlying git operations."
      : "Git commands off — tools will show plain output again.";
  }

  return (
    `Show git commands: ${config.showGitCommands ? "on" : "off"}\n` +
    `Telemetry: ${config.telemetry === false ? "off" : "on"}\n` +
    `Dashboard: ${config.apiKey ? "connected" : "not connected"}`
  );
}

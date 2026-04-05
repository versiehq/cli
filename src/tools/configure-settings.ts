import { z } from "zod/v4";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig, writeConfig } from "../utils/config.js";
import { loginWithDeviceFlow, isAuthenticated } from "../auth/device-flow.js";

export const configureSettingsSchema = {
  description:
    "Manages Versie settings and dashboard connection. " +
    "Use when the user says 'versie login', 'connect to dashboard', 'connect versie to my dashboard', 'disconnect from dashboard', " +
    "'turn off telemetry', 'opt out of telemetry', or 'my versie key is...' (legacy API key, still supported). " +
    "For 'show/hide git commands', prefer check_health with show_git_commands param instead.",
  inputSchema: z.object({
    login: z
      .boolean()
      .optional()
      .describe("Set to true when the user says 'versie login' or 'connect to dashboard'. Starts the Device Flow browser auth."),
    disconnect: z
      .boolean()
      .optional()
      .describe("Set to true when the user says 'disconnect from dashboard'. Removes auth token and API key."),
    api_key: z
      .string()
      .max(200)
      .optional()
      .describe("Legacy: Versie Pro API key from versie.co/settings. Still supported but Device Flow (login: true) is preferred."),
    telemetry: z
      .enum(["on", "off"])
      .optional()
      .describe("Set to 'off' to opt out of anonymous telemetry, 'on' to opt back in."),
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

  // Device Flow login — opens browser, polls until approved
  if (args.login) {
    return await loginWithDeviceFlow(repoPath);
  }

  // Disconnect — remove both device flow token and legacy API key
  if (args.disconnect) {
    const { apiKey: _removed, ...rest } = config;
    writeConfig(repoPath, rest);
    // Remove auth.json if it exists
    try {
      const { unlinkSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const authPath = join(repoPath, ".versie", "auth.json");
      if (existsSync(authPath)) unlinkSync(authPath);
    } catch { /* best-effort */ }
    return "Disconnected from the Versie dashboard. Your saves and ships will continue working — they just won't sync to the dashboard.";
  }

  // Legacy API key
  if (args.api_key !== undefined) {
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

  // Status summary
  const connected = isAuthenticated(repoPath);
  return (
    `Dashboard: ${connected ? "connected" : "not connected"}${!connected ? " — say 'versie login' to connect" : ""}\n` +
    `Show git commands: ${config.showGitCommands ? "on" : "off"}\n` +
    `Telemetry: ${config.telemetry === false ? "off" : "on"}`
  );
}

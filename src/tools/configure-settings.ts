import { z } from "zod/v4";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig, writeConfig } from "../utils/config.js";
import { startDeviceFlow, pollDeviceFlow, isAuthenticated } from "../auth/device-flow.js";

export const configureSettingsSchema = {
  description:
    "Manages Versie settings and dashboard connection. " +
    "Use when the user says 'versie login', 'connect to dashboard', 'connect versie to my dashboard', 'disconnect from dashboard', " +
    "'turn off telemetry', 'opt out of telemetry', or 'my versie key is...' (legacy API key, still supported). " +
    "For 'show/hide git commands', prefer check_health with show_git_commands param instead. " +
    "IMPORTANT: 'versie login' is NOT a shell command — never run it in bash. Always call this tool with login: true instead. " +
    "Login is a two-step flow: first call with login:true shows the user their code and opens the browser. " +
    "After the user says 'done' or 'approved', call again with poll_login:true to complete the connection.",
  inputSchema: z.object({
    login: z
      .boolean()
      .optional()
      .describe("Set to true when the user says 'versie login' or 'connect to dashboard'. Phase 1: opens browser and shows the user their code. After user approves, call again with poll_login:true."),
    poll_login: z
      .boolean()
      .optional()
      .describe("Set to true after the user says they've approved the login in their browser. Phase 2: checks if the login was approved and completes the connection."),
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

  // Device Flow — phase 1: open browser and show code
  if (args.login) {
    return await startDeviceFlow(repoPath);
  }

  // Device Flow — phase 2: poll for approval after user clicks Approve
  if (args.poll_login) {
    return await pollDeviceFlow(repoPath);
  }

  // Disconnect — remove global token, per-project token, and legacy API key
  if (args.disconnect) {
    const { apiKey: _removed, ...rest } = config;
    writeConfig(repoPath, rest);
    try {
      const { unlinkSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      // Global auth (preferred location)
      const configBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
      const globalPath = join(configBase, "versie", "auth.json");
      if (existsSync(globalPath)) unlinkSync(globalPath);
      // Per-project auth (legacy location)
      const projectPath = join(repoPath, ".versie", "auth.json");
      if (existsSync(projectPath)) unlinkSync(projectPath);
    } catch { /* best-effort */ }
    return "Disconnected from the Versie dashboard across all projects — this removes the shared login, not just this project. Your saves and ships will continue working, they just won't sync to the dashboard. Say 'versie login' to reconnect.";
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

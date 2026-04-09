import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { homedir } from "os";

/** Validate that a resolved path stays within the user's home directory. Falls back to home if not. */
function safeEnvPath(envValue: string | undefined, fallback: string): string {
  if (!envValue) return fallback;
  const resolved = resolve(envValue);
  const home = resolve(homedir());
  if (resolved.startsWith(home + sep) || resolved === home) return resolved;
  return fallback;
}

type InstallResult = "installed" | "already_installed" | "not_found" | "error";

interface ToolConfig {
  name: string;
  configPath: string;
  detectionPath: string;
}

/**
 * Build the MCP server entry to write into each config.
 *
 * GUI apps (Claude Desktop, Cursor, Windsurf) launch subprocesses with a
 * minimal system PATH that excludes version-manager paths (nvm, fnm, asdf,
 * Volta, etc.). Writing "npx" would silently fail for those users.
 *
 * Instead we resolve npx from the same directory as the node binary that is
 * running the installer right now — so whatever version manager the user has
 * active, the correct absolute path gets written.
 */
function buildVersieEntry(): { command: string; args: string[] } {
  const npxPath = join(dirname(process.execPath), "npx");
  // Fall back to bare "npx" only if the sibling binary doesn't exist
  // (e.g. unusual global install layouts).
  const command = existsSync(npxPath) ? npxPath : "npx";
  return { command, args: ["-y", "versie-cli"] };
}

function getToolConfigs(): ToolConfig[] {
  const home = homedir();
  const platform = process.platform;

  const configs: ToolConfig[] = [];

  // Claude Desktop
  if (platform === "darwin") {
    const dir = join(home, "Library", "Application Support", "Claude");
    configs.push({
      name: "Claude Desktop",
      configPath: join(dir, "claude_desktop_config.json"),
      detectionPath: dir,
    });
  } else if (platform === "win32") {
    const appdata = safeEnvPath(process.env["APPDATA"], join(home, "AppData", "Roaming"));
    const dir = join(appdata, "Claude");
    configs.push({
      name: "Claude Desktop",
      configPath: join(dir, "claude_desktop_config.json"),
      detectionPath: dir,
    });
  } else {
    const dir = join(home, ".config", "Claude");
    configs.push({
      name: "Claude Desktop",
      configPath: join(dir, "claude_desktop_config.json"),
      detectionPath: dir,
    });
  }

  // Cursor (all platforms)
  const cursorDir = join(home, ".cursor");
  configs.push({
    name: "Cursor",
    configPath: join(cursorDir, "mcp.json"),
    detectionPath: cursorDir,
  });

  // Windsurf
  if (platform === "win32") {
    const userprofile = safeEnvPath(process.env["USERPROFILE"], home);
    const windsurfDir = join(userprofile, ".codeium", "windsurf");
    configs.push({
      name: "Windsurf",
      configPath: join(windsurfDir, "mcp_config.json"),
      detectionPath: windsurfDir,
    });
  } else {
    const windsurfDir = join(home, ".codeium", "windsurf");
    configs.push({
      name: "Windsurf",
      configPath: join(windsurfDir, "mcp_config.json"),
      detectionPath: windsurfDir,
    });
  }

  // Claude Code (all platforms)
  const claudeDir = join(home, ".claude");
  configs.push({
    name: "Claude Code",
    configPath: join(home, ".claude.json"),
    detectionPath: claudeDir,
  });

  return configs;
}

function installIntoConfig(tool: ToolConfig): InstallResult {
  const { configPath, detectionPath } = tool;

  if (!existsSync(configPath) && !existsSync(detectionPath)) {
    return "not_found";
  }

  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "error";
    }
  }

  const mcpServers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
  if (mcpServers["versie"] !== undefined) {
    return "already_installed";
  }

  mcpServers["versie"] = buildVersieEntry();
  config["mcpServers"] = mcpServers;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
    return "error";
  }

  return "installed";
}

function installGlobalCursorRules(): void {
  const home = homedir();
  const cursorRulesDir = join(home, ".cursor", "rules");
  const cursorRulesPath = join(cursorRulesDir, "versie.mdc");
  const content = `---
description: Versie is available for version control via CLI and MCP
globs:
alwaysApply: true
---
Versie handles version control. Use bash commands for all mechanical operations — run them from the project directory.

CLI commands:
- \`versie save ["message"]\` — save current work
- \`versie ship ["release notes"]\` — ship live
- \`versie checkpoint ["name"]\` — create a named checkpoint
- \`versie status\` — see what's changed
- \`versie go-back <target>\` — return to a checkpoint by name
- \`versie setup [github-url]\` — first-time project setup
- \`versie login\` — connect to the Versie dashboard
- \`versie fix "error text"\` — diagnose and fix a git error

MCP tools (use when user pastes something in chat):
- fix_this_error — preferred when the user shares an error message in chat
- check_health — when the user asks for a health check or shares a GitHub SSH URL

Never ask the user for the project path — determine it from the open file or workspace context.
`;
  if (existsSync(cursorRulesPath) && readFileSync(cursorRulesPath, "utf-8") === content) return;
  mkdirSync(cursorRulesDir, { recursive: true });
  writeFileSync(cursorRulesPath, content, "utf-8");
}

export function runInstaller(): void {
  const tools = getToolConfigs();
  const installed: string[] = [];
  const alreadyInstalled: string[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  for (const tool of tools) {
    const result = installIntoConfig(tool);
    if (result === "installed") installed.push(tool.name);
    else if (result === "already_installed") alreadyInstalled.push(tool.name);
    else if (result === "not_found") notFound.push(tool.name);
    else errors.push(tool.name);
  }

  // Write global Cursor rules so Cursor's AI knows to use Versie tools
  // and auto-detect the workspace path without asking the user
  const cursorDetected = installed.includes("Cursor") || alreadyInstalled.includes("Cursor");
  if (cursorDetected) installGlobalCursorRules();

  const anyFound = installed.length > 0 || alreadyInstalled.length > 0 || errors.length > 0;

  if (!anyFound) {
    console.log("No supported AI tools found.\n");
    const entry = buildVersieEntry();
    console.log(
      `Add Versie manually by putting this in your tool's MCP config:\n  "versie": { "command": "${entry.command}", "args": ["-y", "versie-cli"] }\n`
    );
    console.log(
      "Supported tools: Claude Desktop, Cursor, Windsurf, Claude Code\nNeed help? support@versie.co"
    );
    return;
  }

  console.log("Versie installer\n");

  if (installed.length > 0) {
    console.log("Installed:");
    for (const name of installed) {
      console.log(`  ✓ ${name}`);
    }
    console.log("");
  }

  if (alreadyInstalled.length > 0) {
    console.log("Already installed:");
    for (const name of alreadyInstalled) {
      console.log(`  ✓ ${name}`);
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log("Could not update (check the file manually):");
    for (const name of errors) {
      console.log(`  ✗ ${name}`);
    }
    console.log("");
  }

  if (notFound.length > 0) {
    console.log(`Not found:\n  ${notFound.join(", ")}\n`);
  }

  if (installed.length > 0) {
    console.log(
      'Restart your AI tools and you\'re good to go!\nOpen a project and say "set up versie" to get started.'
    );
  } else if (alreadyInstalled.length > 0 && installed.length === 0) {
    console.log('Versie is already set up. Open a project and say "set up versie" to get started.');
  }
}

function removeFromConfig(tool: ToolConfig): "removed" | "not_installed" | "error" {
  if (!existsSync(tool.configPath)) return "not_installed";

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(tool.configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return "error";
  }

  const mcpServers = config["mcpServers"] as Record<string, unknown> | undefined;
  if (!mcpServers?.["versie"]) return "not_installed";

  delete mcpServers["versie"];
  if (Object.keys(mcpServers).length === 0) {
    delete config["mcpServers"];
  } else {
    config["mcpServers"] = mcpServers;
  }

  try {
    writeFileSync(tool.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return "removed";
  } catch {
    return "error";
  }
}

export function runUninstaller(): void {
  const tools = getToolConfigs();
  const removed: string[] = [];
  const errors: string[] = [];

  for (const tool of tools) {
    const result = removeFromConfig(tool);
    if (result === "removed") removed.push(tool.name);
    else if (result === "error") errors.push(tool.name);
  }

  // Remove Cursor rules
  const cursorRulesPath = join(homedir(), ".cursor", "rules", "versie.mdc");
  try {
    if (existsSync(cursorRulesPath)) unlinkSync(cursorRulesPath);
  } catch { /* best effort */ }

  // Remove auth token
  const configBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const authPath = join(configBase, "versie", "auth.json");
  let removedAuth = false;
  try {
    if (existsSync(authPath)) {
      unlinkSync(authPath);
      removedAuth = true;
    }
  } catch { /* best effort */ }

  console.log("Versie uninstaller\n");

  if (removed.length > 0) {
    console.log("Removed from:");
    for (const name of removed) console.log(`  ✓ ${name}`);
    console.log("");
  }

  if (errors.length > 0) {
    console.log("Could not update config (check these files manually):");
    for (const name of errors) console.log(`  ✗ ${name}`);
    console.log("");
  }

  if (removedAuth) console.log("✓ Signed out\n");

  if (removed.length === 0 && errors.length === 0 && !removedAuth) {
    console.log("Nothing to remove — Versie wasn't installed in any detected AI tool.\n");
  }

  console.log("To finish, run:\n  npm uninstall -g versie-cli");
  if (removed.length > 0) {
    console.log("\nRestart your AI tools to complete removal.");
  }
}

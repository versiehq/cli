import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface VersieConfig {
  liveBranch: string;
  devBranch: string;
  releases?: string[];       // versie-created release tags e.g. ["v1", "v2", "v3"]
  showGitCommands?: boolean; // default false — append underlying git commands to output
  telemetry?: boolean;       // default true — set to false to opt out of anonymous telemetry
  apiKey?: string;           // Versie Pro API key — written by configure_settings, enables cloud sync
  apiUrl?: string;           // Versie API URL — defaults to https://versie.co/api if apiKey is set
}

const CONFIG_DIR = ".versie";
const CONFIG_FILE = "config.json";

export function readConfig(repoPath: string): VersieConfig | null {
  const configPath = join(repoPath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as VersieConfig;
  } catch {
    return null;
  }
}

export function writeConfig(repoPath: string, config: VersieConfig): void {
  const configDir = join(repoPath, CONFIG_DIR);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf-8");
}

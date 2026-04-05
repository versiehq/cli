/**
 * Device Flow authentication for Versie cloud sync.
 *
 * Token is stored globally at ~/.config/versie/auth.json (XDG_CONFIG_HOME
 * aware) so the user only needs to log in once across all projects.
 *
 * Falls back to per-project .versie/auth.json (legacy), then to apiKey
 * in config.json for backward compatibility.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { readConfig } from "../utils/config.js";

const DEVICE_AUTH_URL = "https://versie.co/api/device-auth";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes

interface AuthFile {
  token: string;
  created_at: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  status: "pending" | "approved" | "expired";
  access_token?: string;
}

/** Resolved path to the global auth file (~/.config/versie/auth.json). */
function globalAuthPath(): string {
  const configBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configBase, "versie", "auth.json");
}

/** Per-project auth path — legacy location. */
function projectAuthPath(repoPath: string): string {
  return join(repoPath, ".versie", "auth.json");
}

/** Start the Device Flow login. Opens the browser and polls until approved or timed out. */
export async function loginWithDeviceFlow(repoPath: string): Promise<string> {
  // 1. Request a device code
  let codeData: DeviceCodeResponse;
  try {
    const res = await fetch(DEVICE_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request_code" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    codeData = await res.json() as DeviceCodeResponse;
  } catch {
    return "Couldn't reach versie.co. Check your internet connection and try again.";
  }

  const { device_code, user_code, verification_url } = codeData;
  const urlWithCode = `${verification_url}?code=${user_code}`;

  // 2. Attempt to open the browser automatically
  try {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execFile(opener, [urlWithCode]);
  } catch {
    // Silent — user can open manually
  }

  // 3. Poll until approved or expired
  let token: string | null = null;
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);

    let result: PollResponse;
    try {
      const res = await fetch(DEVICE_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "poll", device_code }),
      });
      result = await res.json() as PollResponse;
    } catch {
      continue; // Network blip — keep trying
    }

    if (result.status === "approved" && result.access_token) {
      token = result.access_token;
      break;
    }
    if (result.status === "expired") break;
  }

  if (!token) {
    return "Connection timed out. Say 'versie login' to try again.";
  }

  // 4. Write token to global config dir
  writeAuthToken(token);
  return "Connected! Your projects will now sync to the dashboard after each save and ship.";
}

/**
 * Read the auth token.
 * Priority: global (~/.config/versie/auth.json) → per-project (.versie/auth.json) → legacy apiKey
 */
export function readAuthToken(repoPath: string): string | null {
  // Global (preferred)
  const globalPath = globalAuthPath();
  if (existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(globalPath, "utf-8")) as AuthFile;
      if (parsed.token) return parsed.token;
    } catch { /* fall through */ }
  }

  // Per-project (legacy device flow location)
  const projectPath = projectAuthPath(repoPath);
  if (existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(readFileSync(projectPath, "utf-8")) as AuthFile;
      if (parsed.token) return parsed.token;
    } catch { /* fall through */ }
  }

  // Legacy API key in config.json
  const config = readConfig(repoPath);
  return config?.apiKey ?? null;
}

/** Returns true if the user has a valid auth token (device flow or legacy API key). */
export function isAuthenticated(repoPath: string): boolean {
  return readAuthToken(repoPath) !== null;
}

function writeAuthToken(token: string): void {
  const authPath = globalAuthPath();
  const dir = join(authPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content: AuthFile = { token, created_at: new Date().toISOString() };
  writeFileSync(authPath, JSON.stringify(content, null, 2), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

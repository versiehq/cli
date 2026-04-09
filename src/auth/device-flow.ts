/**
 * Device Flow authentication for Versie cloud sync.
 *
 * Token is stored globally at ~/.config/versie/auth.json (XDG_CONFIG_HOME
 * aware) so the user only needs to log in once across all projects.
 *
 * Falls back to per-project .versie/auth.json (legacy), then to apiKey
 * in config.json for backward compatibility.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { readConfig } from "../utils/config.js";

const DEVICE_AUTH_URL = "https://www.versie.co/api/device-auth";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 6; // 30 seconds

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

/**
 * Phase 1 — request a code, open the browser, return immediately.
 * The user_code is shown in Claude so the user can confirm it matches the browser.
 * Saves the device_code to a pending file so phase 2 can poll without extra input.
 */
export async function startDeviceFlow(_repoPath: string): Promise<string> {
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
  const devicePageBase = new URL("/auth/device", verification_url).toString();
  const urlWithCode = `${devicePageBase}?code=${user_code}`;

  // Save device_code so pollDeviceFlow can pick it up
  writePendingDeviceCode(device_code);

  // Open the browser
  try {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execFile(opener, [urlWithCode]);
  } catch {
    // Silent — user can open manually
  }

  return (
    `I've opened your browser to ${devicePageBase}\n\n` +
    `Confirm the code matches in the browser, then click Approve.\n\n` +
    `Your login code: **${user_code}**`
  );
}

/**
 * Phase 2 — poll for approval after the user has approved in the browser.
 * Reads the pending device_code saved by startDeviceFlow.
 */
export async function pollDeviceFlow(_repoPath: string): Promise<string> {
  const device_code = readPendingDeviceCode();
  if (!device_code) {
    return "No login in progress. Say **\"versie login\"** to start a new one.";
  }

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    if (i > 0) await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(DEVICE_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "poll", device_code }),
      });
      const result = await res.json() as PollResponse;
      if (result.status === "approved" && result.access_token) {
        clearPendingDeviceCode();
        writeAuthToken(result.access_token);
        return (
          `Connected! Your coding tool is now linked to your Versie dashboard.\n\n` +
          `Your saves and ships will sync automatically. Say **"save my work"** to see your first project on the dashboard.`
        );
      }
      if (result.status === "expired") {
        clearPendingDeviceCode();
        return `The code expired before it was approved. Say **"versie login"** to get a fresh one.`;
      }
      // Still pending — keep polling
    } catch {
      // Network blip — keep trying
    }
  }

  return (
    `Still waiting for approval. Make sure you clicked Approve in the browser, then say **"done"** again.`
  );
}

// ── Pending device code storage ────────────────────────────────────────────────

interface PendingDeviceAuth {
  device_code: string;
  created_at: string;
}

function pendingDeviceAuthPath(): string {
  const configBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configBase, "versie", "pending-device-auth.json");
}

function writePendingDeviceCode(device_code: string): void {
  const authPath = pendingDeviceAuthPath();
  const dir = join(authPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(authPath, JSON.stringify({ device_code, created_at: new Date().toISOString() }, null, 2), "utf-8");
}

function readPendingDeviceCode(): string | null {
  const authPath = pendingDeviceAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as PendingDeviceAuth;
    // Discard if older than 10 minutes (edge function expiry)
    if (Date.now() - new Date(parsed.created_at).getTime() > 10 * 60 * 1000) {
      clearPendingDeviceCode();
      return null;
    }
    return parsed.device_code ?? null;
  } catch {
    return null;
  }
}

function clearPendingDeviceCode(): void {
  try {
    unlinkSync(pendingDeviceAuthPath());
  } catch { /* already gone */ }
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

/**
 * Heartbeat sync — sends anonymous save/ship signals for free MCP users.
 *
 * No auth required. Only sends repo_hash (not the URL itself) so no
 * identifiable information leaves the machine without an account.
 * Fire-and-forget — never blocks or throws.
 */

import { createHash } from "node:crypto";
import { git } from "../git/executor.js";

const HEARTBEAT_URL = "https://versie.co/api/heartbeat";
const TIMEOUT_MS = 3_000;

export type HeartbeatEventType = "save" | "ship";

/**
 * Send a heartbeat for the given repo and event type.
 * No-ops silently if the repo has no remote URL.
 */
export async function sendHeartbeat(repoPath: string, eventType: HeartbeatEventType): Promise<void> {
  try {
    const remoteResult = await git(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = remoteResult.stdout.trim();
    if (!remoteUrl) return;

    const repoHash = createHash("sha256").update(remoteUrl).digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      await fetch(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_hash: repoHash,
          event_type: eventType,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Best-effort — heartbeat failures are always silent
  }
}

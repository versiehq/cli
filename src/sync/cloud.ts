/**
 * Cloud sync — sends events to Supabase via the sync-event Edge Function.
 * Activated only when VERSIE_API_URL and VERSIE_API_KEY are set.
 * Best-effort: all errors are swallowed — sync never blocks or breaks tool operations.
 */

import { createHash } from "node:crypto";
import { git } from "../git/executor.js";

const API_URL = process.env.VERSIE_API_URL;
const API_KEY = process.env.VERSIE_API_KEY;
const TIMEOUT_MS = 5_000;

export type CloudEventType = "save" | "deploy" | "rollback" | "checkpoint" | "error" | "health_check";

export interface CloudEvent {
  type: CloudEventType;
  timestamp: string;         // ISO 8601
  commit_hash?: string;
  message?: string;
  files_changed?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Send a single event to the cloud sync endpoint.
 * Resolves the repo's remote URL to derive repo_hash and repo_name.
 * No-ops silently if API_URL/API_KEY are not configured.
 */
export async function syncEvent(repoPath: string, event: CloudEvent): Promise<void> {
  if (!API_URL || !API_KEY) return;

  try {
    // Resolve remote URL for project identity
    const remoteResult = await git(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = remoteResult.stdout.trim();
    if (!remoteUrl) return;

    const repoHash = createHash("sha256").update(remoteUrl).digest("hex");
    const repoName = deriveRepoName(remoteUrl);

    const body = JSON.stringify({ repo_hash: repoHash, repo_name: repoName, remote_url: remoteUrl, event });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      await fetch(`${API_URL}/functions/v1/sync-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Never surface sync errors to the user
  }
}

/** Extract a human-readable repo name from a git remote URL. */
function deriveRepoName(remoteUrl: string): string {
  // Handles: git@github.com:org/repo.git, https://github.com/org/repo.git, https://github.com/org/repo
  const match = remoteUrl.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : remoteUrl;
}

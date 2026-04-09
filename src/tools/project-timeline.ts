import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";
import { fetchDeployStatuses } from "../sync/cloud.js";

export const projectTimelineSchema = {
  description:
    "Say 'show my timeline', 'project history', or 'what have I done' to see your project history — saves, checkpoints, and everything shipped live. " +
    "Do NOT use this tool for settings changes.",
  inputSchema: z.object({
    period: z
      .string()
      .optional()
      .describe("How far back to show. Examples: 'today', 'this week', 'last 7 days'. Defaults to last 10 events."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max number of entries to return. Defaults to 10. Increase to show more history."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

interface Entry {
  ts: number;
  display: string;
  tagName?: string;
}

export async function projectTimeline(args: z.infer<typeof projectTimelineSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);

  const limit = args.limit ?? 10;
  const releaseTagNames = config.releases ?? [];

  // Fetch origin/main so dashboard rollbacks are reflected in the live marker.
  // Best-effort — if offline, the live marker falls back to local main.
  await git(["fetch", "origin", config.liveBranch], repoPath);

  // Fetch all streams + tags pointing at workspace/live HEAD in parallel
  const [workLog, checkpointTags, workspaceTagsResult, liveTagsResult, ...releaseResults] = await Promise.all([
    git(["log", config.devBranch, "--format=%s|%ar|%ct", "--invert-grep", "--grep=^Auto-snapshot", "--grep=^Merge branch 'versie-dev'", "--grep=^Rolled back to", `-${limit * 3}`], repoPath),
    git(["tag", "-l", "checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath),
    git(["tag", "--points-at", config.devBranch], repoPath),
    // Tags pointing at the current live commit (origin/main, fallback to local main)
    git(["tag", "--points-at", `origin/${config.liveBranch}`], repoPath),
    // Fetch timestamps for each Versie release tag individually
    ...releaseTagNames.map((tag) =>
      git(["tag", "-l", tag, "--format=%(refname:short)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath)
    ),
  ]);

  // Tags pointing at current workspace HEAD (non-empty only when at a restore point)
  const workspaceTags = new Set(workspaceTagsResult.stdout.split("\n").filter(Boolean));
  // Tags pointing at the current live commit (what's actually deployed)
  const liveTags = new Set(liveTagsResult.stdout.split("\n").filter(Boolean));

  const entries: Entry[] = [];

  for (const line of workLog.stdout.split("\n").filter(Boolean)) {
    const [message, relDate, ts] = line.split("|");
    entries.push({ ts: Number(ts), display: `○ ${relDate} — Saved: ${message}` });
  }

  for (const result of releaseResults) {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [tag, relDate, ts] = line.split("|");
      entries.push({ ts: Number(ts), display: `● ${relDate} — Shipped live: ${tag}`, tagName: tag });
    }
  }

  for (const line of checkpointTags.stdout.split("\n").filter(Boolean)) {
    const [tag, name, relDate, ts] = line.split("|");
    const label = name || tag?.replace("checkpoint/", "") || "";
    entries.push({ ts: Number(ts), display: `★ ${relDate} — Checkpoint: ${label}`, tagName: tag });
  }

  if (entries.length === 0) {
    return "No history yet — save your work to start tracking your progress.";
  }

  entries.sort((a, b) => b.ts - a.ts);

  const shown = entries.slice(0, limit);
  const hasMore = entries.length > limit;

  // Fetch deploy statuses for ship entries (Pro users only, best-effort)
  const shipTags = shown
    .filter((e) => e.tagName && /^v\d+$/.test(e.tagName))
    .map((e) => e.tagName!);
  const deployStatuses = shipTags.length > 0
    ? await fetchDeployStatuses(repoPath, shipTags, config)
    : null;

  // Mark each entry with ◀ live and/or ◀ workspace as appropriate.
  // Only mark the first matching entry for each — avoids duplicate markers when
  // a checkpoint and release tag happen to point to the same commit.
  let workspaceMarked = false;
  let liveMarked = false;
  const entryLines = shown.map((e) => {
    if (!e.tagName) return e.display;
    const isWorkspace = !workspaceMarked && workspaceTags.has(e.tagName);
    const isLive = !liveMarked && liveTags.has(e.tagName);
    if (isWorkspace) workspaceMarked = true;
    if (isLive) liveMarked = true;

    let line = e.display;
    if (isWorkspace && isLive) line += "  ◀ live  workspace";
    else if (isLive) line += "  ◀ live";
    else if (isWorkspace) line += "  ◀ workspace";

    // Append deploy status summary for Pro users
    const statuses = deployStatuses?.[e.tagName];
    if (statuses?.length) {
      const parts = statuses.map((s) => {
        const name = s.label && s.label !== s.platform ? s.label : platformLabel(s.platform);
        if (s.status === "success") return `✓ ${name}`;
        if (s.status === "failure" || s.status === "error") return `✗ ${name}`;
        return `~ ${name}`;
      });
      line += `  [${parts.join(" · ")}]`;
    }

    return line;
  }).join("\n\n");

  const footer = hasMore
    ? `\nShowing your last ${limit} events. Say 'show more' for earlier history.`
    : "";

  return `YOUR TIMELINE\n─────────────\n○ saved (workspace)  ★ checkpoint (workspace)  ● shipped live\n\n${entryLines}${footer}`;
}

const PLATFORM_LABELS: Record<string, string> = {
  vercel: "Vercel",
  netlify: "Netlify",
  railway: "Railway",
  render: "Render",
  supabase: "Supabase",
  github_actions: "CI",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

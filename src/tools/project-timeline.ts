import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";

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

  // Fetch all streams + tags pointing at workspace HEAD in parallel
  const [workLog, checkpointTags, workspaceTagsResult, ...releaseResults] = await Promise.all([
    git(["log", config.devBranch, "--format=%s|%ar|%ct", "--invert-grep", "--grep=^Auto-snapshot", "--grep=^Merge branch 'versie-dev'", "--grep=^Rolled back to", `-${limit * 3}`], repoPath),
    git(["tag", "-l", "checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath),
    git(["tag", "--points-at", config.devBranch], repoPath),
    // Fetch timestamps for each Versie release tag individually
    ...releaseTagNames.map((tag) =>
      git(["tag", "-l", tag, "--format=%(refname:short)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath)
    ),
  ]);

  // Tags pointing at current workspace HEAD (non-empty only when at a restore point)
  const workspaceTags = new Set(workspaceTagsResult.stdout.split("\n").filter(Boolean));

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

  // Only mark the first (most recent) matching entry — if a checkpoint and a release tag
  // happen to point to the same commit, we don't want both showing ◀ workspace.
  let workspaceMarked = false;
  const entryLines = shown.map((e) => {
    if (!workspaceMarked && e.tagName && workspaceTags.has(e.tagName)) {
      workspaceMarked = true;
      return `${e.display}  ◀ workspace`;
    }
    return e.display;
  }).join("\n\n");

  const footer = hasMore
    ? `\nShowing your last ${limit} events. Say 'show more' for earlier history.`
    : "";

  return `YOUR TIMELINE\n─────────────\n\n${entryLines}\n\n○ saved (workspace)  ★ checkpoint (workspace)  ● shipped live${footer}`;
}

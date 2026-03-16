import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";

export const projectTimelineSchema = {
  description:
    "Say 'show my timeline' to see your project history — saves, checkpoints, and everything shipped live.",
  inputSchema: z.object({
    period: z
      .string()
      .optional()
      .describe("How far back to show. Examples: 'today', 'this week', 'last 7 days'. Defaults to last 20 events."),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

interface Entry {
  ts: number;
  display: string;
}

export async function projectTimeline(args: z.infer<typeof projectTimelineSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);

  const releaseTagNames = config.releases ?? [];

  // Fetch all three streams in parallel, including unix timestamps for sorting
  const [workLog, checkpointTags, ...releaseResults] = await Promise.all([
    git(["log", config.devBranch, "--format=%s|%ar|%ct", "-30"], repoPath),
    git(["tag", "-l", "checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath),
    // Fetch timestamps for each Versie release tag individually
    ...releaseTagNames.map((tag) =>
      git(["tag", "-l", tag, "--format=%(refname:short)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath)
    ),
  ]);

  const entries: Entry[] = [];

  for (const line of workLog.stdout.split("\n").filter(Boolean)) {
    const [message, relDate, ts] = line.split("|");
    entries.push({ ts: Number(ts), display: `○ Saved — ${relDate}: ${message}` });
  }

  for (const result of releaseResults) {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [tag, relDate, ts] = line.split("|");
      entries.push({ ts: Number(ts), display: `● ${relDate} — Shipped live (${tag})` });
    }
  }

  for (const line of checkpointTags.stdout.split("\n").filter(Boolean)) {
    const [tag, name, relDate, ts] = line.split("|");
    const label = name || tag?.replace("checkpoint/", "") || "";
    entries.push({ ts: Number(ts), display: `★ ${relDate} — Checkpoint: ${label}` });
  }

  if (entries.length === 0) {
    return "No history yet — save your work to start tracking your progress.";
  }

  entries.sort((a, b) => b.ts - a.ts);

  const lines = ["YOUR TIMELINE", "─────────────", ""];
  for (const entry of entries.slice(0, 25)) {
    lines.push(entry.display);
  }
  lines.push("", "○ saved to work  ★ checkpoint (work)  ● shipped live");

  return lines.join("\n");
}

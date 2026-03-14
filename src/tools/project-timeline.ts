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
      .describe("Absolute path to the project. Auto-set in Claude Code; ask the user in Claude Desktop."),
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

  // Fetch all three streams in parallel, including unix timestamps for sorting
  const [workLog, releaseTags, checkpointTags] = await Promise.all([
    git(["log", config.devBranch, "--format=%s|%ar|%ct", "-30"], repoPath),
    git(["tag", "-l", "versie/release/*", "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath),
    git(["tag", "-l", "versie/checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)|%(creatordate:format:%s)"], repoPath),
  ]);

  const entries: Entry[] = [];

  for (const line of workLog.stdout.split("\n").filter(Boolean)) {
    const [message, relDate, ts] = line.split("|");
    entries.push({ ts: Number(ts), display: `○ ${relDate} — ${message}` });
  }

  for (const line of releaseTags.stdout.split("\n").filter(Boolean)) {
    const [tag, relDate, ts] = line.split("|");
    const version = tag?.replace("versie/release/", "") ?? "";
    entries.push({ ts: Number(ts), display: `● ${relDate} — Shipped live (${version})` });
  }

  for (const line of checkpointTags.stdout.split("\n").filter(Boolean)) {
    const [tag, name, relDate, ts] = line.split("|");
    const label = name || tag?.replace("versie/checkpoint/", "") || "";
    entries.push({ ts: Number(ts), display: `★ ${relDate} — Checkpoint: ${label}` });
  }

  if (entries.length === 0) {
    return "No history yet — save your work to start tracking your progress.";
  }

  entries.sort((a, b) => b.ts - a.ts);

  const lines = ["YOUR TIMELINE", "─────────────"];
  for (const entry of entries.slice(0, 25)) {
    lines.push(entry.display);
  }

  return lines.join("\n");
}

import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { ensureInitialized, resolveWorkingDir } from "../git/branches.js";

export const projectTimelineSchema = {
  description:
    "Show your project history — both your work saves and what's been deployed live.",
  inputSchema: z.object({
    period: z
      .string()
      .optional()
      .describe("How far back to show. Examples: 'today', 'this week', 'last 7 days'. Defaults to last 20 events."),
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

interface TimelineEntry {
  hash: string;
  message: string;
  date: string;
  type: "work" | "deploy" | "checkpoint";
  tag?: string;
}

export async function projectTimeline(args: z.infer<typeof projectTimelineSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const config = await ensureInitialized(repoPath);

  // Fetch work history, release tags, and checkpoints in parallel
  const [workLog, releaseTags, checkpointTags] = await Promise.all([
    git(["log", config.devBranch, "--format=%H|%s|%ar", "-30"], repoPath),
    git(["tag", "-l", "versie/release/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)"], repoPath),
    git(["tag", "-l", "versie/checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(subject)|%(creatordate:relative)"], repoPath),
  ]);

  const workEntries: TimelineEntry[] = workLog.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date] = line.split("|");
      return { hash, message: message ?? "", date: date ?? "", type: "work" as const };
    });

  const deployEntries: TimelineEntry[] = releaseTags.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, , date] = line.split("|");
      const version = tag?.replace("versie/release/", "") ?? "";
      return { hash: tag ?? "", message: `Deployed to live (${version})`, date: date ?? "", type: "deploy" as const, tag };
    });

  const checkpointEntries: TimelineEntry[] = checkpointTags.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, name, date] = line.split("|");
      return {
        hash: tag ?? "",
        message: `★ Checkpoint: ${name ?? tag?.replace("versie/checkpoint/", "") ?? ""}`,
        date: date ?? "",
        type: "checkpoint" as const,
        tag,
      };
    });

  if (workEntries.length === 0 && deployEntries.length === 0) {
    return "No history yet — save your work to start tracking your progress.";
  }

  // Format dual-track display
  const lines: string[] = [
    "YOUR WORK                                    LIVE",
    "─────────────────────────────────────────────────",
  ];

  // Show work and deploys interleaved by recency
  // For text output, show work entries with deploy markers
  let deployIndex = 0;

  for (const entry of workEntries.slice(0, 20)) {
    // Show any deploys more recent than this work entry (rough ordering)
    if (deployIndex < deployEntries.length) {
      lines.push(`                                             ● ${deployEntries[deployIndex].date} — ${deployEntries[deployIndex].message}`);
      deployIndex++;
    }

    const prefix = entry.type === "checkpoint" ? "★" : "○";
    lines.push(`${prefix} ${entry.date} — ${entry.message}`);
  }

  // Any remaining deploys
  while (deployIndex < deployEntries.length) {
    lines.push(`                                             ● ${deployEntries[deployIndex].date} — ${deployEntries[deployIndex].message}`);
    deployIndex++;
  }

  // Show checkpoints separately if any
  if (checkpointEntries.length > 0) {
    lines.push("\nCHECKPOINTS");
    lines.push("───────────");
    for (const cp of checkpointEntries) {
      lines.push(`  ${cp.message} (${cp.date})`);
    }
  }

  return lines.join("\n");
}

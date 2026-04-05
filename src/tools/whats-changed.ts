import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir } from "../git/branches.js";

export const whatsChangedSchema = {
  description:
    "Shows what has changed. Use for: 'show changes', 'what's changed', 'what's not live yet', 'what have I done'. " +
    "IMPORTANT: omit 'since' unless the user specifically asks about one timeframe — omitting it shows BOTH unsaved changes AND unshipped saves, which is almost always what they want. " +
    "Only set since='last save' if they explicitly say 'since my last save' or 'unsaved changes'. " +
    "Only set since='last ship' if they explicitly say 'since I last shipped' or 'what's not live yet'.",
  inputSchema: z.object({
    since: z
      .enum(["last save", "last ship"])
      .optional()
      .describe("Omit to show both sections. 'last save' = uncommitted changes only. 'last ship' = unshipped saves only."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function whatsChanged(args: z.infer<typeof whatsChangedSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureOnDev(repoPath);

  const mode = args.since;

  // Helper: build the "since last save" section
  async function unsavedSection(): Promise<string> {
    const statusResult = await git(["status", "--porcelain"], repoPath);
    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit status\n\`\`\`` : "";
    if (!statusResult.stdout.trim()) {
      return `**Since your last save:** Everything is saved — no new changes.${gitNote}`;
    }
    // Parse porcelain output into plain-language categories (no raw git diff jargon)
    const updated: string[] = [], added: string[] = [], removed: string[] = [];
    for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2).trim();
      const file = line.slice(3).trim().split(" -> ").pop()!;
      if (xy === "??" || xy === "A" || xy === "AM") added.push(file);
      else if (xy === "D" || xy === "AD") removed.push(file);
      else updated.push(file);
    }
    const parts: string[] = [];
    if (updated.length > 0) parts.push(`Updated: ${updated.join(", ")}`);
    if (added.length > 0) parts.push(`New files: ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`Removed: ${removed.join(", ")}`);
    const total = updated.length + added.length + removed.length;
    return (
      `**Since your last save:** ${total} file${total === 1 ? "" : "s"} changed:\n\n` +
      `${parts.join("\n\n")}\n\nSay 'save my work' to save these.${gitNote}`
    );
  }

  // Helper: build the "not yet live" section
  async function notLiveSection(): Promise<string> {
    const gap = await getDeployGap(repoPath, config);
    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit log ${config.liveBranch}..${config.devBranch} --oneline\n\`\`\`` : "";
    if (gap.count === 0) {
      return `**Not yet live:** Everything you've saved is already live.${gitNote}`;
    }
    const lines = gap.summaries.map((s) => `  - ${s}`).join("\n\n");
    return (
      `**Not yet live** (${gap.count} save${gap.count === 1 ? "" : "s"}):\n\n${lines}\n\n` +
      `Say 'ship it' when ready.${gitNote}`
    );
  }

  if (mode === "last save") {
    // Strip the bold header when showing a single mode
    const section = await unsavedSection();
    return section.replace(/^\*\*Since your last save:\*\* /, "").replace(/^\*\*Since your last save:\*\*\n/, "");
  }

  if (mode === "last ship") {
    const section = await notLiveSection();
    return section.replace(/^\*\*Not yet live:\*\* /, "").replace(/^\*\*Not yet live\*\*/, "Not yet live");
  }

  // Default (no mode specified): show both
  const [unsaved, notLive] = await Promise.all([unsavedSection(), notLiveSection()]);
  return `${unsaved}\n\n${notLive}`;
}

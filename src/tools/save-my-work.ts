import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureOnDev, getDeployGap, resolveWorkingDir, isClaudeWorktree } from "../git/branches.js";
import { classifyPushFailure } from "../git/safety.js";
import { track } from "../sync/telemetry.js";
import { syncEvent } from "../sync/cloud.js";
import { sendHeartbeat } from "../sync/heartbeat.js";

export const saveMyWorkSchema = {
  description:
    "Say 'save my work' to save current progress. " +
    "Your work is saved to your workspace — your live app won't change until you say 'ship it'.",
  inputSchema: z.object({
    description: z
      .string()
      .optional()
      .describe("ALWAYS provide this. Describe the code change itself — what was built, fixed, or changed — not the act of saving. One sentence, past tense. Think: what would a developer write as a git commit message? Good: 'Added dark mode to profile menu', 'Fixed mobile nav overflow on small screens', 'Switched timeline font to serif'. Bad: 'Saved current progress', 'Updated project files', 'Made some changes', 'Updated 2 files', 'No new changes', 'No changes since last save'. The message must describe what changed, not how many files or that a save occurred."),
    body: z
      .string()
      .optional()
      .describe("For changes spanning multiple areas that a developer would want to reference later, add structured bullet points grouped by area using '- item' format. Omit for simple single-focus changes. Example: '- Added CSS token system for colors and spacing\\n- Updated nav and timeline to use new tokens\\n- Fixed contrast on error badges in dark mode'"),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function saveMyWork(args: z.infer<typeof saveMyWorkSchema.inputSchema>): Promise<string> {
  const inWorktree = isClaudeWorktree(args.repo_path);
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureOnDev(repoPath);

  // Check for changes
  const statusResult = await git(["status", "--porcelain"], repoPath);
  if (!statusResult.stdout.trim()) {
    return "Everything is already saved — no new changes since your last save.";
  }

  // Stage all changes
  await git(["add", "-A"], repoPath);

  // Resolve the best available description, with two server-side guards:
  // 1. Reject "no changes" descriptions (LLM confusion) and generic auto-generated-style
  //    messages ("Updated 2 files") — fall back to auto-generate from git status.
  // 2. If body was provided but description is missing/rejected, promote the first body
  //    line as the title (LLM sometimes puts the real description in body only).
  const rawDesc = isWeakDescription(args.description) ? undefined : args.description;
  const description = rawDesc ?? extractTitleFromBody(args.body);
  const message = description || generateMessage(statusResult.stdout);
  const commitMessage = args.body ? `${message}\n\n${args.body}` : message;

  // Commit
  const commitResult = await git(["commit", "-m", commitMessage], repoPath);
  if (commitResult.exitCode !== 0) {
    throw new Error(`Save failed: ${commitResult.stderr}`);
  }

  const savedMsg = `Saved on your computer! ${message}.`;

  // Push to dev branch, setting upstream tracking so plain `git push` works in terminal
  const pushResult = await git(["push", "-u", "origin", config.devBranch], repoPath);
  if (pushResult.exitCode !== 0) {
    const failureMsg = await classifyPushFailure(repoPath, pushResult.stderr);
    if (failureMsg !== null) {
      return `${savedMsg}\n\n${failureMsg}`;
    }

    // Likely diverged history — try pull --rebase then retry
    await git(["pull", "--rebase", "origin", config.devBranch], repoPath);
    const retryPush = await git(["push", "-u", "origin", config.devBranch], repoPath);
    if (retryPush.exitCode !== 0) {
      throw new Error(
        `Saved locally but couldn't sync to GitHub: ${retryPush.stderr}`
      );
    }
  }

  // Get deploy gap for context (pass config to avoid re-reading)
  const gap = await getDeployGap(repoPath, config);
  const gapNote =
    gap.count > 1
      ? `\n${gap.count} saves ready to ship — say 'ship it' when ready.`
      : "";

  const worktreeNote = inWorktree
    ? "\n\n(You're working through Claude's session — saves always go to your workspace, not your live app. Say 'ship it' when you're ready to go live.)"
    : "";

  const gitNote = config.showGitCommands
    ? `\n\`\`\`\ngit add -A\ngit commit -m "${message}"\ngit push origin ${config.devBranch}\n\`\`\``
    : "";
  track("save_my_work", {}, config);
  const hashResult = await git(["rev-parse", "HEAD"], repoPath);
  const diffResult = await git(["diff-tree", "--no-commit-id", "-r", "--name-status", "HEAD"], repoPath);
  const files = parseDiffTree(diffResult.stdout);
  syncEvent(repoPath, {
    type: "save",
    timestamp: new Date().toISOString(),
    commit_hash: hashResult.stdout.trim(),
    message,
    files_changed: files.length || statusResult.stdout.split("\n").filter(Boolean).length,
    metadata: {
      ...(args.body ? { body: args.body } : {}),
      ...(files.length ? { files } : {}),
    },
  }, config);
  sendHeartbeat(repoPath, "save");
  return `Saved! ${message}. (Your live app wasn't affected.)${gapNote}${worktreeNote}${gitNote}`;
}

type FileEntry = { status: string; path: string };

// Detect weak descriptions the LLM should not be using as commit titles.
// Two categories:
//   1. "No changes" language — LLM confused about whether changes exist
//   2. Auto-generated-style — LLM echoed what generateMessage() would produce
const WEAK_DESC_PATTERNS = [
  // No-changes language
  /no new changes/i,
  /no changes/i,
  /nothing changed/i,
  /nothing to save/i,
  /already saved/i,
  /nothing new/i,
  /no updates/i,
  // Generic auto-generated-style messages
  /^updated? \d+ files?\.?$/i,
  /^added \d+ files?\.?$/i,
  /^deleted \d+ files?\.?$/i,
  /^updated? project files?\.?$/i,
  /^saved( (current )?progress)?\.?$/i,
  /^made (some )?changes?\.?$/i,
];

function isWeakDescription(desc: string | undefined): boolean {
  if (!desc) return false;
  return WEAK_DESC_PATTERNS.some(p => p.test(desc.trim()));
}

// If the LLM put the real description in body but omitted title, promote the first
// body line (stripping leading "- " bullet marker) as the commit title.
function extractTitleFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const first = body.split("\n").find(l => l.trim());
  if (!first) return undefined;
  const title = first.replace(/^-\s*/, "").trim();
  return title.length > 0 ? title : undefined;
}

function parseDiffTree(output: string): FileEntry[] {
  return output.split("\n").filter(Boolean).map(line => {
    const parts = line.split("\t");
    const status = parts[0].charAt(0); // M, A, D, R, C — take first char (R090 → R)
    const path = parts[parts.length - 1]; // last segment = new path (handles renames)
    return { status, path };
  });
}

function generateMessage(porcelain: string): string {
  const lines = porcelain.split("\n").filter(Boolean);
  if (lines.length === 0) return "Updated project files";

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of lines) {
    const xy = line.slice(0, 2);
    // Porcelain v1: "XY filename" or "XY old -> new" (rename). Use regex to avoid
    // off-by-one if the filename starts with a letter that looks like a status char.
    const rest = line.match(/^.{2} (.+)$/)?.[1] ?? line.slice(3);
    const file = (rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest).split("/").pop() ?? "file";
    if (xy.includes("D")) deleted.push(file);
    else if (xy === "??" || xy.includes("A")) added.push(file);
    else modified.push(file);
  }

  // Single file — be specific
  if (lines.length === 1) {
    if (added.length)    return `Added ${added[0]}`;
    if (deleted.length)  return `Deleted ${deleted[0]}`;
    if (modified.length) return `Updated ${modified[0]}`;
  }

  // Multiple files — lead with the dominant change type
  if (added.length > 0 && modified.length === 0 && deleted.length === 0) {
    return added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} files`;
  }
  if (deleted.length > 0 && added.length === 0 && modified.length === 0) {
    return deleted.length === 1 ? `Deleted ${deleted[0]}` : `Deleted ${deleted.length} files`;
  }
  if (added.length > 0 && modified.length > 0) {
    return `Added ${added[0]} and updated ${modified.length} file${modified.length === 1 ? "" : "s"}`;
  }

  return `Updated ${lines.length} files`;
}

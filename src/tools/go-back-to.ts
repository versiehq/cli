import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, resolveWorkingDir } from "../git/branches.js";
import { createAutoSnapshot, findCheckpoint, findRelease } from "../snapshots/manager.js";
import { track } from "../sync/telemetry.js";

export const goBackToSchema = {
  description:
    "Say 'go back to [checkpoint name or time]' to restore an earlier version. " +
    "Say 'go back to live' to reset to what's currently live. " +
    "Say 'go back to my last snapshot' to undo a previous restore.",
  inputSchema: z.object({
    destination: z
      .string()
      .max(500)
      .optional()
      .describe(
        "REQUIRED. Where to go back to. Examples: 'live version', 'v1', 'yesterday', 'before I added payments', 'mvp-ready', 'last snapshot', 'hello world live'"
      ),
    target: z.string().max(500).optional().describe("Alias for destination."),
    version: z.string().max(500).optional().describe("Alias for destination."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

const LIVE_PATTERNS =
  /\b(live|deployed|production|what.s live|current site|last deploy|last release)\b/i;

const DISCARD_PATTERNS =
  /\b(undo|discard|throw away|reset|revert|get rid of).*(changes|edits|modifications|work)\b|\bstart fresh\b/i;

const SNAPSHOT_PATTERNS =
  /\b(last snapshot|undo.*(restore|rollback)|recover.*(backup|backed up|snapshot)|my backup)\b/i;

export async function goBackTo(args: z.infer<typeof goBackToSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);
  const target = args.destination ?? args.target ?? args.version;
  if (!target) return "Please tell me what to go back to — for example: 'live version', 'v1', or a checkpoint name.";

  // Case 0: Discard unsaved changes only — no snapshot needed, purely a working tree reset.
  if (DISCARD_PATTERNS.test(target)) {
    const statusResult = await git(["status", "--porcelain"], repoPath);
    if (!statusResult.stdout.trim()) {
      return "Nothing to discard — your workspace is already clean.";
    }
    await git(["reset", "--hard", "HEAD"], repoPath);
    await git(["clean", "-fd"], repoPath);
    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard HEAD\ngit clean -fd\n\`\`\`` : "";
    return `Done — your unsaved edits have been discarded. Your saves are untouched.${gitNote}`;
  }

  // Case 0.5: Recover the most recent auto-snapshot — no new snapshot needed.
  if (SNAPSHOT_PATTERNS.test(target)) {
    const tagResult = await git(["tag", "-l", "snapshot/*", "--sort=-creatordate"], repoPath);
    const latestSnapshot = tagResult.stdout.split("\n").filter(Boolean)[0];
    if (!latestSnapshot) {
      return "No snapshots found — nothing to recover.";
    }
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", latestSnapshot], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);
    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard ${latestSnapshot}\ngit push --force-with-lease origin ${config.devBranch}\n\`\`\`` : "";
    track("go_back_to", { target: "snapshot" }, config);
    return `Restored to your backed-up work. Your live app wasn't affected — only your workspace was updated.${gitNote}`;
  }

  // Check for uncommitted changes before snapshotting — used to decide backup message.
  const preRestoreStatus = await git(["status", "--porcelain"], repoPath);
  const hadUncommittedChanges = preRestoreStatus.stdout.trim().length > 0;
  const backupNote = hadUncommittedChanges
    ? "\nYour previous work was backed up automatically — say 'go back to my last snapshot' to undo this."
    : "\nSay 'go back to my last snapshot' to undo this.";

  // Always snapshot current state before a destructive restore.
  // If snapshot fails, abort — better to do nothing than lose work with no recovery point.
  try {
    await createAutoSnapshot(repoPath);
  } catch (err) {
    throw new Error(
      `Couldn't create a safety snapshot before restoring — your work hasn't been changed. ` +
      `Check that your project folder is accessible and try again. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  // Case 2 first: named checkpoint takes priority over live-pattern matching.
  // A checkpoint named "hello world live" contains "live" but should restore
  // the checkpoint, not reset to the live branch.
  const checkpoint = await findCheckpoint(repoPath, target);
  if (checkpoint) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", checkpoint], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const name = checkpoint.replace("checkpoint/", "");
    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard ${checkpoint}\ngit push --force-with-lease origin ${config.devBranch}\n\`\`\`` : "";
    track("go_back_to", { target: "checkpoint" }, config);
    return (
      `Restored to checkpoint '${name}'.\n` +
      `Your live app wasn't affected — only your workspace was updated.` +
      `${backupNote}${gitNote}`
    );
  }

  // Case 1: Restore versie-dev to match the live branch
  if (LIVE_PATTERNS.test(target)) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", config.liveBranch], repoPath);
    const pushResult = await git(
      ["push", "--force-with-lease", "origin", config.devBranch],
      repoPath
    );
    if (pushResult.exitCode !== 0) {
      // Local-only repo or push failed — still report success locally
    }

    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard ${config.liveBranch}\ngit push --force-with-lease origin ${config.devBranch}\n\`\`\`` : "";
    track("go_back_to", { target: "live" }, config);
    return (
      `Restored to the live version. Your workspace now matches what's live.` +
      `${backupNote}${gitNote}`
    );
  }

  // Case 3: Try to find a named release tag (e.g. "v2", "2", "last release")
  const releaseTag = await findRelease(repoPath, target);
  if (releaseTag) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", releaseTag], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard ${releaseTag}\ngit push --force-with-lease origin ${config.devBranch}\n\`\`\`` : "";
    track("go_back_to", { target: "release" }, config);
    return (
      `Restored to ${releaseTag} — your workspace now matches that shipped version.\n` +
      `Your live app wasn't affected — only your workspace was updated.` +
      `${backupNote}${gitNote}`
    );
  }

  // Case 4: Search commit history for matching message or date
  const logResult = await git(
    [
      "log",
      config.devBranch,
      "--oneline",
      "--format=%H|%s|%ar",
      "-50",
    ],
    repoPath
  );

  const entries = logResult.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, relDate] = line.split("|");
      return { hash, message, relDate };
    });

  const lower = target.toLowerCase();
  const match = entries.find(
    (e) =>
      e.message?.toLowerCase().includes(lower) ||
      e.relDate?.toLowerCase().includes(lower)
  );

  if (match) {
    await git(["checkout", config.devBranch], repoPath);
    await git(["reset", "--hard", match.hash], repoPath);
    await git(["push", "--force-with-lease", "origin", config.devBranch], repoPath);

    const gitNote = config.showGitCommands ? `\n\`\`\`\ngit reset --hard ${match.hash}\ngit push --force-with-lease origin ${config.devBranch}\n\`\`\`` : "";
    track("go_back_to", { target: "commit" }, config);
    return (
      `Restored to '${match.message}' (${match.relDate}).\n` +
      `Your live app wasn't affected — only your workspace was updated.` +
      `${backupNote}${gitNote}`
    );
  }

  // Nothing found
  return (
    `I couldn't find '${target}' in your project history.\n\n` +
    `Try:\n` +
    `  - 'live version' — go back to what's currently live\n` +
    `  - 'last snapshot' — undo a previous restore\n` +
    `  - A checkpoint name (say 'show my timeline' to see checkpoints)\n` +
    `  - A description like 'before I changed the header'`
  );
}

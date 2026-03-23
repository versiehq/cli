import { z } from "zod/v4";
import { git } from "../git/executor.js";
import { checkFirstRun, ensureInitialized, getDeployGap, resolveWorkingDir } from "../git/branches.js";
import { checkNoWorktrees, classifyPushFailure, checkDeployConfig } from "../git/safety.js";
import { createReleaseTag } from "../snapshots/manager.js";

export const shipItSchema = {
  description:
    "Say 'ship it' to push saved work live. Ships only what was explicitly saved — does NOT auto-save unsaved edits. " +
    "Call this tool directly when the user says 'ship it' — do NOT call save_my_work first.",
  inputSchema: z.object({
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function shipIt(args: z.infer<typeof shipItSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = await ensureInitialized(repoPath);

  // Safety: warn about active worktrees
  const worktreeCheck = await checkNoWorktrees(repoPath);
  if (!worktreeCheck.ok) {
    return `⚠ ${worktreeCheck.message}`;
  }

  // Step 1: Note unsaved changes but do NOT auto-save.
  // 'ship it' only ships what was explicitly saved. Unsaved changes stay in the workspace.
  const statusResult = await git(["status", "--porcelain"], repoPath);
  const hasUnsaved = statusResult.stdout.trim().length > 0;

  // Step 2: Get deploy gap (pass config to avoid re-reading)
  const gap = await getDeployGap(repoPath, config);
  if (gap.count === 0) {
    // Check if versie-dev is BEHIND main — this means the user went back to a checkpoint
    // and now wants to ship that older state live (rollback ship).
    const behindResult = await git(
      ["log", `${config.devBranch}..${config.liveBranch}`, "--oneline"],
      repoPath
    );
    const behindLines = behindResult.stdout.split("\n").filter(Boolean);

    if (behindLines.length === 0) {
      // Check if we're sitting on a checkpoint — the user may have just done
      // "go back to X" and then "ship it", but the checkpoint content already
      // matches what's live (e.g. they shipped without changes after creating it).
      const tagsAtHeadResult = await git(["tag", "--points-at", config.devBranch], repoPath);
      const checkpointTag = tagsAtHeadResult.stdout.split("\n").filter(Boolean)
        .find((t) => t.startsWith("checkpoint/"));
      if (checkpointTag) {
        const name = checkpointTag.replace("checkpoint/", "");
        return `Your live app already shows the "${name}" version — there's nothing to roll back.`;
      }
      if (hasUnsaved) {
        return "Nothing saved to ship yet — say **'save my work'** first to save your changes, then say **'ship it'** again.";
      }
      return "Your live app is already up to date — nothing new to ship.";
    }

    // Rollback ship: revert the commits on main that aren't on versie-dev.
    // git revert creates a new forward commit — history preserved, no force push needed.

    // Deploy platform check applies equally to rollback ships
    const rollbackDeployWarning = await checkDeployConfig(repoPath, config.liveBranch);
    if (rollbackDeployWarning) {
      return (
        `⚠ Hold on — ${rollbackDeployWarning}\n\n` +
        `Fix this in your platform settings first, then say "ship it" again. ` +
        `Say "help with shipping setup" for step-by-step instructions.`
      );
    }

    // Resolve a human-readable label (checkpoint name → release tag → commit message)
    const tagsAtHeadResult = await git(["tag", "--points-at", config.devBranch], repoPath);
    const tagsAtHead = tagsAtHeadResult.stdout.split("\n").filter(Boolean);
    const checkpointTag = tagsAtHead.find((t) => t.startsWith("checkpoint/"));
    const releaseTagAtHead = tagsAtHead.find((t) => /^v\d+$/.test(t));
    let rollbackLabel: string;
    if (checkpointTag) {
      rollbackLabel = checkpointTag.replace("checkpoint/", "");
    } else if (releaseTagAtHead) {
      rollbackLabel = releaseTagAtHead;
    } else {
      const headMsgResult = await git(["log", "-1", "--format=%s", config.devBranch], repoPath);
      rollbackLabel = headMsgResult.stdout.trim() || config.devBranch;
    }

    // Switch to live branch and pull latest
    await git(["checkout", config.liveBranch], repoPath);
    const rbPullResult = await git(["pull"], repoPath);
    if (rbPullResult.exitCode !== 0) {
      await git(["pull", "--allow-unrelated-histories"], repoPath);
    }

    // Revert each commit on main that isn't on versie-dev (newest first, squashed into one commit).
    // Merge commits need -m 1 to select the mainline parent.
    const hashes = behindLines.map((line) => line.split(" ")[0]);
    for (const hash of hashes) {
      const parentsResult = await git(["rev-list", "--parents", "-n", "1", hash], repoPath);
      const isMerge = parentsResult.stdout.trim().split(" ").length > 2;
      const revertResult = await git(
        isMerge
          ? ["revert", "--no-commit", "-m", "1", hash]
          : ["revert", "--no-commit", hash],
        repoPath
      );
      if (revertResult.exitCode !== 0) {
        await git(["reset", "--hard", "HEAD"], repoPath);
        await git(["checkout", config.devBranch], repoPath);
        return (
          `The rollback ran into a conflict and was cancelled — your live app wasn't changed.\n\n` +
          `Try "go back to live" to reset your workspace, make your changes, then say 'ship it' again.`
        );
      }
    }

    // Guard: all reverts may be no-ops if content is already identical
    const rbStatusResult = await git(["status", "--porcelain"], repoPath);
    if (!rbStatusResult.stdout.trim()) {
      await git(["checkout", config.devBranch], repoPath);
      return checkpointTag
        ? `Your live app already shows the "${rollbackLabel}" version — there's nothing to roll back.`
        : "Your live app already matches that version — nothing to roll back.";
    }

    await git(["commit", "-m", `Rolled back to ${rollbackLabel}`], repoPath);

    // Push with upstream fallback
    let rbPushResult = await git(["push"], repoPath);
    if (rbPushResult.exitCode !== 0 && /no upstream branch|no tracking information|has no upstream/i.test(rbPushResult.stderr)) {
      rbPushResult = await git(["push", "-u", "origin", config.liveBranch], repoPath);
    }
    if (rbPushResult.exitCode !== 0) {
      await git(["checkout", config.devBranch], repoPath);
      const failureMsg = await classifyPushFailure(repoPath, rbPushResult.stderr);
      if (failureMsg !== null) {
        return `Your rollback is saved locally, but it didn't go live.\n\n${failureMsg}\n\nOnce that's fixed, say 'ship it' again.`;
      }
      throw new Error(`Rollback push failed: ${rbPushResult.stderr}`);
    }

    const rbReleaseTag = await createReleaseTag(repoPath);

    // Sync versie-dev to match main after the rollback.
    // The revert commit(s) are on main but not on versie-dev, leaving it "behind".
    // A fast-forward merge brings them in sync so there are no confusing "N commits behind" warnings.
    await git(["checkout", config.devBranch], repoPath);
    await git(["merge", config.liveBranch, "--ff-only"], repoPath);
    await git(["push", "origin", config.devBranch], repoPath);

    const rbGitNote = config.showGitCommands
      ? `\n\`\`\`\ngit checkout ${config.liveBranch}\ngit pull\ngit revert HEAD~${hashes.length}..HEAD --no-commit\ngit commit -m "Rolled back to ${rollbackLabel}"\ngit push origin ${config.liveBranch}\ngit tag -a ${rbReleaseTag} -m "${rbReleaseTag}"\n\`\`\``
      : "";

    return `Rolled back! Your live app now matches "${rollbackLabel}". (${rbReleaseTag})${rbGitNote}`;
  }

  // Step 2b: Pre-ship deploy platform check — warn before touching the live branch
  const deployWarning = await checkDeployConfig(repoPath, config.liveBranch);
  if (deployWarning) {
    return (
      `⚠ Hold on — ${deployWarning}\n\n` +
      `Fix this in your platform settings first, then say "ship it" again. ` +
      `Say "help with shipping setup" for step-by-step instructions.`
    );
  }

  // Step 3: Switch to live branch and pull latest
  await git(["checkout", config.liveBranch], repoPath);
  const pullResult = await git(["pull"], repoPath);
  if (pullResult.exitCode !== 0) {
    // If pull fails (no remote, no upstream), try without remote
    await git(["pull", "--allow-unrelated-histories"], repoPath);
  }

  // Step 4: Merge versie-dev into live branch
  const mergeResult = await git(["merge", config.devBranch, "--no-edit"], repoPath);
  if (mergeResult.exitCode !== 0) {
    // Capture conflicting files BEFORE aborting (after abort, conflict markers are gone)
    const conflictResult = await git(
      ["diff", "--name-only", "--diff-filter=U"],
      repoPath
    );
    const files = conflictResult.stdout.split("\n").filter(Boolean);

    // Abort and return to dev
    await git(["merge", "--abort"], repoPath);
    await git(["checkout", config.devBranch], repoPath);

    // Merge live INTO dev so conflict markers appear in the workspace.
    // This lets the user (or Claude) see both versions and resolve in place.
    const devMerge = await git(["merge", config.liveBranch, "--no-edit"], repoPath);
    if (devMerge.exitCode !== 0) {
      // Conflicts are now visible in the workspace files as <<<<<<< markers
      const fileList = files.length > 0 ? `\n  - ${files.join("\n  - ")}` : "";
      return (
        `Your work and the live version both changed the same file${files.length !== 1 ? "s" : ""}:${fileList}\n\n` +
        `I've put both versions in the file${files.length !== 1 ? "s" : ""} so you can see what's different. ` +
        `Look for the <<<<<<< and >>>>>>> sections — pick which lines to keep and remove the markers. ` +
        `Then say 'save my work' and 'ship it' again.`
      );
    }

    // Merge succeeded without conflict (live changes were compatible) — retry ship
    // Push the synced dev branch, then fall through to retry
    await git(["push", "origin", config.devBranch], repoPath);
    await git(["checkout", config.liveBranch], repoPath);
    const retryMerge = await git(["merge", config.devBranch, "--no-edit"], repoPath);
    if (retryMerge.exitCode !== 0) {
      await git(["merge", "--abort"], repoPath);
      await git(["checkout", config.devBranch], repoPath);
      const fileList = files.length > 0 ? `\n  - ${files.join("\n  - ")}` : "";
      return (
        `Your work and the live version both changed the same file${files.length !== 1 ? "s" : ""}:${fileList}\n\n` +
        `I've paused the release and put you back in your workspace.\n` +
        `To fix: open the file${files.length !== 1 ? "s" : ""} above, update ${files.length !== 1 ? "them" : "it"} to include the changes you want, ` +
        `save your work, then say 'ship it' again.`
      );
    }
    // Retry succeeded — fall through to push + tag below
  }

  // Step 5: Push live branch
  let pushResult = await git(["push"], repoPath);

  // First-time push: live branch has no upstream yet — set it automatically
  if (pushResult.exitCode !== 0 && /no upstream branch|no tracking information|has no upstream/i.test(pushResult.stderr)) {
    pushResult = await git(["push", "-u", "origin", config.liveBranch], repoPath);
  }

  if (pushResult.exitCode !== 0) {
    await git(["checkout", config.devBranch], repoPath);
    const failureMsg = await classifyPushFailure(repoPath, pushResult.stderr);
    if (failureMsg !== null) {
      return `Your work is saved, but it didn't go live.\n\n${failureMsg}\n\nOnce that's fixed, say 'ship it' again.`;
    }
    throw new Error(`Shipping failed while pushing: ${pushResult.stderr}`);
  }

  // Step 6: Create release tag on live branch, then switch back to dev
  const releaseTag = await createReleaseTag(repoPath);
  await git(["checkout", config.devBranch], repoPath);

  // Sync dev with live so the merge commit is on both branches.
  // Without this, the next ship can conflict because main has a merge commit dev doesn't.
  await git(["merge", config.liveBranch, "--ff-only"], repoPath);
  await git(["push", "origin", config.devBranch], repoPath);

  const changeCount = `${gap.count} change${gap.count === 1 ? "" : "s"}`;
  const unsavedNote = hasUnsaved ? "\n\nYou have unsaved changes — they weren't included. Say **'save my work'** when ready." : "";

  const gitNote = config.showGitCommands
    ? `\n\`\`\`\ngit checkout ${config.liveBranch}\ngit pull\ngit merge ${config.devBranch} --no-edit\ngit push origin ${config.liveBranch}\ngit tag -a ${releaseTag} -m "${releaseTag}"\n\`\`\``
    : "";

  const summary = gap.summaries.length > 0 ? ` — ${gap.summaries.slice(0, 2).join(", ")}${gap.summaries.length > 2 ? "…" : ""}` : "";
  return `Shipped! ${changeCount} live${summary}. (${releaseTag})${gitNote}${unsavedNote}`;
}

export interface ErrorPattern {
  id: string;
  match: RegExp;
  explanation: string;
  /**
   * Each element is a git command array. Placeholders:
   *   {devBranch}  — replaced with config.devBranch at runtime
   *   {liveBranch} — replaced with config.liveBranch at runtime
   */
  fix: string[][];
  snapshotFirst: boolean;
  successMessage?: string;
  /** If false, continue executing fix steps even when one fails. Default: true (stop on error). */
  stopOnError?: boolean;
  /** Some patterns require interactive user input — flag them so the tool can handle differently */
  requiresUserInput?: boolean;
}

export const PATTERNS: ErrorPattern[] = [
  {
    id: "not-a-repo",
    match: /fatal: not a git repository/i,
    explanation: "This folder isn't set up as a project yet.",
    fix: [["init"]],
    snapshotFirst: false,
    successMessage: "Done — this folder is now a project. Say 'save my work' to save your progress.",
  },
  {
    id: "local-changes-overwritten",
    match: /Your local changes would be overwritten/i,
    explanation: "You have unsaved work that needs to be saved first.",
    fix: [
      ["add", "-A"],
      ["stash"],
    ],
    snapshotFirst: false,
    successMessage: "Saved your work. Try your last action again.",
  },
  {
    id: "merge-conflict",
    match: /CONFLICT \(content\): Merge conflict in/i,
    explanation:
      "Two versions of the same file changed the same lines. " +
      "Look for the conflict markers (<<<<<<, =======, >>>>>>>) in the file, " +
      "pick which version to keep, then say 'save my work' to continue.",
    fix: [], // Manual resolution required
    snapshotFirst: true,
    requiresUserInput: true,
    successMessage: "Once you've picked which lines to keep in each conflict, say 'save my work' to continue.",
  },
  {
    id: "detached-head",
    match: /HEAD detached at/i,
    explanation: "You ended up in a strange state — not working on any version. Switching you back.",
    fix: [["checkout", "{devBranch}"]],
    snapshotFirst: true,
    successMessage: "Back in your workspace. Your work is safe.",
  },
  {
    id: "push-rejected",
    match: /\[rejected\].*non-fast-forward|failed to push some refs/i,
    explanation: "Someone else saved changes to GitHub since you last synced. Grabbing those updates first.",
    fix: [
      ["pull", "--rebase", "origin", "{devBranch}"],
      ["push", "origin", "{devBranch}"],
    ],
    snapshotFirst: false,
    successMessage: "Synced and saved to GitHub.",
  },
  {
    id: "unrelated-histories",
    match: /refusing to merge unrelated histories/i,
    explanation: "Your local project and GitHub think they're different projects. Connecting them now.",
    fix: [["pull", "origin", "{liveBranch}", "--allow-unrelated-histories"]],
    snapshotFirst: true,
    successMessage: "Connected. Try your action again.",
  },
  {
    id: "no-upstream",
    match: /The current branch has no upstream branch/i,
    explanation: "Your work isn't connected to GitHub yet.",
    fix: [["push", "-u", "origin", "{devBranch}"]],
    snapshotFirst: false,
    successMessage: "Connected to GitHub. Your work is now being saved there.",
  },
  {
    id: "divergent-branches",
    match: /Need to specify how to reconcile divergent branches/i,
    explanation: "Your project and GitHub got out of sync. Aligning them now.",
    fix: [
      ["config", "pull.rebase", "false"],
      ["pull"],
    ],
    snapshotFirst: false,
    successMessage: "Synced. Try your action again.",
  },
  {
    id: "permission-denied-ssh",
    match: /Permission denied \(publickey\)/i,
    explanation:
      "GitHub doesn't recognize this computer yet — it needs to verify who you are. " +
      "Go to github.com → Settings → SSH and GPG keys, and add a new SSH key. " +
      "If you need help with this, contact support@versie.co.",
    fix: [], // SSH setup is outside git — requires browser + manual steps
    snapshotFirst: false,
    requiresUserInput: true,
    successMessage: "Once your SSH key is added to GitHub, say your original action again.",
  },
  {
    id: "lock-file",
    match: /Unable to create '.*\.lock': File exists/i,
    explanation: "A previous operation didn't finish cleanly. Clearing the leftover file.",
    fix: [["clean", "-f", ".git/index.lock"]],
    snapshotFirst: false,
    successMessage: "Cleared. Try your action again.",
  },
  {
    id: "checkout-blocked",
    match: /cannot switch branches|Please commit or stash/i,
    explanation: "You have unsaved work. Saving it first.",
    fix: [
      ["add", "-A"],
      ["stash"],
    ],
    snapshotFirst: false,
    successMessage: "Saved your work. Try your action again.",
  },
  {
    id: "corrupt-repo",
    match: /fatal: bad object|broken link from tree/i,
    explanation:
      "Your project's history got corrupted. Trying to repair it — " +
      "if this doesn't work, your project data may need to be recovered from GitHub.",
    fix: [
      ["fsck", "--full"],
      ["gc"],
    ],
    snapshotFirst: true,
    stopOnError: false,
    successMessage:
      "Repaired. If you're still having issues, contact support@versie.co.",
  },
  {
    id: "wrong-branch",
    match: /You are not currently on branch|already on/i,
    explanation: "You ended up on the wrong branch. Switching you back to your workspace.",
    fix: [["checkout", "{devBranch}"]],
    snapshotFirst: false,
    successMessage: "Back in your workspace.",
  },
  {
    id: "merge-conflict-deploy",
    match: /Automatic merge failed; fix conflicts/i,
    explanation:
      "Your work and the live version both changed the same file. " +
      "I've paused the deploy. Look for conflict markers (<<<<<<, =======, >>>>>>>) in the files, " +
      "pick which version to keep, then say 'ship it' to try again.",
    fix: [
      ["merge", "--abort"],
      ["checkout", "{devBranch}"],
    ],
    snapshotFirst: true,
    requiresUserInput: true,
    successMessage: "Paused the deploy. Fix the conflicts, then say 'ship it' again.",
  },
  {
    id: "email-privacy",
    match: /GH007|push would publish a private email address|push declined due to email privacy/i,
    explanation:
      "GitHub is blocking the push to protect your email address. " +
      "To fix this, go to github.com/settings/emails, copy your no-reply email address " +
      "(it looks like 123456789+username@users.noreply.github.com), then share it here " +
      "and I'll update your settings.",
    fix: [
      // Step 1: Clear any local override
      ["config", "--local", "--unset", "user.email"],
    ],
    snapshotFirst: false,
    requiresUserInput: true, // Need user to provide their no-reply address
    successMessage:
      "All set — synced to GitHub. Your settings are updated globally so this won't happen in other projects.",
  },
];

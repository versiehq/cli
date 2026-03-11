/**
 * Parses raw git output into structured data.
 * All functions return plain objects — no git jargon in property names.
 */

export interface FileChange {
  status: string; // M, A, D, R, ?
  path: string;
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
  author: string;
}

/** Parse `git status --porcelain` output */
export function parseStatus(porcelain: string): FileChange[] {
  if (!porcelain) return [];
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));
}

/** Parse `git log --format="%H|%h|%s|%ai|%an"` output */
export function parseLog(raw: string): LogEntry[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, message, date, author] = line.split("|");
      return { hash, shortHash, message, date, author };
    });
}

/** Parse `git diff --stat` or `git diff --cached --stat` output, return last summary line */
export function parseDiffStat(raw: string): string {
  if (!raw) return "no changes";
  const lines = raw.split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "no changes";
}

/** Parse `git log --oneline` output, return array of "hash message" strings */
export function parseOnelog(raw: string): string[] {
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

/** Count commits from `git log --oneline` output */
export function countCommits(raw: string): number {
  return parseOnelog(raw).length;
}

/** Parse `git tag -l "versie/release/*"` to find next release number */
export function nextReleaseNumber(tagsRaw: string): number {
  if (!tagsRaw) return 1;
  const nums = tagsRaw
    .split("\n")
    .filter(Boolean)
    .map((tag) => {
      const match = tag.match(/versie\/release\/v(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
  return Math.max(0, ...nums) + 1;
}

/** Parse `git worktree list --porcelain` to check for active worktrees */
export function hasExtraWorktrees(raw: string): boolean {
  // Each worktree entry starts with "worktree "
  const entries = raw.split("\n\n").filter((e) => e.includes("worktree "));
  return entries.length > 1;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  logger.debug(`git ${args.join(" ")} (cwd: ${cwd})`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: stdout.replace(/\r\n/g, "\n").trimEnd(), stderr: stderr.replace(/\r\n/g, "\n").trimEnd(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? "").replace(/\r\n/g, "\n").trimEnd(),
      stderr: (e.stderr ?? "").replace(/\r\n/g, "\n").trimEnd(),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export function isSuccess(result: GitResult): boolean {
  return result.exitCode === 0;
}

#!/usr/bin/env node
/**
 * Versie CLI
 *
 * Thin dispatcher over the same tool functions used by the MCP server.
 * Designed to be called by an AI coding tool (Cursor, Claude Code) via bash —
 * much cheaper in tokens than MCP tool calls for mechanical operations.
 *
 * Usage:
 *   versie save ["message"]
 *   versie ship ["release notes"]
 *   versie checkpoint ["name"]
 *   versie status
 *   versie go-back <target>
 *   versie health
 *   versie remove
 *   versie uninstall
 *   versie help
 */

import { saveMyWork } from "./tools/save-my-work.js";
import { shipIt } from "./tools/ship-it.js";
import { saveAndShip } from "./tools/save-and-ship.js";
import { createCheckpointTool } from "./tools/create-checkpoint.js";
import { whatsChanged } from "./tools/whats-changed.js";
import { goBackTo } from "./tools/go-back-to.js";
import { checkHealth } from "./tools/check-health.js";
import { fixThisError } from "./tools/fix-this-error.js";
import { projectTimeline } from "./tools/project-timeline.js";
import { deployPlatformHelp } from "./tools/deploy-platform-help.js";
import { readConfig, writeConfig } from "./utils/config.js";
import { startDeviceFlow, pollDeviceFlow, readAuthToken } from "./auth/device-flow.js";
import { runUninstaller } from "./install.js";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { git } from "./git/executor.js";

async function confirm(question: string): Promise<boolean> {
  // Non-interactive (piped/AI tool) — require explicit --yes flag instead
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

const repoPath = process.cwd();
const [, , command, ...rest] = process.argv;

async function run(): Promise<void> {
  switch (command) {
    case "save": {
      const result = await saveMyWork({
        repo_path: repoPath,
        description: rest[0],
      });
      console.log(result);
      break;
    }

    case "save-and-ship": {
      const result = await saveAndShip({
        repo_path: repoPath,
        description: rest[0],
      });
      console.log(result);
      break;
    }

    case "ship": {
      const result = await shipIt({
        repo_path: repoPath,
        release_notes: rest[0],
      });
      console.log(result);
      break;
    }

    case "checkpoint": {
      const result = await createCheckpointTool({
        repo_path: repoPath,
        name: rest[0],
      });
      console.log(result);
      break;
    }

    case "status": {
      const result = await whatsChanged({ repo_path: repoPath });
      console.log(result);
      break;
    }

    case "go-back": {
      if (!rest[0]) {
        console.error("Usage: versie go-back <checkpoint-name-or-description>");
        process.exit(1);
      }
      const result = await goBackTo({
        repo_path: repoPath,
        target: rest.join(" "),
      });
      console.log(result);
      break;
    }

    case "health": {
      const result = await checkHealth({ repo_path: repoPath });
      console.log(result);
      break;
    }

    case "setup": {
      const result = await checkHealth({ repo_path: repoPath, github_url: rest[0] });
      console.log(result);
      break;
    }

    case "login": {
      const phase1 = await startDeviceFlow(repoPath);
      console.log(phase1.replace(/\*\*/g, ""));
      const result = await pollDeviceFlow(repoPath);
      console.log(result.replace(/\*\*/g, ""));
      break;
    }

    case "deploy-help": {
      const result = await deployPlatformHelp({
        repo_path: repoPath,
        platform: rest[0] as "vercel" | "netlify" | "railway" | "render" | "other" | undefined,
      });
      console.log(result);
      break;
    }

    case "config": {
      const [setting, value] = rest;
      if (!setting || !value) {
        console.error("Usage: versie config <setting> <value>\n  versie config show-git-commands on|off\n  versie config telemetry on|off");
        process.exit(1);
      }
      const config = readConfig(repoPath);
      if (!config) {
        console.error("Versie isn't set up in this project. Run \"versie setup\" first.");
        process.exit(1);
      }
      if (setting === "show-git-commands") {
        if (value !== "on" && value !== "off") { console.error("Value must be 'on' or 'off'."); process.exit(1); }
        writeConfig(repoPath, { ...config, showGitCommands: value === "on" });
        console.log(value === "on" ? "Git commands on — tools will now show the underlying git operations." : "Git commands off — tools will show plain output again.");
      } else if (setting === "telemetry") {
        if (value !== "on" && value !== "off") { console.error("Value must be 'on' or 'off'."); process.exit(1); }
        writeConfig(repoPath, { ...config, telemetry: value === "on" });
        console.log(value === "on" ? "Telemetry on." : "Telemetry off.");
      } else {
        console.error(`Unknown setting: ${setting}\nAvailable: show-git-commands, telemetry`);
        process.exit(1);
      }
      break;
    }

    case "timeline": {
      const result = await projectTimeline({
        repo_path: repoPath,
        limit: rest[0] ? parseInt(rest[0], 10) : undefined,
      });
      console.log(result);
      break;
    }

    case "remove": {
      const token = readAuthToken(repoPath);
      if (!token) {
        console.error("Not connected to the Versie dashboard. Run \"versie login\" first.");
        process.exit(1);
      }
      const remoteResult = await git(["remote", "get-url", "origin"], repoPath);
      const remoteUrl = remoteResult.stdout.trim();
      if (!remoteUrl) {
        console.error("No git remote found. Is this a git repo with a remote configured?");
        process.exit(1);
      }
      const repoHash = createHash("sha256").update(remoteUrl).digest("hex");

      // Require confirmation unless --yes flag is passed (e.g. when called by an AI tool
      // that has already confirmed with the user in chat)
      const skipConfirm = rest.includes("--yes");
      if (!skipConfirm) {
        const repoName = remoteUrl.match(/([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? remoteUrl;
        const ok = await confirm(`Remove ${repoName} from the Versie dashboard?`);
        if (!ok) {
          console.log("Cancelled.");
          break;
        }
      }

      const res = await fetch("https://www.versie.co/api/remove-project", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ repo_hash: repoHash }),
      });
      if (res.status === 404) {
        console.log("This project isn't connected to the Versie dashboard.");
      } else if (!res.ok) {
        const data = await res.json() as { error?: string };
        console.error(`Couldn't remove project: ${data.error ?? res.status}`);
        process.exit(1);
      } else {
        console.log("Project removed from your Versie dashboard. Local files are untouched.");
      }
      break;
    }

    case "uninstall": {
      runUninstaller();
      break;
    }

    case "fix": {
      if (!rest[0]) {
        console.error("Usage: versie fix \"error message\"");
        process.exit(1);
      }
      const result = await fixThisError({ repo_path: repoPath, error_message: rest.join(" ") });
      console.log(result);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      if (process.stdout.isTTY) {
        console.log(`
Versie — Plain-language version control and deploy safety for AI-powered builders

COMMANDS
  versie save [message]          Save your current work
  versie save-and-ship [desc]    Save and ship live in one step
  versie ship [release-notes]    Ship saved work live
  versie checkpoint [name]       Create a named checkpoint to return to
  versie status                  Show what's changed since last save
  versie go-back <target>        Go back to a checkpoint
  versie timeline [limit]        Show save, checkpoint, and ship history
  versie health                  Check project setup
  versie setup [github-url]      First-time project setup
  versie login                   Connect to the Versie dashboard
  versie fix "error message"     Diagnose and fix a git error
  versie deploy-help [platform]  Configure Vercel, Netlify, Railway, or Render
  versie config <setting> <val>  Change a setting (show-git-commands, telemetry)
  versie remove                  Remove this project from the Versie dashboard
  versie uninstall               Remove Versie from your AI tools
        `.trim());
      } else {
        // Running inside an AI tool — show natural language phrases instead of CLI syntax
        console.log(`
Versie is ready. Say any of these in plain English:

Saving & Shipping
  "save my work"         — Save progress (live app unchanged)
  "ship it"              — Ship your saved work live
  "save and ship"        — Save + ship in one step

History & Status
  "what's changed"       — Unsaved changes since last save
  "what's not live yet"  — Saved but not yet shipped
  "show my timeline"     — Full save, checkpoint, and ship history

Checkpoints
  "create a checkpoint"      — Bookmark this moment to return to
  "go back to [name/time]"   — Restore a checkpoint or earlier save
  "go back to live"          — Reset workspace to what's live

Setup & Config
  "set up versie"            — First-time project setup
  "check my project health"  — Full status report
  "help with shipping setup" — Configure Vercel/Netlify/Railway so only "ship it" goes live
  "versie login"             — Connect to the dashboard at versie.co

Errors
  "fix this error: [paste error]" — Diagnose and fix a git error

Something broken? support@versie.co
        `.trim());
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}\nRun "versie help" for usage.`);
      process.exit(1);
    }
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});

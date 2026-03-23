import { z } from "zod/v4";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig } from "../utils/config.js";

export const deployPlatformHelpSchema = {
  description:
    "Say 'help with shipping setup' to configure Vercel, Netlify, Railway, or Render " +
    "to only go live when you say 'ship it', not on every save.",
  inputSchema: z.object({
    platform: z
      .enum(["vercel", "netlify", "railway", "render", "other"])
      .optional()
      .describe("Your shipping platform. Auto-detected from project files if not specified."),
    repo_path: z
      .string()
      .optional()
      .describe("REQUIRED. Always set this to the absolute path of the current workspace folder — never omit it. The MCP server cannot determine the project path on its own."),
  }),
};

export async function deployPlatformHelp(args: z.infer<typeof deployPlatformHelpSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;
  const config = readConfig(repoPath);
  const liveBranch = config?.liveBranch ?? "main";

  // Auto-detect platform from project files
  let platform = args.platform;
  if (!platform) {
    platform = detectPlatform(repoPath);
  }

  // Check GitHub Actions first — if they have broad deploy workflows, fix them
  const ghActionsResult = fixBroadGithubActions(repoPath, liveBranch);
  let ghActionsNote = "";
  if (ghActionsResult.fixed.length > 0) {
    ghActionsNote =
      `\n\nGITHUB ACTIONS — AUTO-FIXED\n` +
      `I updated ${ghActionsResult.fixed.length} workflow file${ghActionsResult.fixed.length === 1 ? "" : "s"} ` +
      `to only go live when you ship:\n` +
      ghActionsResult.fixed.map((f) => `  ✓ ${f}`).join("\n\n") +
      `\nSave and ship these changes to apply the fix.`;
  } else if (ghActionsResult.detected.length > 0) {
    ghActionsNote =
      `\n\nGITHUB ACTIONS WARNING\n` +
      `${ghActionsResult.detected.length} workflow file${ghActionsResult.detected.length === 1 ? "" : "s"} may go live on every save:\n` +
      ghActionsResult.detected.map((f) => `  ⚠ ${f}`).join("\n\n") +
      `\nOpen each file in GitHub (github.com → your repo → .github/workflows) ` +
      `and change 'on: push' to only run on the '${liveBranch}' branch.`;
  }

  let response = "";
  switch (platform) {
    case "vercel":
      response = vercelHelp(liveBranch);
      break;
    case "netlify":
      response = netlifyHelp(liveBranch);
      break;
    case "railway":
      response = railwayHelp(liveBranch);
      break;
    case "render":
      response = renderHelp(liveBranch);
      break;
    default:
      response = genericHelp(liveBranch);
  }

  return response + ghActionsNote;
}

function detectPlatform(repoPath: string): "vercel" | "netlify" | "railway" | "render" | "other" {
  if (existsSync(join(repoPath, "vercel.json"))) return "vercel";
  if (existsSync(join(repoPath, "netlify.toml"))) return "netlify";
  if (existsSync(join(repoPath, "railway.json"))) return "railway";
  if (existsSync(join(repoPath, "render.yaml"))) return "render";
  return "other";
}

interface ActionsResult {
  fixed: string[];    // workflow files we successfully updated
  detected: string[]; // workflow files we detected but couldn't auto-fix
}

/**
 * Find GitHub Actions workflows that deploy on every push and fix them
 * by restricting to the live branch. Returns list of fixed/detected files.
 */
function fixBroadGithubActions(repoPath: string, liveBranch: string): ActionsResult {
  const result: ActionsResult = { fixed: [], detected: [] };
  const workflowsDir = join(repoPath, ".github", "workflows");
  if (!existsSync(workflowsDir)) return result;

  let files: string[] = [];
  try {
    files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return result;
  }

  const MAX_WORKFLOW_SIZE = 1024 * 1024; // 1MB

  for (const file of files) {
    const filePath = join(workflowsDir, file);
    try {
      if (statSync(filePath).size > MAX_WORKFLOW_SIZE) continue; // skip oversized files
      const content = readFileSync(filePath, "utf-8");

      // Detect: push with no branches filter, or push with wildcard
      const hasBroadPush =
        /^on:\s*\n\s+push:\s*\n(?!\s+branches:)/m.test(content) ||
        /push:\s*\n\s+branches:\s*\n\s+-\s*['"]\*['"]/m.test(content) ||
        /^on:\s+\[push\]/m.test(content); // shorthand: on: [push]

      if (!hasBroadPush) continue;

      // Try to auto-fix: add branch filter
      let fixed = content;

      // Case 1: shorthand "on: [push]" → expand with branch filter
      fixed = fixed.replace(
        /^on:\s+\[push\]/m,
        `on:\n  push:\n    branches:\n      - ${liveBranch}`
      );

      // Case 2: "on:\n  push:\n    (no branches)" → add branch filter
      fixed = fixed.replace(
        /(on:\s*\n\s+push:\s*\n)(?!\s+branches:)/m,
        `$1    branches:\n      - ${liveBranch}\n`
      );

      if (fixed !== content) {
        writeFileSync(filePath, fixed, "utf-8");
        result.fixed.push(file);
      } else {
        result.detected.push(file);
      }
    } catch {
      // Can't read/write — mark as detected only
      result.detected.push(file);
    }
  }

  return result;
}

function vercelHelp(liveBranch: string): string {
  return (
    `VERCEL SETUP\n\n` +
    `Good news — Vercel protects you by default. It only goes live from '${liveBranch}', ` +
    `so saving your work won't touch your live app.\n\n` +
    `To double-check:\n` +
    `  1. Go to vercel.com → your project\n` +
    `  2. Click Settings → Environments\n` +
    `  3. Under Production, make sure the branch is set to '${liveBranch}'\n\n` +
    `Preview builds on versie-dev are harmless — private previews only, no effect on your live app.\n\n` +
    `**Optional:** To stop preview builds on versie-dev (saves build minutes):\n` +
    `  1. Go to vercel.com → your project → Settings → Build and Deployment\n` +
    `  2. Scroll to Ignored Build Step → select Custom and enter:\n` +
    `     if [ "$VERCEL_GIT_COMMIT_REF" == "versie-dev" ]; then exit 0; else exit 1; fi\n` +
    `  3. Click Save\n\n` +
    `That's it — you're fully set up. Say "ship it" whenever you're ready to go live.`
  );
}

function netlifyHelp(liveBranch: string): string {
  return (
    `NETLIFY SETUP\n\n` +
    `To protect your live app, tell Netlify to only go live from '${liveBranch}':\n\n` +
    `  1. Go to netlify.com → your app\n` +
    `  2. Click Project configuration → Build & deploy → Continuous Deployment → Branches and deploy contexts → Configure\n` +
    `  3. Make sure production branch is set to '${liveBranch}'\n` +
    `  4. Under Branch deploys, choose 'Deploy only the production branch'\n\n` +
    `After this, saving your work won't update your live app — only 'ship it' will.`
  );
}

function railwayHelp(liveBranch: string): string {
  return (
    `RAILWAY SETUP\n\n` +
    `To protect your live app, point Railway to '${liveBranch}' only:\n\n` +
    `  1. Go to railway.app → your project\n` +
    `  2. Click your service → Settings\n` +
    `  3. Under the GitHub integration section, set the trigger branch to '${liveBranch}'\n\n` +
    `After this, saving your work won't update your live app — only 'ship it' will.`
  );
}

function renderHelp(liveBranch: string): string {
  return (
    `RENDER SETUP\n\n` +
    `To protect your live service, make sure Render is pointed to '${liveBranch}' only:\n\n` +
    `  1. Go to render.com → your service\n` +
    `  2. Click Settings → Build & Deploy\n` +
    `  3. Check that the connected branch is '${liveBranch}' (set when the service was created)\n` +
    `  4. Make sure Auto-Deploy is enabled so 'ship it' triggers a live update\n\n` +
    `After this, saving your work won't update your live service — only 'ship it' will.`
  );
}

function genericHelp(liveBranch: string): string {
  return (
    `SHIPPING SETUP\n\n` +
    `To make sure your live app only updates when you say 'ship it':\n\n` +
    `Find your shipping platform's branch settings and point it to '${liveBranch}' only.\n` +
    `That way:\n` +
    `  - Saving your work stays private (goes to versie-dev)\n` +
    `  - 'Ship it' updates your live app (merges to ${liveBranch})\n\n` +
    `Where to find this setting:\n` +
    `  • Vercel → Project Settings → Git → Production Branch\n` +
    `  • Netlify → Site configuration → Build & deploy → Branches\n` +
    `  • Railway → Service Settings → Source → Branch\n` +
    `  • Render → Service Settings → Build & Deploy\n\n` +
    `Tell me which platform you use and I'll give you exact steps.`
  );
}

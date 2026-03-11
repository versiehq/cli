import { z } from "zod/v4";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoPath, readConfig } from "../utils/config.js";

export const deployPlatformHelpSchema = {
  description:
    "Get help configuring your deploy platform (Vercel, Netlify, Railway, etc.) " +
    "to only deploy when you say 'ship it', not on every save.",
  inputSchema: z.object({
    platform: z
      .enum(["vercel", "netlify", "railway", "render", "other"])
      .optional()
      .describe("Your deploy platform. Auto-detected from project files if not specified."),
    repo_path: z
      .string()
      .optional()
      .describe("Path to your project folder. Uses current directory if not provided."),
  }),
};

export async function deployPlatformHelp(args: z.infer<typeof deployPlatformHelpSchema.inputSchema>): Promise<string> {
  const repoPath = resolveRepoPath(args.repo_path);
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
      `to only deploy when you ship:\n` +
      ghActionsResult.fixed.map((f) => `  ✓ ${f}`).join("\n") +
      `\nSave and ship these changes to apply the fix.`;
  } else if (ghActionsResult.detected.length > 0) {
    ghActionsNote =
      `\n\nGITHUB ACTIONS WARNING\n` +
      `${ghActionsResult.detected.length} workflow file${ghActionsResult.detected.length === 1 ? "" : "s"} may deploy on every save:\n` +
      ghActionsResult.detected.map((f) => `  ⚠ ${f}`).join("\n") +
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

  for (const file of files) {
    const filePath = join(workflowsDir, file);
    try {
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
    `Good news — Vercel protects you by default. It only deploys from '${liveBranch}', ` +
    `so saving your work won't touch your live app.\n\n` +
    `To double-check:\n` +
    `  1. Go to vercel.com → your project\n` +
    `  2. Click Settings → Git\n` +
    `  3. Make sure 'Production Branch' shows '${liveBranch}'\n\n` +
    `Preview deployments on versie-dev are fine — those are private previews only.`
  );
}

function netlifyHelp(liveBranch: string): string {
  return (
    `NETLIFY SETUP\n\n` +
    `To protect your live app, tell Netlify to only deploy from '${liveBranch}':\n\n` +
    `  1. Go to netlify.com → your app\n` +
    `  2. Click Site configuration → Build & deploy → Branches and deploy contexts\n` +
    `  3. Under 'Branch deploys', choose 'Deploy only the production branch'\n` +
    `  4. Make sure production branch is set to '${liveBranch}'\n\n` +
    `After this, saving your work won't update your live app — only 'ship it' will.`
  );
}

function railwayHelp(liveBranch: string): string {
  return (
    `RAILWAY SETUP\n\n` +
    `To protect your live app, point Railway to '${liveBranch}' only:\n\n` +
    `  1. Go to railway.app → your project\n` +
    `  2. Click your service → Settings → Source\n` +
    `  3. Set 'Branch' to '${liveBranch}'\n\n` +
    `After this, saving your work won't redeploy your app — only 'ship it' will.`
  );
}

function renderHelp(liveBranch: string): string {
  return (
    `RENDER SETUP\n\n` +
    `To protect your live service, point Render to '${liveBranch}' only:\n\n` +
    `  1. Go to render.com → your service\n` +
    `  2. Click Settings → Build & Deploy\n` +
    `  3. Set 'Auto-Deploy' branch to '${liveBranch}'\n\n` +
    `After this, saving your work won't redeploy your service — only 'ship it' will.`
  );
}

function genericHelp(liveBranch: string): string {
  return (
    `DEPLOY SETUP\n\n` +
    `To make sure your live app only updates when you say 'ship it':\n\n` +
    `Find your deploy platform's branch settings and point it to '${liveBranch}' only.\n` +
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

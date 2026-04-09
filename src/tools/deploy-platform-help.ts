import { z } from "zod/v4";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { readConfig } from "../utils/config.js";

export const deployPlatformHelpSchema = {
  description:
    "Say 'help with shipping setup' to configure Vercel, Netlify, Railway, Render, or Supabase " +
    "to only go live when you say 'ship it', not on every save.",
  inputSchema: z.object({
    platform: z
      .enum(["vercel", "netlify", "railway", "render", "supabase", "other"])
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
    case "supabase":
      response = supabaseHelp(liveBranch, detectSupabaseMode(repoPath));
      break;
    default:
      response = genericHelp(liveBranch);
  }

  return response + ghActionsNote;
}

function detectPlatform(repoPath: string): "vercel" | "netlify" | "railway" | "render" | "supabase" | "other" {
  if (existsSync(join(repoPath, "vercel.json"))) return "vercel";
  if (existsSync(join(repoPath, "netlify.toml"))) return "netlify";
  if (existsSync(join(repoPath, "railway.json"))) return "railway";
  if (existsSync(join(repoPath, "render.yaml"))) return "render";
  if (
    existsSync(join(repoPath, "supabase", "functions")) ||
    existsSync(join(repoPath, "supabase", "migrations"))
  ) return "supabase";
  return "other";
}

function detectSupabaseMode(repoPath: string): "functions" | "migrations" | "both" | "none" {
  const hasFunctions = existsSync(join(repoPath, "supabase", "functions"));
  const hasMigrations = existsSync(join(repoPath, "supabase", "migrations"));
  if (hasFunctions && hasMigrations) return "both";
  if (hasFunctions) return "functions";
  if (hasMigrations) return "migrations";
  return "none";
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
    `PREREQUISITE — Connect your GitHub repo to Vercel\n\n` +
    `If you haven't already:\n` +
    `  1. Go to vercel.com → your project → Settings → Git\n` +
    `  2. If no repo is connected, click Connect Git Repository and select your repo\n\n` +
    `Once connected, Vercel protects you by default — it only goes live from '${liveBranch}', ` +
    `so saving your work won't touch your live app.\n\n` +
    `To double-check:\n` +
    `  1. Go to vercel.com → your project → Settings → Git\n` +
    `  2. Under Production Branch, make sure it's set to '${liveBranch}'\n\n` +
    `Preview builds on versie-dev are harmless — private previews only, no effect on your live app.\n\n` +
    `Optional — stop preview builds on versie-dev (saves build minutes):\n` +
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

function supabaseHelp(liveBranch: string, mode: "functions" | "migrations" | "both" | "none"): string {
  const hasMigrations = mode === "migrations" || mode === "both";
  const hasFunctions = mode === "functions" || mode === "both";

  const migrationsJob =
    `  migrate:\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@v4\n` +
    `      - uses: supabase/setup-cli@v1\n` +
    `        with:\n` +
    `          version: latest\n` +
    `      - run: supabase db push\n` +
    `        env:\n` +
    `          SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}\n` +
    `          SUPABASE_DB_PASSWORD: \${{ secrets.SUPABASE_DB_PASSWORD }}\n`;

  const functionsJob =
    `  deploy-functions:\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@v4\n` +
    `      - uses: supabase/setup-cli@v1\n` +
    `        with:\n` +
    `          version: latest\n` +
    `      - run: supabase functions deploy\n` +
    `        env:\n` +
    `          SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}\n`;

  const workflowName = mode === "both" ? "Supabase" : hasMigrations ? "Supabase Migrations" : "Supabase Edge Functions";
  const fileName = mode === "both" ? "supabase.yml" : hasMigrations ? "supabase-migrations.yml" : "supabase-functions.yml";
  const jobs = [hasMigrations ? migrationsJob : "", hasFunctions ? functionsJob : ""].filter(Boolean).join("\n");

  const secretsNeeded = [
    `  1. Go to github.com → your repo → Settings → Secrets and variables → Actions`,
    `  2. Add SUPABASE_ACCESS_TOKEN — find this at supabase.com → Account → Access Tokens`,
    hasMigrations ? `  3. Add SUPABASE_DB_PASSWORD — find this at supabase.com → your project → Settings → Database → Database password` : "",
  ].filter(Boolean).join("\n");

  const whatItDoes = mode === "both"
    ? `your migrations will run and your edge functions will deploy automatically`
    : hasMigrations
    ? `your migrations will run automatically`
    : `your edge functions will deploy automatically`;

  return (
    `SUPABASE SETUP\n\n` +
    `Your Supabase ${mode === "both" ? "migrations and edge functions" : hasMigrations ? "migrations" : "edge functions"} ` +
    `don't ship automatically — you need a GitHub Actions workflow to run them when you say "ship it".\n\n` +
    `STEP 1 — Create the workflow file\n\n` +
    `Create this file in your project:\n` +
    `  .github/workflows/${fileName}\n\n` +
    `Paste this content:\n\n` +
    `name: ${workflowName}\n` +
    `on:\n` +
    `  push:\n` +
    `    branches:\n` +
    `      - ${liveBranch}\n\n` +
    `jobs:\n` +
    jobs + `\n` +
    `STEP 2 — Add your Supabase secrets to GitHub\n\n` +
    secretsNeeded + `\n\n` +
    `STEP 3 — Link your project (first time only)\n\n` +
    `If you haven't already, run this in your terminal once:\n` +
    `  supabase link --project-ref <your-project-ref>\n\n` +
    `Your project ref is in the URL: supabase.com/dashboard/project/<ref>\n\n` +
    `Once set up, every time you say "ship it", ${whatItDoes} ` +
    `and the result will show up in your Versie dashboard under deploy tracking.`
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
    `  • Render → Service Settings → Build & Deploy\n` +
    `  • Supabase → GitHub Actions workflow (say 'help with supabase setup' for a ready-to-paste workflow)\n\n` +
    `Tell me which platform you use and I'll give you exact steps.`
  );
}

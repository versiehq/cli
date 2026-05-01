#!/usr/bin/env node

// Handle installer invocation: `npx versie-cli --install`
if (process.argv[2] === "--install" || process.argv[2] === "install") {
  const { runInstaller } = await import("./install.js");
  runInstaller();
  process.exit(0);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./utils/logger.js";

import { fixThisErrorSchema, fixThisError } from "./tools/fix-this-error.js";

const server = new McpServer(
  { name: "versie", version: "1.0.0" },
  {
    instructions:
      "Versie uses CLI bash commands for all operations — always use bash. " +
      "Commands: " +
      "'versie save [\"message\"]' (save work), " +
      "'versie save-and-ship [\"description\"]' (save and go live in one step), " +
      "'versie ship [\"release notes\"]' (ship live — ONLY pass release notes if you have read the actual code changes or the user described what was built; omit otherwise and the tool auto-generates from recent saves; NEVER pass generic phrases like 'Latest changes', 'Updated files', 'Minor updates'), " +
      "'versie checkpoint [\"name\"]' (create checkpoint), " +
      "'versie status' (what's changed), " +
      "'versie go-back <target>' (return to checkpoint by name), " +
      "'versie timeline [limit]' (show save, checkpoint, and ship history), " +
      "'versie health' (check project status), " +
      "'versie setup [github-url]' (first-time project setup — run when user says set up versie or shares a GitHub SSH URL), " +
      "'versie deploy-help [platform]' (configure Vercel/Netlify/Railway/Render/Supabase for shipping — run when user says help with shipping setup), " +
      "'versie config show-git-commands on|off' (toggle showing underlying git commands), " +
      "'versie config telemetry on|off' (toggle anonymous telemetry), " +
      "'versie login' (connect to dashboard — run this command, then show the COMPLETE output including the login code to the user BEFORE doing anything else), " +
      "'versie fix \"error text\"' (fix a git error), " +
      "'versie remove --yes' (remove project from dashboard — always pass --yes since the user confirms in chat, not in terminal). " +
      "Always run versie commands from the project directory. " +
      "When the user says 'list commands', 'what can versie do', 'versie help', or similar — run `versie` (no args) in the project directory and show the output verbatim. Do not summarize or generate your own list. " +
      "Use the fix_this_error MCP tool (not versie fix) when the user pastes an error in chat — it handles multi-line errors reliably. " +
      "When a tool returns output, paste it directly as plain text — no quotes, no code blocks, no rewording. " +
      "When running any versie CLI command via bash, ALWAYS show the complete raw output to the user verbatim — never summarize, paraphrase, or shorten it, even if the output is long.",
  }
);

// Helper: wrap tool output in MCP content format and catch errors
function tool<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<string>
): (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async (args: T) => {
    try {
      const text = await fn(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      // Strip file paths from user-facing message to avoid leaking system info.
      // Full details are logged to stderr for debugging.
      const safeMsg = msg.replace(/\/[^\s:]+/g, "[path]");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Something went wrong. Please try again, or contact support@versie.co.\n\nDetails: ${safeMsg}`,
          },
        ],
      };
    }
  };
}

// Append a display instruction to every tool description.
const VERBATIM = " Paste the tool output directly into your response as plain text — no quotes, no code blocks, no rewording.";
function withVerbatim<S extends { description: string }>(schema: S): S {
  return { ...schema, description: schema.description + VERBATIM };
}

server.registerTool("fix_this_error", withVerbatim(fixThisErrorSchema), tool(fixThisError));

async function main(): Promise<void> {
  if (process.argv.includes("--install")) {
    const { runInstaller } = await import("./install.js");
    runInstaller();
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Versie MCP server started");
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./utils/logger.js";

import { saveMyWorkSchema, saveMyWork } from "./tools/save-my-work.js";
import { shipItSchema, shipIt } from "./tools/ship-it.js";
import { saveAndShipSchema, saveAndShip } from "./tools/save-and-ship.js";
import { whatsChangedSchema, whatsChanged } from "./tools/whats-changed.js";
import { goBackToSchema, goBackTo } from "./tools/go-back-to.js";
import { projectTimelineSchema, projectTimeline } from "./tools/project-timeline.js";
import { createCheckpointSchema, createCheckpointTool } from "./tools/create-checkpoint.js";
import { fixThisErrorSchema, fixThisError } from "./tools/fix-this-error.js";
import { checkHealthSchema, checkHealth } from "./tools/check-health.js";
import { listCommandsSchema, listCommands } from "./tools/list-commands.js";
import { deployPlatformHelpSchema, deployPlatformHelp } from "./tools/deploy-platform-help.js";

const server = new McpServer(
  { name: "versie", version: "1.0.0" },
  {
    instructions:
      "When a Versie tool returns output, reproduce it verbatim in your response — " +
      "do not reformat, summarize, or paraphrase it.",
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

// Append a universal output instruction to every tool description so Claude
// always displays the tool output verbatim rather than summarizing or reformatting it.
const VERBATIM = " Display the tool output verbatim in your response — do not reformat or summarize.";
function withVerbatim<S extends { description: string }>(schema: S): S {
  return { ...schema, description: schema.description + VERBATIM };
}

server.registerTool("save_my_work", withVerbatim(saveMyWorkSchema), tool(saveMyWork));
server.registerTool("ship_it", withVerbatim(shipItSchema), tool(shipIt));
server.registerTool("save_and_ship", withVerbatim(saveAndShipSchema), tool(saveAndShip));
server.registerTool("whats_changed", withVerbatim(whatsChangedSchema), tool(whatsChanged));
server.registerTool("go_back_to", withVerbatim(goBackToSchema), tool(goBackTo));
server.registerTool("project_timeline", {
  ...projectTimelineSchema,
  description: projectTimelineSchema.description +
    " Display the tool output verbatim in your response — do not reformat or summarize." +
    " Your response MUST end with exactly this line: ○ saved  ★ checkpoint  ● shipped live",
}, tool(projectTimeline));
server.registerTool("create_checkpoint", withVerbatim(createCheckpointSchema), tool(createCheckpointTool));
server.registerTool("fix_this_error", withVerbatim(fixThisErrorSchema), tool(fixThisError));
server.registerTool("check_health", withVerbatim(checkHealthSchema), tool(checkHealth));
server.registerTool("list_commands", withVerbatim(listCommandsSchema), tool(listCommands));
server.registerTool("deploy_platform_help", withVerbatim(deployPlatformHelpSchema), tool(deployPlatformHelp));

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

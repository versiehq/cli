#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./utils/logger.js";

import { saveMyWorkSchema, saveMyWork } from "./tools/save-my-work.js";
import { shipItSchema, shipIt } from "./tools/ship-it.js";
import { whatsChangedSchema, whatsChanged } from "./tools/whats-changed.js";
import { goBackToSchema, goBackTo } from "./tools/go-back-to.js";
import { projectTimelineSchema, projectTimeline } from "./tools/project-timeline.js";
import { createCheckpointSchema, createCheckpointTool } from "./tools/create-checkpoint.js";
import { fixThisErrorSchema, fixThisError } from "./tools/fix-this-error.js";
import { checkHealthSchema, checkHealth } from "./tools/check-health.js";
import { listCommandsSchema, listCommands } from "./tools/list-commands.js";
import { deployPlatformHelpSchema, deployPlatformHelp } from "./tools/deploy-platform-help.js";

const server = new McpServer({
  name: "versie",
  version: "1.0.0",
});

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

server.registerTool("save_my_work", saveMyWorkSchema, tool(saveMyWork));
server.registerTool("ship_it", shipItSchema, tool(shipIt));
server.registerTool("whats_changed", whatsChangedSchema, tool(whatsChanged));
server.registerTool("go_back_to", goBackToSchema, tool(goBackTo));
server.registerTool("project_timeline", projectTimelineSchema, tool(projectTimeline));
server.registerTool("create_checkpoint", createCheckpointSchema, tool(createCheckpointTool));
server.registerTool("fix_this_error", fixThisErrorSchema, tool(fixThisError));
server.registerTool("check_health", checkHealthSchema, tool(checkHealth));
server.registerTool("list_commands", listCommandsSchema, tool(listCommands));
server.registerTool("deploy_platform_help", deployPlatformHelpSchema, tool(deployPlatformHelp));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Versie MCP server started");
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

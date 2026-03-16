import { z } from "zod/v4";
import { checkFirstRun, resolveWorkingDir } from "../git/branches.js";
import { saveMyWork } from "./save-my-work.js";
import { shipIt } from "./ship-it.js";

export const saveAndShipSchema = {
  description:
    "Say 'save and ship' or 'save and deploy' to save your work and go live in one step.",
  inputSchema: z.object({
    description: z
      .string()
      .optional()
      .describe("Optional short description of what you changed."),
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the project. Use the current workspace folder path. Only ask the user if the path cannot be determined from context."),
  }),
};

export async function saveAndShip(args: z.infer<typeof saveAndShipSchema.inputSchema>): Promise<string> {
  const repoPath = await resolveWorkingDir(args.repo_path);
  const welcome = await checkFirstRun(repoPath);
  if (welcome) return welcome;

  // Save first (ship_it also saves internally, but we want the save message)
  const saveMsg = await saveMyWork({ description: args.description, repo_path: repoPath });
  // Ship (uncommitted changes are already gone, so ship_it skips its internal save)
  const shipMsg = await shipIt({ repo_path: repoPath });

  // If there was nothing to save, just return the ship result
  if (saveMsg.startsWith("Everything is already saved")) {
    return shipMsg;
  }
  return `${saveMsg}\n\n${shipMsg}`;
}

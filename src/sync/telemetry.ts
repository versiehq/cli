import { PostHog } from "posthog-node";

export type TelemetryEvent =
  | "save_my_work"
  | "ship_it"
  | "go_back_to"
  | "create_checkpoint"
  | "fix_this_error"
  | "check_health"
  | "first_run";

const ENABLED = process.env.VERSIE_TELEMETRY !== "false";
const TOKEN = process.env.POSTHOG_PROJECT_TOKEN;
const HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

// Lazy-init so the client is only created when telemetry is active
let _client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!ENABLED || !TOKEN) return null;
  if (!_client) {
    _client = new PostHog(TOKEN, {
      host: HOST,
      // Flush immediately — MCP server may exit before the default batch window
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

export function track(event: TelemetryEvent, props?: Record<string, unknown>): void {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({
      distinctId: "anonymous",
      event,
      properties: {
        ...props,
        versie_version: process.env.npm_package_version ?? "unknown",
      },
    });
  } catch {
    // Never let telemetry errors surface to the user
  }
}

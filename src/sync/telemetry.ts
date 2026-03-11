/**
 * Phase B stub — telemetry will be implemented when Supabase integration is added.
 * All calls are no-ops in Phase A.
 */

export type TelemetryEvent =
  | "save_my_work"
  | "ship_it"
  | "go_back_to"
  | "create_checkpoint"
  | "fix_this_error"
  | "check_health"
  | "first_run";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function track(_event: TelemetryEvent, _props?: Record<string, unknown>): void {
  // no-op in Phase A
}

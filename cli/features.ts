/**
 * cli/features.ts — How the mpt CLI reflects the team's feature toggles.
 *
 * A team can switch Stories, Tasks (incl. Templates), and Schedules off
 * (docs/DESIGN.md "Feature Toggles"); `GET /api/status` reports which are on.
 * The CLI has no commands that create or edit work items — that's the web UI
 * and the Pi tools — so its part is reporting: `mpt status` leaves out a
 * switched-off kind's counts and says what's off, and any daemon refusal is
 * worded the same way the Pi tools word it (`featureDisabledMessage`, shared
 * with harnesses/pi so the fix — "enable it in Config" — reads identically).
 * A future work-item command should gate on `featuresFromStatus` up front and
 * exit non-zero with `featureDisabledMessage`, with `daemonErrorMessage` as the
 * backstop for the daemon's 403.
 */

import { FEATURE_NAMES, featureDisabledMessage, featuresFromStatus } from "../harnesses/pi/src/runtime/client.ts";
import type { FeatureName } from "../shared/types.ts";

export { featureDisabledMessage };

/** The parts of `GET /api/status` that `mpt status` prints. */
export interface StatusSummaryInput {
  stories: { open: number; done: number; total: number };
  tasks: { total: number };
  members: { total: number; working: number; idle: number };
  /** Absent from daemons that predate the toggles: all on. */
  features?: Partial<Record<FeatureName, boolean>>;
}

/**
 * The summary lines `mpt status` prints (without indentation). A switched-off
 * kind's count is left out — it would be a number for something the team doesn't
 * use — and a final line names what's off and where to turn it back on.
 */
export function statusSummaryLines(data: StatusSummaryInput): string[] {
  const features = featuresFromStatus(data);
  const lines: string[] = [];
  if (features.stories) {
    lines.push(`Stories: ${data.stories.open} open, ${data.stories.done} done (${data.stories.total} total)`);
  }
  lines.push(`Tasks: ${data.tasks.total} total`);
  lines.push(`Members: ${data.members.total} (${data.members.working} working, ${data.members.idle} idle)`);
  const off = FEATURE_NAMES.filter((f) => !features[f]);
  if (off.length > 0) lines.push(`Turned off: ${off.join(", ")} (Config → General → Work items)`);
  return lines;
}

/**
 * A readable message for a failed daemon response: a feature-toggle refusal
 * (403 `{ feature }`) becomes `featureDisabledMessage`, anything else the body's
 * `error` or the bare status.
 */
export function daemonErrorMessage(status: number, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; feature?: unknown };
  if (status === 403 && (FEATURE_NAMES as readonly unknown[]).includes(b.feature)) {
    return featureDisabledMessage(b.feature as FeatureName);
  }
  return typeof b.error === "string" && b.error ? b.error : `HTTP ${status}`;
}

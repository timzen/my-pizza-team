/**
 * shared/poll-config.ts — The one rule for a teammate state's completion fields
 * (`completion`, `pollEvery`, `pollTimeout`, `onTimeout`; docs/DESIGN.md
 * "Polling States").
 *
 * The daemon's `validateWorkflow` (daemon/workflow-engine.ts) refuses a save
 * with it, and the web UI's workflow editor (ui/src/lib/workflow-poll.ts) runs
 * the same check as you type — so the editor can never accept a value the
 * daemon would refuse, nor refuse one it would take. Pure and import-light (no
 * `node:` imports) so both sides can load it.
 */

import { MIN_POLL_EVERY, type WorkflowState } from "./types.ts";
import { parseDuration } from "./duration.ts";

/** A completion field a poll-state check can blame (`completion` covers the mode itself). */
export type PollConfigField = "completion" | "pollEvery" | "pollTimeout" | "onTimeout";

/** Why a state's completion fields are refused: the field at fault and the daemon's message. */
export interface PollConfigError {
  field: PollConfigField;
  message: string;
}

/**
 * Why a teammate state's completion fields are refused, or null. Manual states
 * aren't judged: they have no WorkItem, so the fields are ignored there (with a
 * load warning — `ignoredStateFields`), like a persona.
 */
export function pollConfigError(s: Pick<WorkflowState, "type" | PollConfigField>): PollConfigError | null {
  if (s.type !== "teammate") return null;
  const { completion, pollEvery, pollTimeout, onTimeout } = s;
  if (completion !== undefined && completion !== "once" && completion !== "poll") {
    return { field: "completion", message: `completion must be "once" or "poll"` };
  }
  if (completion !== "poll") {
    // A poll field on a once state would silently do nothing: say so.
    const stray = (["pollEvery", "pollTimeout", "onTimeout"] as const).filter((f) => s[f] !== undefined);
    return stray.length > 0 ? { field: stray[0]!, message: `${stray.join(", ")} only apply with completion "poll"` } : null;
  }
  const minMs = parseDuration(MIN_POLL_EVERY)!;
  const everyMs = parseDuration(pollEvery);
  if (pollEvery === undefined) return { field: "pollEvery", message: `completion "poll" needs pollEvery (a duration such as "15m")` };
  if (everyMs === null) return { field: "pollEvery", message: `pollEvery must be a duration such as "15m" (got ${JSON.stringify(pollEvery)})` };
  if (everyMs < minMs) return { field: "pollEvery", message: `pollEvery must be at least ${MIN_POLL_EVERY}` };
  if (pollTimeout !== undefined) {
    const timeoutMs = parseDuration(pollTimeout);
    if (timeoutMs === null) return { field: "pollTimeout", message: `pollTimeout must be a duration such as "7d" (got ${JSON.stringify(pollTimeout)})` };
    if (timeoutMs < everyMs) return { field: "pollTimeout", message: "pollTimeout must be at least pollEvery" };
  }
  if (onTimeout !== undefined && onTimeout !== "fail" && onTimeout !== "manual") {
    return { field: "onTimeout", message: `onTimeout must be "fail" or "manual"` };
  }
  return null;
}

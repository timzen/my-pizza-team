/**
 * daemon/workflow-engine.ts — Workflow position logic for the state model
 *
 * A workflow is an ordered list of active states between the implicit `todo`
 * and `done` buckets (see docs/DESIGN.md "The Work Model"). There is no transition matrix: this module answers
 * position questions (what's active, what's next, is this a teammate state, is
 * it a poll state — docs/DESIGN.md "Polling States") and
 * the store applies the two mechanical rules (advance, admission). Humans may
 * move tasks anywhere, so there is no permission checking here either.
 */

import {
  type PollTimeoutAction,
  type WorkflowConfig,
  type WorkflowState,
  DEFAULT_POLL_ON_TIMEOUT,
  DEFAULT_POLL_TIMEOUT,
  DONE_STATE,
  MIN_POLL_EVERY,
  TODO_STATE,
} from "../shared/types.ts";
import { parseDuration } from "../shared/duration.ts";

/** Names of a workflow's active states, in order. */
export function activeStateNames(wf: WorkflowConfig): string[] {
  return wf.states.map((s) => s.name);
}

/** Is this status one of the workflow's active states (not a bucket)? */
export function isActiveState(wf: WorkflowConfig, status: string): boolean {
  return wf.states.some((s) => s.name === status);
}

/** Is this status an active state worked by teammates (claim protocol applies)? */
export function isTeammateState(wf: WorkflowConfig, status: string): boolean {
  return wf.states.some((s) => s.name === status && s.type === "teammate");
}

/** The first active state (where admission places tasks), or null for an empty workflow. */
export function firstActiveState(wf: WorkflowConfig): string | null {
  return wf.states[0]?.name ?? null;
}

/**
 * The state a task advances to when completed in `status`: the next active
 * state in order, or the `done` bucket after the last one. Buckets and unknown
 * states advance to `done` (defensive — the store never asks for those).
 */
export function nextState(wf: WorkflowConfig, status: string): string {
  const idx = wf.states.findIndex((s) => s.name === status);
  if (idx < 0) return DONE_STATE;
  return wf.states[idx + 1]?.name ?? DONE_STATE;
}

/** Board columns: the implicit buckets around the active states. */
export function boardColumns(wf: WorkflowConfig): string[] {
  return [TODO_STATE, ...activeStateNames(wf), DONE_STATE];
}

/** Is this a valid position (bucket or active state) for a task in this workflow? */
export function isValidPosition(wf: WorkflowConfig, status: string): boolean {
  return status === TODO_STATE || status === DONE_STATE || isActiveState(wf, status);
}

/**
 * Validate a workflow config: at least the right shape, no reserved names,
 * no duplicates, and a teammate state's completion fields well-formed
 * (`stateCompletionError`). Returns an error string, or null when valid.
 */
export function validateWorkflow(wf: WorkflowConfig): string | null {
  if (!Array.isArray(wf.states)) return "Workflow must have a 'states' array";
  const seen = new Set<string>();
  for (const s of wf.states) {
    if (!s || typeof s.name !== "string" || !s.name) return "Every state needs a 'name'";
    if (s.type !== "teammate" && s.type !== "manual") return `State "${s.name}" needs type "teammate" or "manual"`;
    if (s.name === TODO_STATE || s.name === DONE_STATE) return `State name "${s.name}" is reserved (implicit bucket)`;
    if (seen.has(s.name)) return `Duplicate state name "${s.name}"`;
    seen.add(s.name);
    const completion = stateCompletionError(s);
    if (completion) return `State "${s.name}": ${completion}`;
  }
  return null;
}

/** The completion fields of a workflow state (docs/DESIGN.md "Polling States"). */
const COMPLETION_FIELDS = ["completion", "pollEvery", "pollTimeout", "onTimeout"] as const;

/**
 * Why a teammate state's completion fields are refused, or null. Manual
 * states aren't judged: they have no WorkItem, so the fields are ignored
 * there (with a load warning — `ignoredStateFields`), like a persona.
 */
function stateCompletionError(s: WorkflowState): string | null {
  if (s.type !== "teammate") return null;
  const { completion, pollEvery, pollTimeout, onTimeout } = s;
  if (completion !== undefined && completion !== "once" && completion !== "poll") {
    return `completion must be "once" or "poll"`;
  }
  if (completion !== "poll") {
    // A poll field on a once state would silently do nothing: say so.
    const stray = (["pollEvery", "pollTimeout", "onTimeout"] as const).filter((f) => s[f] !== undefined);
    return stray.length > 0 ? `${stray.join(", ")} only apply with completion "poll"` : null;
  }
  const minMs = parseDuration(MIN_POLL_EVERY)!;
  const everyMs = parseDuration(pollEvery);
  if (pollEvery === undefined) return `completion "poll" needs pollEvery (a duration such as "15m")`;
  if (everyMs === null) return `pollEvery must be a duration such as "15m" (got ${JSON.stringify(pollEvery)})`;
  if (everyMs < minMs) return `pollEvery must be at least ${MIN_POLL_EVERY}`;
  if (pollTimeout !== undefined) {
    const timeoutMs = parseDuration(pollTimeout);
    if (timeoutMs === null) return `pollTimeout must be a duration such as "7d" (got ${JSON.stringify(pollTimeout)})`;
    if (timeoutMs < everyMs) return "pollTimeout must be at least pollEvery";
  }
  if (onTimeout !== undefined && onTimeout !== "fail" && onTimeout !== "manual") {
    return `onTimeout must be "fail" or "manual"`;
  }
  return null;
}

/**
 * The completion fields a state sets that do nothing there — any of them on a
 * manual state (no teammate runs it). The workflow loader logs a warning for
 * each, as it does for a manual state's persona.
 */
export function ignoredStateFields(s: WorkflowState): string[] {
  if (s.type !== "manual") return [];
  return COMPLETION_FIELDS.filter((f) => s[f] !== undefined);
}

/** A poll state's settings with the defaults applied (durations in milliseconds). */
export interface PollSettings {
  pollEveryMs: number;
  pollTimeoutMs: number;
  onTimeout: PollTimeoutAction;
}

/**
 * The poll settings of `status` when it is a teammate state with
 * `completion: "poll"`, else null — a once state, a manual state (its poll
 * fields ignored), a bucket, or an unknown state. Assumes a validated workflow.
 */
export function pollSettings(wf: WorkflowConfig, status: string): PollSettings | null {
  const s = wf.states.find((st) => st.name === status);
  if (!s || s.type !== "teammate" || s.completion !== "poll") return null;
  const pollEveryMs = parseDuration(s.pollEvery);
  if (pollEveryMs === null) return null;
  return {
    pollEveryMs,
    pollTimeoutMs: parseDuration(s.pollTimeout ?? DEFAULT_POLL_TIMEOUT) ?? parseDuration(DEFAULT_POLL_TIMEOUT)!,
    onTimeout: s.onTimeout ?? DEFAULT_POLL_ON_TIMEOUT,
  };
}

/** Is this status a poll state (a teammate state with `completion: "poll"`)? */
export function isPollState(wf: WorkflowConfig, status: string): boolean {
  return pollSettings(wf, status) !== null;
}

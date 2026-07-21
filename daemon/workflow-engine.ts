/**
 * daemon/workflow-engine.ts — Workflow position logic for the state/substatus
 * work model (see docs/WORK-MODEL.md).
 *
 * A workflow is an ordered list of active states between the implicit `todo`
 * and `done` buckets. There is no transition matrix: this module answers
 * position questions (what's active, what's next, is this an agent state) and
 * the store applies the two mechanical rules (advance, admission). Humans may
 * move tasks anywhere, so there is no permission checking here either.
 */

import { type WorkflowConfig, TODO_STATE, DONE_STATE, type TaskSubstatus } from "../shared/types.ts";

/** Names of a workflow's active states, in order. */
export function activeStateNames(wf: WorkflowConfig): string[] {
  return wf.states.map((s) => s.name);
}

/** Is this status one of the workflow's active states (not a bucket)? */
export function isActiveState(wf: WorkflowConfig, status: string): boolean {
  return wf.states.some((s) => s.name === status);
}

/** Is this status an active state worked by agents (claim protocol applies)? */
export function isAgentState(wf: WorkflowConfig, status: string): boolean {
  return wf.states.some((s) => s.name === status && s.type === "agent");
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

/**
 * The substatus a task carries on entering `status`: `ready` for agent states,
 * null for manual states and buckets. Applied on every entry — admission,
 * mechanical advance, and judgment moves alike — so re-entry ≡ first entry.
 */
export function entrySubstatus(wf: WorkflowConfig, status: string): TaskSubstatus | null {
  return isAgentState(wf, status) ? "ready" : null;
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
 * no duplicates. Returns an error string, or null when valid.
 */
export function validateWorkflow(wf: WorkflowConfig): string | null {
  if (!Array.isArray(wf.states)) return "Workflow must have a 'states' array";
  const seen = new Set<string>();
  for (const s of wf.states) {
    if (!s || typeof s.name !== "string" || !s.name) return "Every state needs a 'name'";
    if (s.type !== "agent" && s.type !== "manual") return `State "${s.name}" needs type "agent" or "manual"`;
    if (s.name === TODO_STATE || s.name === DONE_STATE) return `State name "${s.name}" is reserved (implicit bucket)`;
    if (seen.has(s.name)) return `Duplicate state name "${s.name}"`;
    seen.add(s.name);
  }
  return null;
}

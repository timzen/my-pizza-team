/**
 * daemon/workflow-engine.ts — Centralized workflow transition logic.
 *
 * All workflow state machine decisions live here. Route handlers and the store
 * call into this module rather than reimplementing transition rules inline.
 *
 * Key concepts:
 * - **Initial state**: The first state in the workflow (where new tasks start).
 *   Claim transitions OUT of this state into the working state.
 * - **Working state**: Any non-initial state with a "teammate" exit. The agent
 *   works here and releases to advance. If the lead sends a task back here,
 *   claim just assigns without transitioning.
 * - **Gate state**: A state with only "lead" exits (e.g., review). Agents can't
 *   work here; the lead must move the task forward or back.
 * - **Done state**: The terminal state (last in the states array or explicit doneState).
 */

import { type WorkflowConfig, type TransitionPermission, getInitialState, getDoneState } from "../shared/types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Role = "lead" | "teammate";

export interface ClaimTarget {
  /** The state the task will be in after claim. Same as current if no transition needed. */
  targetStatus: string;
  /** Whether claim actually transitions (true) or just assigns (false). */
  transitions: boolean;
}

export interface ReleaseTarget {
  /** The state the task advances to on release. */
  targetStatus: string;
  /** Whether the task has reached the done state. */
  completed: boolean;
}

export interface TransitionCheck {
  ok: boolean;
  error?: string;
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Determine what happens when an agent claims a task.
 *
 * - From the initial state: transitions to the first teammate/any exit (enters working state).
 * - From any other state with a teammate exit: just assigns, no transition (already working).
 * - Returns null if the task can't be claimed from its current state.
 */
export function getClaimTarget(wf: WorkflowConfig, currentStatus: string): ClaimTarget | null {
  const initialState = getInitialState(wf);
  const transitions = wf.transitions[currentStatus] || {};

  if (currentStatus === initialState) {
    // From initial state: find first teammate/any exit to transition into
    const target = findFirstTeammateExit(transitions);
    if (!target) return null;
    return { targetStatus: target, transitions: true };
  } else {
    // From non-initial state: verify it has a teammate exit (agent can release from here)
    const hasTeammateExit = Object.values(transitions).some(
      perm => perm === "teammate" || perm === "any"
    );
    if (!hasTeammateExit) return null;
    return { targetStatus: currentStatus, transitions: false };
  }
}

/**
 * Determine what state a task advances to when an agent releases it.
 *
 * Picks the first transition with "teammate" or "any" permission.
 * Falls back to the first transition of any kind if none match.
 * Returns null if there are no transitions from the current state.
 */
export function getReleaseTarget(wf: WorkflowConfig, currentStatus: string): ReleaseTarget | null {
  const transitions = wf.transitions[currentStatus] || {};
  const entries = Object.entries(transitions);
  if (entries.length === 0) return null;

  // Prefer teammate/any exits
  let targetStatus: string | null = findFirstTeammateExit(transitions);
  // Fall back to first available transition
  if (!targetStatus) targetStatus = entries[0]![0];

  const doneState = getDoneState(wf);
  return { targetStatus, completed: targetStatus === doneState };
}

/**
 * Check whether a specific transition is allowed for a given role.
 *
 * Used by lead moves (task board) and explicit status updates.
 */
export function canTransition(
  wf: WorkflowConfig,
  currentStatus: string,
  targetStatus: string,
  role: Role,
): TransitionCheck {
  const transitions = wf.transitions[currentStatus];
  if (!transitions) {
    return { ok: false, error: `No transitions from state "${currentStatus}"` };
  }

  const permission = transitions[targetStatus];
  if (!permission) {
    return { ok: false, error: `Cannot transition from "${currentStatus}" to "${targetStatus}"` };
  }

  if (permission === "any") return { ok: true };
  if (permission === role) return { ok: true };
  return { ok: false, error: `Transition "${currentStatus}" → "${targetStatus}" requires "${permission}", got "${role}"` };
}

/**
 * Determine what state the task will exit to on release (for guidance messages).
 *
 * Given the state the agent will be working in, returns the state they'll
 * advance to when they release. Returns null if no exit is available.
 */
export function getExitState(wf: WorkflowConfig, workingStatus: string): string | null {
  const transitions = wf.transitions[workingStatus] || {};
  const entries = Object.entries(transitions);
  if (entries.length === 0) return null;

  // Prefer teammate/any exits (same logic as release)
  return findFirstTeammateExit(transitions) || entries[0]![0];
}

/**
 * Check if a task in the given state is workable by an agent.
 *
 * A task is workable if:
 * - It's in the initial state AND the target state (after claim) has a teammate exit, OR
 * - It's NOT in the initial state AND the current state has a teammate exit.
 */
export function isWorkableByAgent(wf: WorkflowConfig, currentStatus: string): boolean {
  const claimTarget = getClaimTarget(wf, currentStatus);
  if (!claimTarget) return false;

  if (claimTarget.transitions) {
    // Claiming from initial state — verify the target state has a teammate exit for release
    const targetTransitions = wf.transitions[claimTarget.targetStatus] || {};
    return Object.values(targetTransitions).some(p => p === "teammate" || p === "any");
  }

  // Already in a working state — getClaimTarget already verified it has teammate exits
  return true;
}

/**
 * Check if the given status is the done/terminal state for this workflow.
 */
export function isDone(wf: WorkflowConfig, status: string): boolean {
  return status === getDoneState(wf);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find the first transition target with "teammate" or "any" permission. */
function findFirstTeammateExit(transitions: Record<string, TransitionPermission>): string | null {
  for (const [toState, perm] of Object.entries(transitions)) {
    if (perm === "teammate" || perm === "any") return toState;
  }
  return null;
}

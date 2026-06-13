// Shared types for the pi-pizza-team extension
//
// This is a minimal subset — the daemon owns the full type definitions.
// The extension only needs enough to configure itself and understand
// workflow shapes received from the daemon API.

/** Workflow configuration (received from daemon) */
export interface WorkflowConfig {
  states: string[];
  transitions: Record<string, Record<string, TransitionPermission>>;
  initialState?: string;
  doneState?: string;
  instructions?: Record<string, string>;
}

export type TransitionPermission = "any" | "teammate" | "lead";

/** Team directory names (current and legacy) */
export const TEAM_DIR = ".my-pizza-team";
export const LEGACY_TEAM_DIR = ".pi-pizza-team";

/** Default daemon URL */
export const DEFAULT_DAEMON_URL = "http://localhost:7437";

/** Get the initial state for a workflow (first state unless overridden) */
export function getInitialState(wf: WorkflowConfig): string {
  return wf.initialState || wf.states[0];
}

/** Get the done/terminal state for a workflow (last state unless overridden) */
export function getDoneState(wf: WorkflowConfig): string {
  return wf.doneState || wf.states[wf.states.length - 1];
}

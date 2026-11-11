/**
 * lib/workflow-poll.ts — The workflow editor's completion controls for a
 * teammate state (docs/DESIGN.md "Polling States"), as pure functions
 * (tested in tests/workflow-poll-ui.test.ts).
 *
 * A teammate state is **Single run** (`completion` unset or `"once"`, the
 * default) or **Poll until complete** (`completion: "poll"` with `pollEvery`,
 * an optional `pollTimeout` and `onTimeout`). The editor edits those fields on
 * its in-memory states and saves the whole workflow through the usual
 * `PUT /api/config`. Validation is the daemon's own rule
 * (shared/poll-config.ts `pollConfigError`), so the editor refuses exactly
 * what the save would.
 */

import type { PollTimeoutAction, WorkflowState, WorkflowStateCompletion } from "@shared/types";
import { pollConfigError, type PollConfigError } from "../../../shared/poll-config.ts";
import { DEFAULT_POLL_ON_TIMEOUT, DEFAULT_POLL_TIMEOUT, MIN_POLL_EVERY } from "../../../shared/types.ts";

export { DEFAULT_POLL_ON_TIMEOUT, DEFAULT_POLL_TIMEOUT, MIN_POLL_EVERY };

/** The interval a state gets when you switch it to Poll (editable at once). */
export const DEFAULT_POLL_EVERY = "15m";

/** The completion fields, which only mean something on a poll state. */
const POLL_FIELDS = ["pollEvery", "pollTimeout", "onTimeout"] as const;

/** Is this a teammate state that polls (`completion: "poll"`)? Manual states never do. */
export function isPollingState(s: Pick<WorkflowState, "type" | "completion">): boolean {
  return s.type === "teammate" && s.completion === "poll";
}

/**
 * `s` with its completion mode set. Single run drops `completion` and the poll
 * fields (unset means once, so a once state saves exactly as before); Poll sets
 * `completion: "poll"` and a starting `pollEvery` if it has none.
 */
export function withCompletion(s: WorkflowState, completion: WorkflowStateCompletion): WorkflowState {
  if (completion === "poll") return { ...s, completion: "poll", pollEvery: s.pollEvery ?? DEFAULT_POLL_EVERY };
  const next: WorkflowState = { ...s };
  delete next.completion;
  for (const f of POLL_FIELDS) delete next[f];
  return next;
}

/**
 * `s` with one poll field set from its input. An empty `pollTimeout` or
 * `onTimeout` drops the field (the daemon's default applies); an empty
 * `pollEvery` drops it too, which validation then refuses (poll needs one).
 */
export function withPollField(s: WorkflowState, field: "pollEvery" | "pollTimeout", value: string): WorkflowState;
export function withPollField(s: WorkflowState, field: "onTimeout", value: PollTimeoutAction | ""): WorkflowState;
export function withPollField(s: WorkflowState, field: (typeof POLL_FIELDS)[number], value: string): WorkflowState {
  const next: WorkflowState = { ...s };
  const v = value.trim();
  if (v === "") delete next[field];
  else if (field === "onTimeout") next.onTimeout = v as PollTimeoutAction;
  else next[field] = v;
  return next;
}

/**
 * `s` as a manual state: the type flips and the completion fields go (a manual
 * state has no teammate, so they would only earn a load warning).
 */
export function asManual(s: WorkflowState): WorkflowState {
  return { ...withCompletion(s, "once"), type: "manual" };
}

/**
 * Each state's completion error by state name (the daemon's rule and message),
 * only for states that have one. An empty result means the save may go ahead.
 */
export function workflowPollErrors(states: readonly WorkflowState[]): Record<string, PollConfigError> {
  const out: Record<string, PollConfigError> = {};
  for (const s of states) {
    const err = pollConfigError(s);
    if (err) out[s.name] = err;
  }
  return out;
}

/** A poll state's rhythm in words, for its badge's tooltip: "Checks every 15m, up to 7d; then needs attention". */
export function pollSummary(s: Pick<WorkflowState, "pollEvery" | "pollTimeout" | "onTimeout">): string {
  const then = (s.onTimeout ?? DEFAULT_POLL_ON_TIMEOUT) === "fail" ? "fails" : "needs attention";
  return `Checks every ${s.pollEvery ?? "?"}, up to ${s.pollTimeout ?? DEFAULT_POLL_TIMEOUT}; then ${then}`;
}

/**
 * A completion error worded for the editor: the daemon's message with its
 * field names read as the editor's labels ("the interval must be at least 1m").
 */
export function pollErrorText(err: PollConfigError): string {
  const text = err.message
    .replace(/completion "poll" needs pollEvery/, "Poll needs an interval")
    .replace(/\bpollEvery\b/g, "the interval")
    .replace(/\bpollTimeout\b/g, "the time limit")
    .replace(/\bonTimeout\b/g, "on timeout");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

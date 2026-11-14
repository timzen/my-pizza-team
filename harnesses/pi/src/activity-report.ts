// Activity for the stall check — what this Pi is doing (no run, waiting on the
// model, or which tool since when) and when it last made progress — sent with
// every heartbeat, by the teammate and the leader alike (my-pizza-team
// docs/DESIGN.md "Stalled Teammates").
//
// The one wiring of runtime/activity.ts's ActivityTracker to Pi's events: a
// run starting and ending (agent_start / agent_end), each model turn ending
// (turn_end), and each tool call starting and ending (tool_execution_start /
// tool_execution_end). Its own pi.on registrations, so it never shares a
// handler with the work loop or the chat mirror. The tracker comes in from the
// caller (a type-only import here), so the tests load this module under plain
// Node with a tracker on a fake clock.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActivityTracker } from "./runtime/activity.js";

/** Hook `tracker` onto `pi`'s run and tool lifecycle; read its `report()` at each heartbeat. */
export function attachActivity(pi: ExtensionAPI, tracker: ActivityTracker): ActivityTracker {
  pi.on("agent_start", async () => { tracker.runStarted(); });
  pi.on("turn_end", async () => { tracker.turnEnded(); });
  pi.on("tool_execution_start", async (event) => { tracker.toolStarted(event.toolCallId, event.toolName, event.args); });
  pi.on("tool_execution_end", async (event) => { tracker.toolEnded(event.toolCallId); });
  pi.on("agent_end", async () => { tracker.runEnded(); });
  return tracker;
}

/**
 * lib/stall.ts — What the UI says about a stalled teammate (docs/DESIGN.md
 * "Stalled Teammates"): alive and working on a claimed item, but nothing has
 * completed — no model turn, no tool call — for longer than its threshold.
 *
 * The daemon decides who is stalled (`AgentView.stalled`, computed on read);
 * these only word it, with an explicit `now` so they are unit-tested
 * (tests/stall-ui.test.ts):
 *
 *   - `stallStatusText` — the Team tab row's status tooltip and the status
 *     icon's name, in place of "Working": "Stalled 13h — bash: node --test …";
 *   - `stallCallout` — the teammate page's callout: how long, what it is
 *     running and since when, when progress last happened;
 *   - `interruptState` — what the callout says about the Interrupt action
 *     (unsupported → Pair; sent, failed).
 */

import type { AgentActivity, AgentStall, AgentView, InterruptView } from "@shared/protocol";
import { formatStallDuration } from "../../../shared/stall.ts";

/** What a stalled agent is running, as the row's tooltip words it: `bash: node --test …`, `bash`, `waiting on the model`. */
export function stallActivityText(activity: AgentActivity | null): string {
  if (!activity) return "no activity reported";
  if (activity.state === "tool") {
    const tool = activity.tool || "a tool";
    return activity.preview ? `${tool}: ${activity.preview}` : tool;
  }
  return activity.state === "model" ? "waiting on the model" : "idle";
}

/** The row's status text while stalled: "Stalled 13h — bash: node --test …". */
export function stallStatusText(stall: AgentStall, now: number): string {
  return `Stalled ${formatStallDuration(now - stall.since)} — ${stallActivityText(stall.activity)}`;
}

/** A time of day, short (the callout's "since 03:12"). */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The teammate page's callout, in parts. */
export interface StallCallout {
  /** "Stalled for 13h" */
  title: string;
  /** The tool and its preview (``bash `node --test …` ``), or what it is waiting on; null when it reports nothing. */
  running: string | null;
  /** "since 03:12" — when the current tool or model call started, if reported. */
  runningSince: string | null;
  /** "No progress since 03:12 (stall threshold 30m)." */
  lastProgress: string;
}

/** Word a stall for the teammate page (`format` renders a time; default: the browser's short time of day). */
export function stallCallout(stall: AgentStall, now: number, format: (ms: number) => string = clock): StallCallout {
  const a = stall.activity;
  const running = !a ? null
    : a.state === "tool" ? (a.preview ? `${a.tool || "a tool"} \`${a.preview}\`` : a.tool || "a tool")
    : a.state === "model" ? "waiting on the model" : null;
  return {
    title: `Stalled for ${formatStallDuration(now - stall.since)}`,
    running,
    runningSince: a && a.state !== "idle" ? `since ${format(a.since)}` : null,
    lastProgress: `No progress since ${format(stall.since)} (stall threshold ${formatStallDuration(stall.stallMinutes * 60_000)}).`,
  };
}

/** What the callout's Interrupt says and allows. */
export type InterruptState =
  | { kind: "unsupported"; text: string }
  | { kind: "ready" }
  | { kind: "sent"; text: string }
  | { kind: "failed"; text: string };

/** The Pair pointer for a harness that can't interrupt (also the 409's sense). */
export const INTERRUPT_UNSUPPORTED_TEXT = "Interrupt isn't supported by this teammate's harness. Pair with it to stop the command from its terminal.";

/**
 * The Interrupt action's state for an agent: unsupported (an older harness —
 * suggest Pair), sent (a pending ask, or done since this stall began — the
 * teammate was nudged), failed (the latest ask since the stall began, with its
 * reason), else ready.
 */
export function interruptState(agent: Pick<AgentView, "interruptSupported" | "lastInterrupt">, stall: AgentStall | null): InterruptState {
  if (!agent.interruptSupported) return { kind: "unsupported", text: INTERRUPT_UNSUPPORTED_TEXT };
  const last: InterruptView | null = agent.lastInterrupt ?? null;
  if (last?.status === "pending") return { kind: "sent", text: "Interrupt sent — waiting for the teammate to stop the command." };
  // Only an ask made during this stall speaks for it.
  const current = last && stall && Date.parse(last.createdAt) >= stall.since ? last : null;
  if (current?.status === "done") return { kind: "sent", text: "Interrupted — the teammate was asked to find out why the command hung." };
  if (current?.status === "failed") return { kind: "failed", text: `Interrupt failed: ${current.error || "the teammate couldn't interrupt its run"}.` };
  return { kind: "ready" };
}

// GENERATED FILE — do not edit.
//
// Copied verbatim by scripts/sync-shared.ts from the repo root's runtime/activity.ts,
// the single definition of this harness-agnostic module (agent/ and cli/ import
// it from there). Edit it there and run `npm run sync-shared`; `npm run check`
// and the test suites fail if the two drift.
//
// Copied rather than imported because the extension is a self-contained package:
// `mpt setup` writes it to a managed directory outside this repo.

// Activity: what this agent is doing right now — no run, waiting on the model,
// or running a tool (which one, since when, and a short view of its input) —
// and when it last made progress. Sent with every heartbeat (DaemonClient
// `heartbeat`), so the daemon can flag a teammate that is alive but stuck: its
// heartbeat stays fresh while a hung test sleeps for hours (my-pizza-team
// docs/DESIGN.md "Stalled Teammates").
//
// Harness-agnostic: a harness feeds `ActivityTracker` its run and tool
// lifecycle (for Pi, harnesses/pi/src/activity-report.ts) and reads
// `report()` at each heartbeat. The clock is injected, so it's unit-tested
// on a fake one (tests/activity.test.ts).

import { cleanActivityPreview, type AgentActivity, type AgentActivityReport } from "../shared/agent-protocol.ts";

/**
 * The input fields worth previewing, in the order they are tried: what a
 * person would recognize the call by (the command, the path, the pattern).
 * Never a file's contents — `content`, `newText` and the like are not here.
 */
const PREVIEW_FIELDS = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "label", "name"] as const;

/**
 * A short, single-line, redacted view of a tool call's input
 * (`cleanActivityPreview`): bash's command, a file tool's path, a search's
 * pattern. Undefined when the input has none of the `PREVIEW_FIELDS` (the tool
 * name alone then says what's running).
 */
export function toolPreview(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  for (const field of PREVIEW_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return cleanActivityPreview(value);
  }
  return undefined;
}

/** A tool call in flight. */
interface RunningTool {
  tool: string;
  since: number;
  preview?: string;
}

/**
 * Tracks one agent's activity from its run and tool lifecycle. Progress is a
 * model turn or a tool call completing, or a run starting or ending; a tool
 * that never returns makes none, which is what the daemon's stall rule looks for.
 *
 * Tools may run in parallel: while any is in flight the activity is the
 * longest-running one (the likeliest to be stuck).
 */
export class ActivityTracker {
  private readonly now: () => number;
  private state: "idle" | "model" = "idle";
  private stateSince: number;
  private lastProgressAt: number;
  private readonly tools = new Map<string, RunningTool>();

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.stateSince = now();
    this.lastProgressAt = this.stateSince;
  }

  /** A run started: the agent is now waiting on the model. Counts as progress. */
  runStarted(): void {
    this.tools.clear();
    this.enter("model");
  }

  /** A model turn completed (its tools, if any, have run). Counts as progress. */
  turnEnded(): void {
    this.lastProgressAt = this.now();
    if (this.tools.size === 0 && this.state === "model") this.stateSince = this.lastProgressAt;
  }

  /** A tool call started (`id` tells parallel calls apart). */
  toolStarted(id: string, tool: string, args: unknown): void {
    this.tools.set(id, { tool, since: this.now(), preview: toolPreview(args) });
  }

  /** A tool call returned (successfully or not). Counts as progress. */
  toolEnded(id: string): void {
    this.tools.delete(id);
    this.lastProgressAt = this.now();
    // Back to the model once the last tool of the batch is done.
    if (this.tools.size === 0 && this.state === "model") this.stateSince = this.lastProgressAt;
  }

  /** The run ended (completed, errored or aborted): idle. Counts as progress. */
  runEnded(): void {
    this.tools.clear();
    this.enter("idle");
  }

  /** The current activity and last progress, as a heartbeat sends them. */
  report(): AgentActivityReport {
    return { activity: this.activity(), lastProgressAt: this.lastProgressAt };
  }

  /** The current activity: the longest-running tool, else the run state. */
  activity(): AgentActivity {
    let oldest: RunningTool | null = null;
    for (const t of this.tools.values()) if (!oldest || t.since < oldest.since) oldest = t;
    if (oldest) {
      return { state: "tool", tool: oldest.tool, since: oldest.since, ...(oldest.preview ? { preview: oldest.preview } : {}) };
    }
    return { state: this.state, since: this.stateSince };
  }

  private enter(state: "idle" | "model"): void {
    this.state = state;
    this.stateSince = this.now();
    this.lastProgressAt = this.stateSince;
  }
}

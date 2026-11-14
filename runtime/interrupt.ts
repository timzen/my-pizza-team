// Interrupt: the agent's side of the `interrupt` directive (my-pizza-team
// docs/DESIGN.md "Stalled Teammates", "Interrupt"). A user saw a teammate
// stalled — alive, working, but its tool has made no progress for a long time
// (the incident: a `node --test` that never settled, asleep for 13 hours) — and
// asked it to stop. The harness aborts the run in flight the way its own Escape
// would (for Pi, `ctx.abort()`: the bash tool kills the command's whole process
// group), keeps the claimed work item, and once the aborted run has settled
// sends the agent a follow-up (`interruptNudge`) asking it to find out why the
// command hung, re-run it with a timeout, and carry on.
//
// Harness-agnostic: `InterruptRealizer` gets what it needs as deps (is a run in
// flight, the activity report, abort, send the nudge, report the outcome), so
// any harness that can abort a run can declare `interrupt` and wire it — Pi's
// wiring is harnesses/pi/src/index.ts. Unit-tested on fakes
// (tests/interrupt.test.ts) and, with Pi's real bash tool and a hung
// subprocess, in harnesses/pi/tests/interrupt.test.mjs.

import { formatStallDuration, type AgentActivity, type AgentActivityReport, type InterruptParams } from "../shared/agent-protocol.ts";

/**
 * The follow-up the agent gets after an interrupt: what was interrupted, after
 * how long without progress, and what to do next. ``Your last command
 * (`node --test …`) was interrupted by the user after 13h with no progress. It
 * likely hung. Find out why (e.g. a test that never settles), re-run with a
 * timeout, then continue your task.`` A tool call with no preview is named by
 * its tool; a model call by "your last model call".
 */
export function interruptNudge(report: AgentActivityReport | null, now: number, reason?: string): string {
  const activity: AgentActivity | null = report?.activity ?? null;
  const since = report ? report.lastProgressAt : null;
  const what = !activity || activity.state !== "tool"
    ? activity?.state === "model" ? "Your last model call" : "Your last step"
    : activity.preview ? `Your last command (\`${activity.preview}\`)` : `Your last ${activity.tool || "tool"} call`;
  const after = since !== null && Number.isFinite(since) ? ` after ${formatStallDuration(now - since)}` : "";
  const said = reason?.trim() ? ` The user said: ${reason.trim()}` : "";
  return `${what} was interrupted by the user${after} with no progress. It likely hung. ` +
    `Find out why (e.g. a test that never settles), re-run with a timeout, then continue your task.${said}`;
}

/** An `interrupt` directive as the agent polls it. */
export interface InterruptDirective {
  id: string;
  params?: Record<string, unknown>;
}

/** What `InterruptRealizer` needs from its harness. */
export interface InterruptRealizerDeps {
  /** The work item the agent holds, or null. */
  workItemId(): string | null;
  /** Is a run in flight (something to abort)? */
  isRunning(): boolean;
  /** Is the agent working on its own (not paired with a human, who can stop it themselves)? */
  isAutonomous(): boolean;
  /** What the agent is doing and when it last made progress (runtime/activity.ts), read before the abort. */
  activity(): AgentActivityReport | null;
  /**
   * Tell the work loop the run in flight is being interrupted, so its end is
   * not read as the item's completion (the item stays claimed).
   */
  markInterrupted(workItemId: string): void;
  /** Abort the run in flight, its tool's process tree included (Pi: `ctx.abort()`). */
  abort(): void;
  /** Send the agent the nudge as the item's next message (the work loop's own run). */
  sendNudge(text: string): void;
  /** Report the directive's outcome to the daemon. */
  complete(id: string, status: "done" | "failed", error?: string): Promise<unknown>;
  /** The clock (epoch ms); tests fake it. */
  now?(): number;
  log?(text: string): void;
}

/**
 * Realizes `interrupt` directives: `offer` aborts at once and holds the nudge;
 * `runSettled` (the harness's "the aborted run is over, nothing will continue
 * on its own" — Pi's `agent_settled`) sends it and marks the directive done.
 * One that can't be realized (no item, no run in flight, paired) is failed with
 * the reason at once, so it leaves the queue.
 */
export class InterruptRealizer {
  private readonly deps: InterruptRealizerDeps;
  /** Ids already realized (or refused): never realized twice. */
  private readonly seen = new Set<string>();
  /** Outcomes the daemon didn't get (unreachable): reported again when the poll offers the id again. */
  private readonly unreported = new Map<string, { status: "done" | "failed"; error?: string }>();
  /** The interrupt waiting for its aborted run to settle, and the nudge to send then. */
  private waiting: { id: string; nudge: string } | null = null;
  private stopped = false;

  constructor(deps: InterruptRealizerDeps) {
    this.deps = deps;
  }

  /** An interrupt is waiting for the aborted run to settle. */
  get pending(): boolean {
    return this.waiting !== null;
  }

  /** Take a polled `interrupt` directive: abort now (or fail it with the reason). */
  async offer(directive: InterruptDirective): Promise<void> {
    if (this.stopped) return;
    if (this.seen.has(directive.id)) {
      // Still pending at the daemon because our report didn't reach it: say it
      // again — never abort again (that would cut off the nudge's own run).
      const outcome = this.unreported.get(directive.id);
      if (outcome) await this.report(directive.id, outcome.status, outcome.error);
      return;
    }
    this.seen.add(directive.id);
    const workItemId = this.deps.workItemId();
    const problem = this.waiting ? "an interrupt is already in progress"
      : !workItemId ? "not working on a work item"
      : !this.deps.isAutonomous() ? "paired with a human — stop it from the pairing view"
      : !this.deps.isRunning() ? "no run in flight to interrupt"
      : null;
    if (problem || !workItemId) {
      this.deps.log?.(`interrupt ${directive.id}: failed — ${problem}`);
      await this.report(directive.id, "failed", problem ?? undefined);
      return;
    }
    const params = (directive.params ?? {}) as InterruptParams;
    const now = this.deps.now?.() ?? Date.now();
    // Read the activity before aborting: the abort ends the tool, and with it
    // the preview the nudge names.
    this.waiting = { id: directive.id, nudge: interruptNudge(this.deps.activity(), now, typeof params.reason === "string" ? params.reason : undefined) };
    this.deps.markInterrupted(workItemId);
    this.deps.log?.(`interrupt ${directive.id}: aborting the run in flight on ${workItemId}`);
    this.deps.abort();
  }

  /** The aborted run settled: send the nudge, and mark the directive done. */
  async runSettled(): Promise<void> {
    const waiting = this.waiting;
    if (this.stopped || !waiting) return;
    this.waiting = null;
    this.deps.sendNudge(waiting.nudge);
    this.deps.log?.(`interrupt ${waiting.id}: done — nudge sent`);
    await this.report(waiting.id, "done");
  }

  /** This harness instance is going away: realize nothing more. */
  stop(): void {
    this.stopped = true;
    this.waiting = null;
  }

  private async report(id: string, status: "done" | "failed", error?: string): Promise<void> {
    try {
      await this.deps.complete(id, status, error);
      this.unreported.delete(id);
    } catch {
      // An unreachable daemon: the directive stays pending, and the next poll's
      // offer reports this outcome again (see `offer`).
      this.unreported.set(id, { status, ...(error ? { error } : {}) });
    }
  }
}

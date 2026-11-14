// Teammate work loop: poll → claim → work → set-state
//
// Autonomous execution engine for a teammate agent. Uses the daemon's
// WorkItem-centric agent protocol (/api/agents/*): the WorkItem is the unit of
// agent execution, and teammates never move tasks (the daemon reacts to a terminal
// WorkItem state). See the daemon's docs/DESIGN.md "The WorkItem".
//
// Lifecycle:
// 1. Poll GET /api/agents/next-work → a READY WorkItem (directory affinity)
// 2. Claim POST /api/agents/claim/:workItemId → lease (→ IN_PROGRESS) + prompt
// 3. Execute work (deliver the daemon-assembled prompt to the Pi agent)
// 4. On the agent_end **of that prompt's own run**, POST
//    .../work-items/:id/state COMPLETE → the daemon advances the task
//    mechanically. If the agent used the `fail` tool instead, the item is
//    already FAILED and completion is skipped; likewise after
//    `wait_for_next_check` (a poll state's "not yet": the item is WAITED —
//    my-pizza-team docs/DESIGN.md "Polling States"). If the run's *session errored*
//    (the model call failed: stopReason "error"), it is not a completion
//    either: the item is failed with the error and the daemon retries it with
//    backoff (my-pizza-team docs/DESIGN.md "Errored Sessions Retry").
//
// Run ownership matters: the prompt is delivered as a `followUp`, which Pi only
// hands over once the agent stops. So an agent_end can belong to some *other*
// run (a slash command, a lead steer, the previous item's wrap-up). Completing
// on such a foreign run would mark a just-claimed item COMPLETE before the
// teammate had even read the prompt — the item would land in the Inbox as
// unread completed work while the teammate was visibly still working on it. The
// loop therefore (a) never claims while a run is in flight and (b) ignores
// agent_end until the run that picked up the work prompt has started.
// 5. Request a fresh Pi session (context hygiene — each work item starts with
//    an empty session; see requestFreshSession). The fresh extension instance
//    re-registers and polls for the next work item.
//
// The claim's persona (my-pizza-team docs/DESIGN.md "The persona in the system
// prompt") is held for exactly the claimed item — set on claim, replaced by the
// next claim, dropped whenever the item ends — and read by index.ts's
// before_agent_start hook (persona-prompt.ts), so it reaches the system prompt
// of that item's runs only: never a later item's, a retry's or a foreign run's
// after the item ended.
//
// Alongside the work poll, the loop polls its own session directives
// (`new-session`: Reset in the web UI) and rolls the session on request — see
// pollSessionDirectives. A `set-model` from the same poll is handed to
// `onModelDirective` (model-choice.ts realizes it between runs), and an
// `interrupt` to `onInterruptDirective` (runtime/interrupt.ts: the run in
// flight is aborted, its end is not a completion — `markInterrupted` — and the
// nudge goes in as the item's next run — `sendWorkFollowUp`; my-pizza-team
// docs/DESIGN.md "Stalled Teammates").
//
// The teammate never assumes workflow state names — the prompt tells it what to
// do. This makes it compatible with any workflow configuration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./runtime/client.js";
import type { AgentActivityReport, ClaimPersona, ModelErrorKind, PairingReleaseAction } from "./shared/agent-protocol.js";
import * as fs from "node:fs";
import * as path from "node:path";

const POLL_INTERVAL_MS = 5000;
/** Sent on "resume" when the teammate is idle, so a run starts that can complete the item. */
const RESUME_NUDGE =
  "You're back on autonomous work: carry on with your current work item. When it's done, end with a concise summary of what you accomplished.";
/** Summary used when "complete" is chosen but the agent never replied with prose. */
const PAIRED_COMPLETE_FALLBACK = "Marked complete by a human while pairing from the web UI.";
const HEARTBEAT_INTERVAL_MS = 30000;

export class TeammateLoop {
  private pi: ExtensionAPI;
  private client: DaemonClient;
  private running = false;
  private autonomous = false;
  private currentWorkItemId: string | null = null;
  private lastCompletedWorkItemId: string | null = null;
  /** Set when the agent failed its current WorkItem via the `fail` tool —
   *  agent_end must then skip marking completion (the item is already FAILED). */
  private failedWorkItemId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private directiveTimer: ReturnType<typeof setInterval> | null = null;
  /** True while a Pi agent run is in flight (agent_start → agent_end). */
  private agentRunning = false;
  /**
   * Set once a work prompt has been handed to Pi but before its run starts.
   * While set, any agent_end belongs to an earlier, unrelated run and must not
   * be read as this WorkItem's completion (see the header note on run
   * ownership).
   */
  private awaitingWorkRun = false;
  /**
   * A web-pairing release that arrived mid-run, applied when that run ends
   * (applyPendingRelease). Acting mid-run would read the in-flight run — often
   * a reply to your chat message — as the work item's completion.
   */
  private pendingRelease: PairingReleaseAction | null = null;
  /**
   * The item whose run in flight is being interrupted (`markInterrupted`): that
   * run's agent_end is not its completion — the item stays claimed, and the
   * interrupt's nudge is its next run.
   */
  private interruptedWorkItemId: string | null = null;
  /** The claim's persona, for the item it was claimed with (see `persona`). */
  private heldPersona: { workItemId: string; persona: ClaimPersona } | null = null;
  /** The claim's failover probe model, for the item it was claimed with (see `failoverProbe`). */
  private heldProbe: { workItemId: string; modelId: string } | null = null;

  public onTaskComplete: ((workItemId: string, result: string) => void) | null = null;

  /**
   * Called after a work item ends (completed or returned) to request a fresh
   * Pi session before the next one — each task should start with an empty
   * context (no bleed from the previous task). Wired by setupTeammate to
   * queue the /ppt-fresh-session command; the resulting session_start re-runs
   * setup, which re-registers this member and starts a new loop.
   */
  public requestFreshSession: (() => void) | null = null;

  /**
   * Realize a session self-directive the daemon addressed to this teammate
   * (today only `new-session`: Reset in the Team tab). Wired by setupTeammate to
   * queue /ppt-reset-session, since session control only exists on command
   * contexts. Any other action is failed, not retried.
   */
  public onSessionDirective: ((action: string, params: Record<string, unknown>) => void) | null = null;

  /**
   * Take a `set-model` directive (my-pizza-team docs/DESIGN.md "Choosing a
   * Model"). Wired by setupTeammate to model-choice.ts's SetModelRealizer, which
   * waits for a run in flight to end and reports the outcome itself. Unset, a
   * set-model is failed like any action this loop can't realize.
   */
  public onModelDirective: ((directive: { id: string; params: Record<string, unknown> }) => void | Promise<void>) | null = null;

  /**
   * Take an `interrupt` directive (my-pizza-team docs/DESIGN.md "Stalled
   * Teammates"). Wired by setupTeammate to runtime/interrupt.ts's
   * InterruptRealizer, which aborts the run and reports the outcome itself.
   * Unset (an older wiring), an interrupt is failed like any action this loop
   * can't realize.
   */
  public onInterruptDirective: ((directive: { id: string; params: Record<string, unknown> }) => void | Promise<void>) | null = null;

  /**
   * Called on every successful claim with how the item finishes: `poll` (its
   * board state polls, so the run may end with wait) or `once`. Wired by
   * setupTeammate to offer `wait_for_next_check` only for `poll`
   * (wait-tool.ts; my-pizza-team docs/DESIGN.md "Polling States").
   */
  public onClaimCompletion: ((completion: "once" | "poll") => void) | null = null;

  /**
   * Called when the held persona changes: at each claim (its persona, or null)
   * and when the item ends (null). Wired by setupTeammate to apply the
   * persona's tool scope at once and restore the full tool set after the item
   * (persona-scope.ts), and to switch to the persona's model and back
   * (persona-model.ts); before_agent_start re-applies both on every run anyway.
   * Awaited at claim, before the work prompt is sent, so the item's first run
   * already has its model; not awaited at the item's end.
   */
  public onPersonaChange: ((persona: ClaimPersona | null) => void | Promise<void>) | null = null;

  /**
   * What the agent is doing and when it last made progress, sent with every
   * heartbeat (activity-report.ts) so the daemon can flag a stalled teammate.
   * Wired by setupTeammate; unset, heartbeats carry no activity.
   */
  public activityReport: (() => AgentActivityReport) | null = null;

  /** Called when the agent is dismissed from the UI */
  public onDismissed: (() => void) | null = null;

  /**
   * Re-register this member with the daemon. Wired by setupTeammate. Invoked
   * when a heartbeat reports the daemon doesn't know us (`reregister`) — e.g.
   * after a daemon restart/upgrade wiped its in-memory members table — so a
   * restart is transparent to a running teammate instead of shutting it down.
   */
  public reregister: (() => Promise<void>) | null = null;

  /** Expose a way for external code to toggle permissions */
  public setAutonomousPermissions: ((autonomous: boolean) => void) | null = null;

  /** Debug logger — writes to ppt-debug.log in the agent's cwd */
  public debugLog: ((msg: string) => void) = () => {};

  constructor(pi: ExtensionAPI, client: DaemonClient) {
    this.pi = pi;
    this.client = client;
  }

  get isAutonomous(): boolean {
    return this.autonomous;
  }

  get currentTask(): string | null {
    return this.currentWorkItemId;
  }

  get lastTask(): string | null {
    return this.lastCompletedWorkItemId;
  }

  /** True while a Pi run is in flight (decides followUp vs immediate delivery). */
  get isAgentRunning(): boolean {
    return this.agentRunning;
  }

  /**
   * Is the run that just ended this WorkItem's own run? (We hold an item and
   * its prompt was picked up.) Decides whether a run's usage is billed to the
   * item as `work` — a foreign run (a slash command, the previous item's
   * wrap-up) must not be.
   */
  get ownsCurrentRun(): boolean {
    return this.currentWorkItemId !== null && !this.awaitingWorkRun;
  }

  /**
   * The run in flight on `workItemId` is being interrupted: its agent_end must
   * not complete the item (handleAgentComplete skips it once). Ignored unless
   * that is the item held.
   */
  markInterrupted(workItemId: string): void {
    if (workItemId === this.currentWorkItemId) this.interruptedWorkItemId = workItemId;
  }

  /**
   * Send the held item's next message as a run of its own — the interrupt's
   * nudge. Like the work prompt it is a `followUp`, and agent_end events until
   * its run starts are foreign (see the header note on run ownership), so the
   * item completes when *this* run ends.
   */
  sendWorkFollowUp(text: string): void {
    if (!this.currentWorkItemId) return;
    this.awaitingWorkRun = true;
    this.pi.sendUserMessage(text, { deliverAs: "followUp" });
  }

  get hasPendingRelease(): boolean {
    return this.pendingRelease !== null;
  }

  /**
   * The persona of the work item in hand, as its claim sent it — null when no
   * item is held, or it came without one (no persona for this work, or an
   * older daemon). index.ts puts it in each run's system prompt.
   */
  get persona(): ClaimPersona | null {
    const held = this.heldPersona;
    return held && held.workItemId === this.currentWorkItemId ? held.persona : null;
  }

  /**
   * The model a failover revert probe runs the work in hand on (the claim's
   * `failoverProbe`; my-pizza-team docs/DESIGN.md "Model Failover"), or null
   * when this item isn't the probe. It wins over every other model choice.
   */
  get failoverProbe(): string | null {
    const held = this.heldProbe;
    return held && held.workItemId === this.currentWorkItemId ? held.modelId : null;
  }

  /**
   * The id of the persona the work in hand runs as (null: none, or a board
   * state with no persona). For other parts of the extension to key on.
   */
  get personaId(): string | null {
    return this.persona?.id ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WEB PAIRING RELEASE (my-pizza-team docs/DESIGN.md "Watching and Pairing with a Teammate")
  // ═══════════════════════════════════════════════════════════════════

  /**
   * End a web pairing and hand the teammate back to autonomous work, deciding
   * what happens to the work item it holds:
   *   - `resume`   keep working on it: nudge a new run, whose agent_end
   *                completes the item the normal way (we're autonomous again)
   *   - `complete` done — post `lastText` as the summary and set COMPLETE
   *   - `fail`     post a comment and set FAILED (the task is left stuck for a human)
   * With no held item, all three just resume polling for work. Mid-run, the
   * release waits for the run to end (see `pendingRelease`).
   */
  async releasePairing(action: PairingReleaseAction, lastText: string): Promise<void> {
    if (this.agentRunning) {
      this.pendingRelease = action;
      return;
    }
    this.pendingRelease = null;
    this.autonomous = true;
    this.setAutonomousPermissions?.(true);

    const workItemId = this.currentWorkItemId;
    if (!workItemId) {
      if (this.running) this.pollForWork();
      return;
    }

    if (action === "complete") {
      // Not waiting on a prompt pickup any more — this is a deliberate completion.
      this.awaitingWorkRun = false;
      await this.handleAgentComplete(lastText.trim() || PAIRED_COMPLETE_FALLBACK);
      return;
    }

    if (action === "fail") {
      await this.client.postComment(workItemId, `[failed] Marked failed by a human while pairing from the web UI.`).catch(() => {});
      await this.client.setWorkItemState(workItemId, "FAILED").catch(() => {});
      this.currentWorkItemId = null;
      this.awaitingWorkRun = false;
      this.finishWorkItem();
      return;
    }

    // resume: start a run so there's an agent_end to complete on. Until it
    // starts, any agent_end is foreign (same guard as a fresh work prompt).
    this.awaitingWorkRun = true;
    this.pi.sendUserMessage(RESUME_NUDGE, { deliverAs: "followUp" });
  }

  /** Apply a release deferred by a run in flight. Called from agent_end. */
  async applyPendingRelease(lastText: string): Promise<void> {
    const action = this.pendingRelease;
    if (action) await this.releasePairing(action, lastText);
  }

  /**
   * Record that the current WorkItem was ended by the agent — failed (the
   * `fail` tool) or waited (`wait_for_next_check`). The in-flight agent turn
   * may keep going briefly; when it ends, handleAgentComplete sees the flag
   * and does not mark the item COMPLETE.
   */
  markReturned(workItemId: string): void {
    if (this.currentWorkItemId === workItemId) this.failedWorkItemId = workItemId;
  }

  /**
   * A Pi agent run started. If we were waiting for our work prompt to be picked
   * up, this is that run — completing on its agent_end is legitimate.
   */
  handleAgentStart(): void {
    this.agentRunning = true;
    this.awaitingWorkRun = false;
  }

  /** A Pi agent run ended. Bookkeeping only — whether it *completes* the current
   *  WorkItem is decided by handleAgentComplete. Idempotent. */
  handleAgentEnd(): void {
    this.agentRunning = false;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.directiveTimer = setInterval(() => { this.pollSessionDirectives().catch(() => {}); }, POLL_INTERVAL_MS);
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    this.autonomous = false;
    this.awaitingWorkRun = false;
    this.heldPersona = null;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.directiveTimer) { clearInterval(this.directiveTimer); this.directiveTimer = null; }
  }

  /** Pause autonomous work (human is pairing) */
  pause(): void {
    this.autonomous = false;
    this.client.heartbeat("pairing", undefined, this.activityReport?.()).catch(() => {});
  }

  /** Resume autonomous work */
  resume(): void {
    this.autonomous = true;
    if (this.running) this.pollForWork();
  }

  // ═══════════════════════════════════════════════════════════════════
  // HEARTBEAT
  // ═══════════════════════════════════════════════════════════════════

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      const status = this.autonomous
        ? this.currentWorkItemId ? "working" : "idle"
        : "pairing";
      const res = await this.client.heartbeat(status, this.currentWorkItemId || undefined, this.activityReport?.());
      if (res.dismissed) {
        this.stop();
        if (this.onDismissed) this.onDismissed();
      } else if (res.reregister) {
        // The daemon forgot us (restart/upgrade) — re-register and keep working.
        this.debugLog(`[ppt-debug] heartbeat: daemon asked to re-register (restart?) — re-registering`);
        await this.reregister?.();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SESSION SELF-DIRECTIVES (Reset from the web UI)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Realize the session directives the daemon addressed to this teammate
   * (GET /api/agents/:id/directives). A reset used to be the leader typing Pi's
   * `/new` into this teammate's tmux window; now the ask comes here and the
   * teammate rolls its own session (my-pizza-team docs/DESIGN.md "Leader
   * Directives").
   *
   * Each directive is marked done *before* it is realized: the new session
   * replaces this instance (its loop stops mid-await), and a directive still
   * pending then would be found again by the fresh instance — resetting forever.
   */
  private async pollSessionDirectives(): Promise<void> {
    if (!this.running || !this.onSessionDirective) return;
    const { directives } = await this.client.getSelfDirectives();
    for (const directive of directives) {
      // A model switch doesn't roll the session: the realizer takes it (and
      // marks it), and the poll goes on. (The literal, not SET_MODEL_ACTION:
      // this module imports no values, so tests load it standalone.)
      if (directive.action === "set-model" && this.onModelDirective) {
        await Promise.resolve(this.onModelDirective(directive)).catch(() => {});
        continue;
      }
      // An interrupt aborts the run in flight and nudges the agent; the session stays.
      if (directive.action === "interrupt" && this.onInterruptDirective) {
        await Promise.resolve(this.onInterruptDirective(directive)).catch(() => {});
        continue;
      }
      // One we can't realize must leave the queue, or it is retried forever.
      if (directive.action !== "new-session") {
        await this.client.completeSelfDirective(directive.id, "failed").catch(() => {});
        continue;
      }
      // Ack first (an unreachable daemon throws here, and the next poll retries).
      await this.client.completeSelfDirective(directive.id);
      this.debugLog(`[ppt-debug] session directive ${directive.action} — rolling the session`);
      this.onSessionDirective(directive.action, directive.params || {});
      return; // this instance is on its way out; the fresh one polls anything left
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // POLL → CLAIM → EXECUTE
  // ═══════════════════════════════════════════════════════════════════

  private async pollForWork(): Promise<void> {
    // Never claim while a run is in flight: the claimed item's prompt is a
    // `followUp` (delivered only once the agent stops), so the in-flight run's
    // agent_end would arrive first and look like this item's completion.
    if (!this.running || !this.autonomous || this.currentWorkItemId || this.agentRunning) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextWork();

      if (response.workItem) {
        // Claim the WorkItem → daemon leases it (→ IN_PROGRESS).
        const claim = await this.client.claimWorkItem(response.workItem.id);
        if (!claim.success) {
          // Someone else claimed it — try again
          this.schedulePoll();
          return;
        }

        // We now own this work item. Its state may poll: offer the wait tool
        // only then (an older daemon sends no `completion`: once).
        this.currentWorkItemId = response.workItem.id;
        // Its persona replaces any earlier item's (absent from an older daemon: none).
        this.heldPersona = claim.persona ? { workItemId: response.workItem.id, persona: claim.persona } : null;
        // A failover revert probe runs this item on the primary (absent: no probe).
        this.heldProbe = claim.failoverProbe?.modelId ? { workItemId: response.workItem.id, modelId: claim.failoverProbe.modelId } : null;
        await Promise.resolve(this.onPersonaChange?.(this.persona)).catch(() => {});
        this.onClaimCompletion?.(claim.completion === "poll" ? "poll" : "once");
        this.client.heartbeat("working", response.workItem.id, this.activityReport?.()).catch(() => {});

        // Execute the work using the daemon-assembled prompt.
        await this.executeTask(response.workItem.id, claim.prompt);
      } else {
        this.schedulePoll();
      }
    } catch {
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.pollForWork(), POLL_INTERVAL_MS);
  }

  /**
   * Execute a task: deliver the daemon-assembled prompt to the Pi agent.
   *
   * The daemon owns the entire prompt (story, task, prior context, lead
   * comments, state guidance, and instructions) so the teammate never augments
   * it — it just posts a status comment and sends the prompt verbatim.
   */
  private async executeTask(workItemId: string, prompt?: string): Promise<void> {
    // The daemon always supplies the prompt; guard defensively just in case.
    const message = prompt && prompt.trim().length > 0
      ? prompt
      : `You are working on work item ${workItemId}. Review the details and proceed.`;

    // Post status comment
    await this.client.postComment(workItemId, `[status] Started working on this.`).catch(() => {});

    // Send to Pi agent — this triggers the agent loop. Until that run starts,
    // agent_end events are foreign (see the header note on run ownership).
    this.debugLog(`[ppt-debug] Sending prompt to agent (workItem=${workItemId}, prompt length=${message.length})`);
    this.awaitingWorkRun = true;
    this.pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  // ═══════════════════════════════════════════════════════════════════
  // AGENT COMPLETION → RELEASE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Called by the agent_end handler when the Pi agent finishes.
   *
   * Posts a summary comment and sets the WorkItem COMPLETE — the daemon advances
   * the task to its next state (teammates never move tasks). If the agent failed
   * the item mid-turn (the `fail` tool), completion is skipped: the item is
   * already FAILED and the task is left stuck for a human.
   *
   * `sessionError` (from summarizeRun) means the run's model call failed —
   * nothing was done, so posting "[done]" and setting COMPLETE would silently
   * swallow the work. Instead the item is failed with the error; the daemon
   * posts the `[retry]`/`[failed]` comment and enqueues the retry.
   * `errorDetail` (its kind, model-error.ts, and the model the call was on)
   * goes with it, for the daemon's failover (docs/DESIGN.md "Model Failover").
   */
  async handleAgentComplete(
    lastMessage: string, sessionError?: string, errorDetail: { errorKind?: ModelErrorKind; model?: string } = {},
  ): Promise<void> {
    this.debugLog(`[ppt-debug] handleAgentComplete called. currentWorkItemId=${this.currentWorkItemId}, msgLen=${lastMessage.length}`);
    if (!this.currentWorkItemId) {
      this.debugLog(`[ppt-debug] handleAgentComplete: no currentWorkItemId, returning early`);
      return;
    }

    // ─── Foreign run? Not our completion. ────────────────────────────
    // Our work prompt hasn't been picked up yet, so this agent_end belongs to an
    // earlier run (slash command, lead steer, previous item's wrap-up).
    // Completing here would falsely mark a just-claimed item done.
    if (this.awaitingWorkRun) {
      this.debugLog(`[ppt-debug] handleAgentComplete: agent_end from a foreign run (work prompt for ${this.currentWorkItemId} not started yet) — ignoring`);
      return;
    }

    const workItemId = this.currentWorkItemId;

    // ─── Interrupted by the user? Not a completion. ─────────────────
    // The run was aborted on purpose (an `interrupt`): the item stays claimed,
    // and the interrupt's nudge (sendWorkFollowUp) is its next run.
    if (this.interruptedWorkItemId === workItemId) {
      this.debugLog(`[ppt-debug] WorkItem ${workItemId}: run interrupted by the user — keeping the item, NOT completing.`);
      this.interruptedWorkItemId = null;
      return;
    }

    // (Usage is reported for every run by the agent_end handler in index.ts —
    // see usage.ts — not here, so pairing and non-work runs are counted too.)

    // ─── Failed (or waited) mid-turn? The item already ended. ───
    if (this.failedWorkItemId === workItemId) {
      this.debugLog(`[ppt-debug] WorkItem ${workItemId} was ended via the fail or wait tool — skipping COMPLETE.`);
      this.failedWorkItemId = null;
      this.currentWorkItemId = null;
      this.awaitingWorkRun = false;
      this.finishWorkItem();
      return;
    }

    // ─── Session errored? Not a completion — the daemon retries it. ───
    if (sessionError) {
      this.debugLog(`[ppt-debug] WorkItem ${workItemId}: agent session errored (${sessionError}) — failing for retry, NOT completing.`);
      const res = await this.client.failWorkItemForSessionError(workItemId, sessionError, errorDetail).catch((e) => {
        this.debugLog(`[ppt-debug] failWorkItemForSessionError FAILED: ${e}`);
        return null;
      });
      this.debugLog(`[ppt-debug] failWorkItemForSessionError response: ${JSON.stringify(res)}`);
      this.currentWorkItemId = null;
      this.awaitingWorkRun = false;
      this.finishWorkItem();
      return;
    }

    // ─── Done with result ────────────────────────────────────────────
    const fullMessage = lastMessage.trim();
    this.debugLog(`[ppt-debug] Completing work item ${workItemId} with summary: ${fullMessage.slice(0, 100)}...`);
    // The agent owns its completion record — post it once here. The daemon does
    // NOT post anything on setWorkItemState, so this is the single done comment.
    await this.client.postComment(workItemId, `[done] Work complete. Summary:\n${fullMessage}`).catch(() => {});

    // Set COMPLETE — the daemon advances the task mechanically (no comment).
    const doneRes = await this.client.setWorkItemState(workItemId, "COMPLETE").catch((e) => {
      this.debugLog(`[ppt-debug] setWorkItemState COMPLETE FAILED: ${e}`);
      return null;
    });
    this.debugLog(`[ppt-debug] setWorkItemState response: ${JSON.stringify(doneRes)}`);
    this.lastCompletedWorkItemId = workItemId;
    this.currentWorkItemId = null;
    this.awaitingWorkRun = false;

    if (doneRes?.completed) {
      this.onTaskComplete?.(workItemId, fullMessage);
    }

    this.finishWorkItem();
  }

  /**
   * Wrap up a work item: drop its persona, request a fresh session for context hygiene, and
   * schedule a poll as a safety net. If the session reset goes through, pi
   * emits session_shutdown for this instance (which stops the loop and clears
   * the timer) and a brand-new loop takes over in the fresh session. If the
   * reset fails or isn't wired, the scheduled poll keeps this loop working —
   * same behavior as before fresh sessions existed.
   */
  private finishWorkItem(): void {
    // The item is over: its persona must not reach the next run (the fresh
    // session request, a retry's claim, a resume) — see the header note.
    this.heldPersona = null;
    this.heldProbe = null;
    this.interruptedWorkItemId = null;
    void Promise.resolve(this.onPersonaChange?.(null)).catch(() => {});
    this.requestFreshSession?.();
    this.schedulePoll();
  }
}

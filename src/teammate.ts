// Teammate work loop: poll → claim → work → set-state
//
// Autonomous execution engine for a teammate agent. Uses the daemon's
// WorkItem-centric agent protocol (/api/agents/*): the WorkItem is the unit of
// agent execution, and workers never move tasks (the daemon reacts to a terminal
// WorkItem state). See the daemon's docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.
//
// Lifecycle:
// 1. Poll GET /api/agents/next-work → a READY WorkItem (directory affinity)
// 2. Claim POST /api/agents/claim/:workItemId → lease (→ IN_PROGRESS) + prompt
// 3. Execute work (deliver the daemon-assembled prompt to the Pi agent)
// 4. On the agent_end **of that prompt's own run**, POST
//    .../work-items/:id/state COMPLETE → the daemon advances the task
//    mechanically. If the agent used the `fail` tool instead, the item is
//    already FAILED and completion is skipped.
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
// The teammate never assumes workflow state names — the prompt tells it what to
// do. This makes it compatible with any workflow configuration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import type { PairReleaseAction } from "./client.js";
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
  private pendingRelease: PairReleaseAction | null = null;

  public onTaskComplete: ((workItemId: string, result: string) => void) | null = null;

  /**
   * Called after a work item ends (completed or returned) to request a fresh
   * Pi session before the next one — each task should start with an empty
   * context (no bleed from the previous task). Wired by setupTeammate to
   * queue the /ppt-fresh-session command; the resulting session_start re-runs
   * setup, which re-registers this member and starts a new loop.
   */
  public requestFreshSession: (() => void) | null = null;

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

  get hasPendingRelease(): boolean {
    return this.pendingRelease !== null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WEB PAIRING RELEASE (my-pizza-team docs/TEAMMATE_CHAT.md §4)
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
  async releasePairing(action: PairReleaseAction, lastText: string): Promise<void> {
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
   * Record that the current WorkItem was failed by the agent (the `fail` tool
   * ran). The in-flight agent turn may keep going briefly; when it ends,
   * handleAgentComplete sees the flag and does not mark the item COMPLETE.
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
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    this.autonomous = false;
    this.awaitingWorkRun = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** Pause autonomous work (human is pairing) */
  pause(): void {
    this.autonomous = false;
    this.client.heartbeat("pairing").catch(() => {});
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
      const res = await this.client.heartbeat(status, this.currentWorkItemId || undefined);
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

        // We now own this work item
        this.currentWorkItemId = response.workItem.id;
        this.client.heartbeat("working", response.workItem.id).catch(() => {});

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
   * the task to its next state (workers never move tasks). If the agent failed
   * the item mid-turn (the `fail` tool), completion is skipped: the item is
   * already FAILED and the task is left stuck for a human.
   */
  async handleAgentComplete(lastMessage: string, tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    /** Real cost from the harness (pi's cache-aware total). Preferred over the daemon's estimate. */
    costUsd?: number;
  }): Promise<void> {
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

    // Report token usage (include the harness-computed cost when we have it).
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await this.client.reportTokenUsage(workItemId, {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model: tokenUsage.model,
        costUsd: tokenUsage.costUsd,
      }).catch(() => {});
    }

    // ─── Failed mid-turn? The item is already FAILED (task left stuck). ───
    if (this.failedWorkItemId === workItemId) {
      this.debugLog(`[ppt-debug] WorkItem ${workItemId} was failed via the fail tool — skipping COMPLETE.`);
      this.failedWorkItemId = null;
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
   * Wrap up a work item: request a fresh session for context hygiene, and
   * schedule a poll as a safety net. If the session reset goes through, pi
   * emits session_shutdown for this instance (which stops the loop and clears
   * the timer) and a brand-new loop takes over in the fresh session. If the
   * reset fails or isn't wired, the scheduled poll keeps this loop working —
   * same behavior as before fresh sessions existed.
   */
  private finishWorkItem(): void {
    this.requestFreshSession?.();
    this.schedulePoll();
  }
}

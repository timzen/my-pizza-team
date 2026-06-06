// Teammate work loop: multi-transition ownership model
//
// Autonomous execution engine for a teammate agent. Uses the daemon's
// agent protocol (/api/agents/*) with multi-transition ownership:
//
// Lifecycle:
// 1. Poll GET /api/agents/next-work → finds unclaimed task with teammate transitions
// 2. Claim POST /api/agents/claim/:taskId → assigns ownership (no state change)
// 3. Transition POST /api/agents/transition/:taskId → advance to first working state
// 4. Execute work (send task as user message to Pi agent)
// 5. On agent_end, transition to next state (repeatable if multiple teammate states)
// 6. When availableTransitions is empty → POST /api/agents/release/:taskId
// 7. Lead acts (review, sends comments), task reappears on next poll
//
// The teammate never assumes workflow state names — it relies entirely on
// the daemon's availableTransitions to know what moves are valid and when
// to release. This makes it compatible with any workflow configuration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient, AgentTransitionResponse } from "./client.js";

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const COMMENT_CHECK_INTERVAL_MS = 12000;
const WATCH_INTERVAL_MS = 10000;

export class TeammateLoop {
  private pi: ExtensionAPI;
  private client: DaemonClient;
  private running = false;
  private autonomous = false;
  private currentTaskId: string | null = null;
  private lastCompletedTaskId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private commentCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenCommentCount: number = 0;

  // Available transitions from the task's current state (updated after each transition)
  private availableTransitions: Array<{ state: string; permission: string }> = [];

  // Tasks we've released but are still watching for lead action (comments/rework)
  private watchedTasks: Map<string, number> = new Map();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  public onTaskComplete: ((taskId: string, result: string) => void) | null = null;

  /** Called when the agent is dismissed from the UI */
  public onDismissed: (() => void) | null = null;

  /** Expose a way for external code to toggle permissions */
  public setAutonomousPermissions: ((autonomous: boolean) => void) | null = null;

  constructor(pi: ExtensionAPI, client: DaemonClient) {
    this.pi = pi;
    this.client = client;
  }

  get isAutonomous(): boolean {
    return this.autonomous;
  }

  get currentTask(): string | null {
    return this.currentTaskId;
  }

  get lastTask(): string | null {
    return this.lastCompletedTaskId;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.startWatchLoop();
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    this.autonomous = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.stopCommentChecking();
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
        ? this.currentTaskId ? "working" : "idle"
        : "pairing";
      const res = await this.client.heartbeat(status, this.currentTaskId || undefined);
      if (res.dismissed) {
        // Agent was dismissed from the UI — shut down gracefully
        this.stop();
        if (this.onDismissed) this.onDismissed();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // POLL → CLAIM → TRANSITION → EXECUTE
  // ═══════════════════════════════════════════════════════════════════

  private async pollForWork(): Promise<void> {
    if (!this.running || !this.autonomous || this.currentTaskId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextWork();

      if (response.task) {
        // Claim ownership (no state change yet)
        const claim = await this.client.claimTask(response.task.id);
        if (!claim.success) {
          // Someone else claimed it — try again
          this.schedulePoll();
          return;
        }

        // We now own this task
        this.currentTaskId = response.task.id;
        this.watchedTasks.delete(response.task.id);
        this.availableTransitions = claim.availableTransitions || response.task.availableTransitions || [];
        this.client.heartbeat("working", response.task.id).catch(() => {});

        // Immediately transition to first working state
        const firstTransition = this.availableTransitions[0];
        if (firstTransition) {
          const transRes = await this.client.transitionTask(response.task.id, firstTransition.state).catch(() => null);
          if (transRes?.success) {
            this.availableTransitions = transRes.availableTransitions || [];
            await this.executeTask(response.task, transRes.instructions);
          } else {
            // Transition failed — release and retry
            await this.client.releaseTask(response.task.id).catch(() => {});
            this.currentTaskId = null;
            this.schedulePoll();
          }
        } else {
          // No transitions available (shouldn't happen from next-work, but handle gracefully)
          await this.executeTask(response.task, undefined);
        }
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
   * Execute a task: build the prompt and send it to the Pi agent.
   *
   * Includes transition instructions, task description, lead comments
   * (for rework context), and previous task results.
   */
  private async executeTask(
    task: {
      id: string;
      storyId: string;
      title: string;
      description: string;
      status?: string;
      context?: string;
      comments?: Array<{ from: string; body: string; at: string }>;
    },
    instructions?: string
  ): Promise<void> {
    let prompt = ``;

    // Transition instructions (from entering the new state)
    if (instructions) {
      prompt += `## Transition Instructions\n\n${instructions}\n\n---\n\n`;
    }

    // Lead comments (feedback/rework context)
    const leadComments = task.comments?.filter(c => c.from === "lead") || [];
    if (leadComments.length > 0) {
      const commentBodies = leadComments.map(c => `> ${c.body}`).join("\n\n");
      prompt += `## Comments from Team Lead\n\n${commentBodies}\n\n---\n\n`;
    }

    // Task description
    prompt += `## Task: ${task.title}\n**Task ID: ${task.id}** (Story: ${task.storyId})\n\n${task.description}`;

    // Context from previous tasks in the story
    if (task.context) {
      prompt = `## Context from previous tasks:\n\n${task.context}\n\n---\n\n${prompt}`;
    }

    prompt += `\n\n---\n**Remember: you are working on task ${task.id}. Ignore any task IDs from earlier in this conversation.**`;
    prompt += `\nWhen you're done, provide a brief summary of what you accomplished.`;
    prompt += `\nIf you get stuck and need human guidance, say "NEEDS_INPUT:" followed by your question.`;

    // Start checking for new comments while working
    this.startCommentChecking(task.id);

    // Post status comment
    await this.client.postComment(task.id, `[status] Started working on this task.`).catch(() => {});

    // Send to Pi agent — this triggers the agent loop
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  // ═══════════════════════════════════════════════════════════════════
  // AGENT COMPLETION → TRANSITION → RELEASE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Called by the agent_end handler when the Pi agent finishes.
   *
   * Handles the multi-transition model:
   * 1. If NEEDS_INPUT → transition to blocked state, release, watch
   * 2. Otherwise → transition to next state
   *    - If more teammate transitions remain, deliver instructions and continue
   *    - If no more transitions (or auto-released at done), release and watch
   */
  async handleAgentComplete(lastMessage: string, tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costFromProvider?: number;
  }): Promise<void> {
    if (!this.currentTaskId) return;

    const taskId = this.currentTaskId;
    this.stopCommentChecking();

    // Report token usage
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await this.client.reportTokenUsage(taskId, {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model: tokenUsage.model,
      }).catch(() => {});
    }

    // ─── NEEDS_INPUT: agent is stuck ─────────────────────────────────
    if (lastMessage.includes("NEEDS_INPUT:")) {
      const question = lastMessage.split("NEEDS_INPUT:").pop()?.trim() || "Need help with this task";
      await this.client.postComment(taskId, question);

      // Try to transition to a blocked/needs_input state if available
      const blockedTransition = this.availableTransitions.find(
        t => t.state.includes("needs_input") || t.state.includes("blocked")
      ) || this.availableTransitions[0];

      if (blockedTransition) {
        await this.client.transitionTask(taskId, blockedTransition.state).catch(() => {});
      }

      // Release the task — lead needs to unblock
      await this.client.releaseTask(taskId).catch(() => {});
      this.lastCompletedTaskId = taskId;
      this.currentTaskId = null;
      this.availableTransitions = [];
      this.watchTask(taskId);
      this.schedulePoll();
      return;
    }

    // ─── Normal completion: advance to next state ────────────────────
    const summary = lastMessage.slice(0, 500);
    await this.client.postComment(taskId, `[done] Work complete. Summary:\n${summary}`).catch(() => {});

    // Transition to the next available state
    const nextTransition = this.availableTransitions[0];
    if (nextTransition) {
      const transRes = await this.client.transitionTask(taskId, nextTransition.state, summary).catch(() => null);

      if (transRes?.success) {
        // Was the task auto-released (reached done state)?
        if (transRes.released) {
          this.lastCompletedTaskId = taskId;
          this.currentTaskId = null;
          this.availableTransitions = [];
          this.onTaskComplete?.(taskId, summary);
          this.schedulePoll();
          return;
        }

        // Update available transitions from the new state
        this.availableTransitions = transRes.availableTransitions || [];

        // If more teammate transitions are available, the agent can keep going
        if (this.availableTransitions.length > 0 && transRes.instructions) {
          // There are more states AND transition instructions — let the agent continue
          this.startCommentChecking(taskId);
          this.pi.sendUserMessage(
            `## Transition Instructions\n\nYou've advanced the task to a new state. Here are the instructions for this phase:\n\n${transRes.instructions}\n\n---\nContinue working. When done with this phase, provide a brief summary.\nIf you get stuck, say "NEEDS_INPUT:" followed by your question.`,
            { deliverAs: "followUp" }
          );
          return; // Wait for next agent_end
        }

        // No more teammate transitions from this state — release
        if (this.availableTransitions.length === 0) {
          await this.client.releaseTask(taskId).catch(() => {});
          this.lastCompletedTaskId = taskId;
          this.currentTaskId = null;
          this.onTaskComplete?.(taskId, summary);
          this.watchTask(taskId);
          this.schedulePoll();
          return;
        }

        // Transitions available but no instructions — auto-advance without agent work
        // (e.g., a pass-through state). Keep transitioning until blocked or done.
        await this.autoAdvance(taskId, summary);
        return;
      }
    }

    // No transitions available or transition failed — release
    await this.client.releaseTask(taskId).catch(() => {});
    this.lastCompletedTaskId = taskId;
    this.currentTaskId = null;
    this.availableTransitions = [];
    this.onTaskComplete?.(taskId, summary);
    this.watchTask(taskId);
    this.schedulePoll();
  }

  /**
   * Auto-advance through transitions that don't have instructions.
   * Keeps transitioning until we hit a state with instructions (needs agent work),
   * no more transitions (release), or the task is auto-released (done).
   */
  private async autoAdvance(taskId: string, result: string): Promise<void> {
    while (this.availableTransitions.length > 0) {
      const next = this.availableTransitions[0];
      const transRes = await this.client.transitionTask(taskId, next.state, result).catch(() => null);

      if (!transRes?.success) break;

      if (transRes.released) {
        this.lastCompletedTaskId = taskId;
        this.currentTaskId = null;
        this.availableTransitions = [];
        this.onTaskComplete?.(taskId, result);
        this.schedulePoll();
        return;
      }

      this.availableTransitions = transRes.availableTransitions || [];

      // If the new state has instructions, let the agent handle it
      if (transRes.instructions && this.availableTransitions.length > 0) {
        this.startCommentChecking(taskId);
        this.pi.sendUserMessage(
          `## Transition Instructions\n\nYou've advanced the task to a new state. Here are the instructions for this phase:\n\n${transRes.instructions}\n\n---\nContinue working. When done with this phase, provide a brief summary.\nIf you get stuck, say "NEEDS_INPUT:" followed by your question.`,
          { deliverAs: "followUp" }
        );
        return;
      }
    }

    // No more transitions — release
    await this.client.releaseTask(taskId).catch(() => {});
    this.lastCompletedTaskId = taskId;
    this.currentTaskId = null;
    this.availableTransitions = [];
    this.onTaskComplete?.(taskId, result);
    this.watchTask(taskId);
    this.schedulePoll();
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMENT WATCHING (while working + after release)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Start watching a released task for new lead comments.
   * If the lead posts new comments (feedback, sends it back), the task
   * will reappear on next-work and we'll pick it up again naturally
   * through the normal poll cycle.
   */
  private async watchTask(taskId: string): Promise<void> {
    try {
      const res = await this.client.getComments(taskId);
      this.watchedTasks.set(taskId, res.comments.length);
    } catch {
      this.watchedTasks.set(taskId, 0);
    }
  }

  /**
   * Periodic check on released tasks. If the task reappears on next-work
   * with new comments, it will be picked up by pollForWork. This loop
   * provides an additional fast-path: if we see new lead comments on a
   * watched task, we can proactively try to claim it.
   */
  private startWatchLoop(): void {
    this.watchTimer = setInterval(async () => {
      if (!this.running || !this.autonomous || this.currentTaskId) return;

      for (const [taskId, baseCount] of this.watchedTasks) {
        try {
          const res = await this.client.getComments(taskId);
          const comments = res.comments;

          if (comments.length > baseCount) {
            const newComments = comments.slice(baseCount);
            const leadComments = newComments.filter(c => c.from === "lead");

            if (leadComments.length > 0) {
              // Lead posted feedback — try to claim and work on it.
              // The task should appear on next-work if the lead moved it back.
              // Update the baseline so we don't re-trigger on same comments.
              this.watchedTasks.set(taskId, comments.length);

              // Trigger an immediate poll to pick it up via normal flow
              if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
              this.pollForWork();
              return;
            } else {
              // Non-lead comments (our own status updates) — update baseline
              this.watchedTasks.set(taskId, comments.length);
            }
          }
        } catch {
          // Daemon unreachable — try next cycle
        }
      }
    }, WATCH_INTERVAL_MS);
  }

  /**
   * Start periodically checking for new lead comments while actively working.
   * If the lead posts a comment while we're mid-task, deliver it to the agent
   * as guidance.
   */
  private startCommentChecking(taskId: string): void {
    this.stopCommentChecking();

    // Initialize with current comment count
    this.client.getComments(taskId).then(res => {
      this.lastSeenCommentCount = res.comments.length;
    }).catch(() => { this.lastSeenCommentCount = 0; });

    this.commentCheckTimer = setInterval(async () => {
      if (!this.currentTaskId || this.currentTaskId !== taskId) {
        this.stopCommentChecking();
        return;
      }
      try {
        const res = await this.client.getComments(taskId);
        const comments = res.comments;

        if (comments.length > this.lastSeenCommentCount) {
          const newComments = comments.slice(this.lastSeenCommentCount);
          const leadComments = newComments.filter(c => c.from === "lead");
          this.lastSeenCommentCount = comments.length;

          if (leadComments.length > 0) {
            const bodies = leadComments.map(c => c.body).join("\n\n");
            this.pi.sendUserMessage(
              `## Message from team lead\n\nThe lead sent you a message while you're working:\n\n"${bodies}"\n\nTake this into account as you continue your work. Acknowledge briefly and continue.`,
              { deliverAs: "followUp" }
            );
          }
        }
      } catch {
        // Daemon unreachable — skip this check
      }
    }, COMMENT_CHECK_INTERVAL_MS);
  }

  /** Stop the comment checking interval */
  private stopCommentChecking(): void {
    if (this.commentCheckTimer) {
      clearInterval(this.commentCheckTimer);
      this.commentCheckTimer = null;
    }
  }
}

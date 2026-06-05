// Teammate work loop: poll → claim → execute → report
//
// Autonomous execution engine for a teammate agent. Uses the daemon's
// agent protocol (/api/agents/*) instead of the old leader server API.
//
// Lifecycle:
// 1. Polls daemon for available work (GET /api/agents/next-work)
// 2. Claims a task (POST /api/agents/claim/:taskId)
// 3. Sends task description as a user message via pi.sendUserMessage()
// 4. Listens for agent_end event to capture the result
// 5. Transitions task to next state (POST /api/agents/transition/:taskId)
// 6. Loops back to polling
//
// The teammate never hardcodes workflow state names — it uses the daemon's
// agent protocol which determines valid transitions server-side.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import type { WorkflowConfig } from "./shared/types.js";

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MESSAGE_CHECK_INTERVAL_MS = 10000;
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
  private messageCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenCommentCount: number = 0;
  private _workflow: WorkflowConfig | null = null;

  // Tasks we've handed off but are still watching for lead replies
  private watchedTasks: Map<string, number> = new Map();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  public onTaskComplete: ((taskId: string, result: string) => void) | null = null;

  constructor(pi: ExtensionAPI, client: DaemonClient) {
    this.pi = pi;
    this.client = client;
  }

  setWorkflow(wf: WorkflowConfig): void {
    this._workflow = wf;
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

  /**
   * Find the next valid state for a teammate from the current state.
   */
  private resolveTeammateTransition(currentStatus: string, fallback: string): string {
    if (!this._workflow) return fallback;
    const transitions = this._workflow.transitions[currentStatus];
    if (!transitions) return fallback;
    for (const [state, perm] of Object.entries(transitions)) {
      if (perm === "teammate" || perm === "any") return state;
    }
    return fallback;
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
    this.stopMessageChecking();
  }

  pause(): void {
    this.autonomous = false;
    this.client.heartbeat("pairing").catch(() => {});
  }

  resume(): void {
    this.autonomous = true;
    if (this.running) this.pollForWork();
  }

  /** Expose a way for external code to toggle permissions */
  public setAutonomousPermissions: ((autonomous: boolean) => void) | null = null;

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const status = this.autonomous
        ? this.currentTaskId ? "working" : "idle"
        : "pairing";
      this.client.heartbeat(status, this.currentTaskId || undefined).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async pollForWork(): Promise<void> {
    if (!this.running || !this.autonomous || this.currentTaskId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextWork();

      if (response.task) {
        if (response.task.workflow) {
          this._workflow = response.task.workflow;
        }
        const claim = await this.client.claimTask(response.task.id);
        if (claim.success) {
          this.currentTaskId = response.task.id;
          this.watchedTasks.delete(response.task.id);
          this.client.heartbeat("working", response.task.id).catch(() => {});
          await this.executeTask(response.task, claim.instructions);
        } else {
          this.schedulePoll();
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

  private async executeTask(task: {
    id: string;
    storyId: string;
    title: string;
    description: string;
    context?: string;
    instructions?: string;
  }, claimInstructions?: string): Promise<void> {
    const instructions = claimInstructions || task.instructions;
    let prompt = ``;
    if (instructions) {
      prompt += `## Transition Instructions\n\n${instructions}\n\n---\n\n`;
    }
    prompt += `## Task: ${task.title}\n**Task ID: ${task.id}** (Story: ${task.storyId})\n\n${task.description}`;
    if (task.context) {
      prompt = `## Context from previous tasks:\n\n${task.context}\n\n---\n\n${prompt}`;
    }
    prompt += `\n\n---\n**Remember: you are working on task ${task.id}. Ignore any task IDs from earlier in this conversation.**`;
    prompt += `\nWhen you're done, provide a brief summary of what you accomplished.`;
    prompt += `\nIf you get stuck and need human guidance, say "NEEDS_INPUT:" followed by your question.`;

    this.startMessageChecking(task.id);
    await this.client.postComment(task.id, `[status] Started working on this task.`).catch(() => {});
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  /** Called by the agent_end handler when the agent finishes */
  async handleAgentComplete(lastMessage: string, tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costFromProvider?: number;
  }): Promise<void> {
    if (!this.currentTaskId) return;

    const taskId = this.currentTaskId;
    this.stopMessageChecking();

    // Report token usage
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await this.client.reportTokenUsage(taskId, {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model: tokenUsage.model,
      }).catch(() => {});
    }

    // Check if agent is asking for help
    if (lastMessage.includes("NEEDS_INPUT:")) {
      const question = lastMessage.split("NEEDS_INPUT:").pop()?.trim() || "Need help with this task";
      await this.client.postComment(taskId, question);
      // Try to transition to needs_input (or equivalent)
      const blockedState = this.resolveTeammateTransition("in_progress", "needs_input");
      await this.client.transitionTask(taskId, blockedState).catch(() => {});
      this.lastCompletedTaskId = this.currentTaskId;
      this.currentTaskId = null;
      this.watchTask(taskId);
      this.schedulePoll();
      return;
    }

    // Task complete — post summary and advance state
    const summary = lastMessage.slice(0, 500);
    await this.client.postComment(taskId, `[done] Work complete. Summary:\n${summary}`).catch(() => {});

    const reviewState = this.resolveTeammateTransition("in_progress", "review");
    const transitionRes = await this.client.transitionTask(taskId, reviewState, summary).catch(() => null);
    this.lastCompletedTaskId = this.currentTaskId;
    this.currentTaskId = null;

    // If there are transition instructions, deliver them
    if (transitionRes?.instructions) {
      this.pi.sendUserMessage(
        `## Transition Instructions\n\n${transitionRes.instructions}`,
        { deliverAs: "followUp" }
      );
    }

    this.onTaskComplete?.(taskId, summary);
    this.watchTask(taskId);
    this.schedulePoll();
  }

  // ─── Message watching (workflow-agnostic) ──────────────────────────

  private async watchTask(taskId: string): Promise<void> {
    try {
      const res = await this.client.getComments(taskId);
      this.watchedTasks.set(taskId, res.comments.length);
    } catch {
      this.watchedTasks.set(taskId, 0);
    }
  }

  private startWatchLoop(): void {
    this.watchTimer = setInterval(async () => {
      if (!this.running || !this.autonomous || this.currentTaskId) return;

      for (const [taskId, baseCount] of this.watchedTasks) {
        try {
          const res = await this.client.getComments(taskId);
          const comments = res.comments;

          if (comments.length > baseCount) {
            const newComments = comments.slice(baseCount);
            const leadComments = newComments.filter(m => m.from === "lead");

            if (leadComments.length > 0) {
              const feedback = leadComments.map(m => m.body).join("\n\n");
              this.currentTaskId = taskId;
              this.watchedTasks.delete(taskId);
              this.startMessageChecking(taskId);
              await this.client.postComment(taskId, `[status] Addressing lead's feedback.`).catch(() => {});

              this.pi.sendUserMessage(
                `## Message from Team Lead\n\nThe lead sent feedback on a task you worked on:\n\n"${feedback}"\n\nPlease address this and provide a summary when done.\nIf you get stuck, say "NEEDS_INPUT:" followed by your question.`,
                { deliverAs: "followUp" }
              );
              return;
            } else {
              this.watchedTasks.set(taskId, comments.length);
            }
          }
        } catch {
          // Server unreachable
        }
      }
    }, WATCH_INTERVAL_MS);
  }

  private startMessageChecking(taskId: string): void {
    this.stopMessageChecking();
    this.client.getComments(taskId).then(res => {
      this.lastSeenCommentCount = res.comments.length;
    }).catch(() => { this.lastSeenCommentCount = 0; });

    this.messageCheckTimer = setInterval(async () => {
      if (!this.currentTaskId || this.currentTaskId !== taskId) {
        this.stopMessageChecking();
        return;
      }
      try {
        const res = await this.client.getComments(taskId);
        const comments = res.comments;
        if (comments.length > this.lastSeenCommentCount) {
          const newComments = comments.slice(this.lastSeenCommentCount);
          const leadComments = newComments.filter(m => m.from === "lead");
          this.lastSeenCommentCount = comments.length;

          if (leadComments.length > 0) {
            const bodies = leadComments.map(m => m.body).join("\n\n");
            this.pi.sendUserMessage(
              `## Message from team lead\n\nThe lead sent you a message while you're working:\n\n"${bodies}"\n\nTake this into account as you continue your work. Acknowledge briefly and continue.`,
              { deliverAs: "followUp" }
            );
          }
        }
      } catch {
        // Server unreachable
      }
    }, MESSAGE_CHECK_INTERVAL_MS);
  }

  private stopMessageChecking(): void {
    if (this.messageCheckTimer) {
      clearInterval(this.messageCheckTimer);
      this.messageCheckTimer = null;
    }
  }
}

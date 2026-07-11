// Teammate work loop: simplified claim/release model
//
// Autonomous execution engine for a teammate agent. Uses the daemon's
// agent protocol (/api/agents/*) with a simple claim/release cycle:
//
// Lifecycle:
// 1. Poll GET /api/agents/next-work → finds unclaimed task with teammate transitions
// 2. Claim POST /api/agents/claim/:taskId → assigns ownership + transitions to working state
// 3. Execute work (send task as user message to Pi agent)
// 4. On agent_end, POST /api/agents/release/:taskId → advances state, releases ownership
// 5. Poll again for next task
//
// The teammate never assumes workflow state names — it relies entirely on
// the daemon to manage transitions. This makes it compatible with any
// workflow configuration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import * as fs from "node:fs";
import * as path from "node:path";

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

export class TeammateLoop {
  private pi: ExtensionAPI;
  private client: DaemonClient;
  private running = false;
  private autonomous = false;
  private currentTaskId: string | null = null;
  private lastCompletedTaskId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  public onTaskComplete: ((taskId: string, result: string) => void) | null = null;

  /** Called when the agent is dismissed from the UI */
  public onDismissed: (() => void) | null = null;

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
    return this.currentTaskId;
  }

  get lastTask(): string | null {
    return this.lastCompletedTaskId;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    this.autonomous = false;
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
        ? this.currentTaskId ? "working" : "idle"
        : "pairing";
      const res = await this.client.heartbeat(status, this.currentTaskId || undefined);
      if (res.dismissed) {
        this.stop();
        if (this.onDismissed) this.onDismissed();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // POLL → CLAIM → EXECUTE
  // ═══════════════════════════════════════════════════════════════════

  private async pollForWork(): Promise<void> {
    if (!this.running || !this.autonomous || this.currentTaskId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextWork();

      // assigned-story agent whose story is exhausted: the daemon archived
      // the story and is telling us to shut down.
      if (response.dismiss) {
        this.debugLog(`[ppt-debug] Received dismiss from next-work — assigned story complete. Stopping.`);
        this.stop();
        if (this.onDismissed) this.onDismissed();
        return;
      }

      if (response.task) {
        // Claim the task — daemon transitions to working state
        const claim = await this.client.claimTask(response.task.id);
        if (!claim.success) {
          // Someone else claimed it — try again
          this.schedulePoll();
          return;
        }

        // We now own this task
        this.currentTaskId = response.task.id;
        this.client.heartbeat("working", response.task.id).catch(() => {});

        // Execute the work using the task info from claim response
        await this.executeTask(
          claim.task || response.task,
          claim.instructions,
          claim.stateContext,
          claim.story
        );
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
    instructions?: string,
    stateContext?: { entered: string; exitsTo?: string; guidance: string; exitInstructions?: string },
    story?: { id: string; title: string; description: string }
  ): Promise<void> {
    let prompt = ``;

    // Story context (the bigger picture)
    if (story) {
      prompt += `## Story: ${story.title}\n\n${story.description}\n\n---\n\n`;
    }

    // State context (what state we're in, what release does)
    if (stateContext) {
      prompt += `## State Context\n\n${stateContext.guidance}\n\n`;
      if (stateContext.exitInstructions) {
        prompt += `### Exit Criteria (for advancing to '${stateContext.exitsTo}')\n\n${stateContext.exitInstructions}\n\n`;
      }
      prompt += `---\n\n`;
    }

    // Transition instructions (from entering the working state)
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

    // Post status comment
    await this.client.postComment(task.id, `[status] Started working on this task.`).catch(() => {});

    // Send to Pi agent — this triggers the agent loop
    this.debugLog(`[ppt-debug] Sending task prompt to agent (task=${task.id}, prompt length=${prompt.length})`);
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  // ═══════════════════════════════════════════════════════════════════
  // AGENT COMPLETION → RELEASE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Called by the agent_end handler when the Pi agent finishes.
   *
   * Posts a summary comment and releases the task. The daemon advances
   * the task to the next workflow state. If the lead wants changes,
   * they add comments and move it back — the agent picks it up again
   * with the additional context.
   */
  async handleAgentComplete(lastMessage: string, tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costFromProvider?: number;
  }): Promise<void> {
    this.debugLog(`[ppt-debug] handleAgentComplete called. currentTaskId=${this.currentTaskId}, msgLen=${lastMessage.length}`);
    if (!this.currentTaskId) {
      this.debugLog(`[ppt-debug] handleAgentComplete: no currentTaskId, returning early`);
      return;
    }

    const taskId = this.currentTaskId;

    // Report token usage
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await this.client.reportTokenUsage(taskId, {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model: tokenUsage.model,
      }).catch(() => {});
    }

    // ─── Release with result ─────────────────────────────────────────
    const summary = lastMessage.slice(0, 500);
    this.debugLog(`[ppt-debug] Releasing task ${taskId} with summary: ${summary.slice(0, 100)}...`);
    await this.client.postComment(taskId, `[done] Work complete. Summary:\n${summary}`).catch(() => {});

    // Release the task — daemon advances to next state
    const releaseRes = await this.client.releaseTask(taskId, summary).catch((e) => {
      this.debugLog(`[ppt-debug] releaseTask FAILED: ${e}`);
      return null;
    });
    this.debugLog(`[ppt-debug] releaseTask response: ${JSON.stringify(releaseRes)}`);
    this.lastCompletedTaskId = taskId;
    this.currentTaskId = null;

    if (releaseRes?.completed) {
      this.onTaskComplete?.(taskId, summary);
    }

    this.schedulePoll();
  }
}

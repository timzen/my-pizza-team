// Teammate work loop: poll → claim → execute → report
//
// This is the autonomous execution engine for a teammate Pi.
// It manages the lifecycle of task execution:
//
// 1. Polls the leader API for available tasks (every 5s)
// 2. Claims a task atomically (prevents double-assignment)
// 3. Sends the task description as a user message via pi.sendUserMessage()
//    → This triggers the normal Pi agent loop (the teammate "works" on it)
// 4. Listens for agent_end event to capture the result
// 5. Reports completion (or asks for help if stuck)
// 6. Loops back to polling
//
// Mode management:
// - `autonomous` = true: actively polling and executing tasks
// - `autonomous` = false: paused (human is pairing in this window)
//
// Message handling is workflow-agnostic:
// - While actively working: checks for new lead messages every 10s and
//   delivers them to the agent as guidance.
// - While idle (task handed off): watches for lead messages and picks the
//   task back up to address feedback, regardless of what state it's in.
// - The teammate never hardcodes workflow state names — it reacts purely
//   to the presence of new lead messages.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamClient } from "./client.js";
import type { WorkflowConfig } from "../shared/types.js";

const POLL_INTERVAL_MS = 5000; // 5 seconds between polls
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
const MESSAGE_CHECK_INTERVAL_MS = 10000; // 10 seconds between message checks while working
const WATCH_INTERVAL_MS = 10000; // 10 seconds between checks on handed-off tasks

export class WorkLoop {
  private pi: ExtensionAPI;
  private client: TeamClient;
  private memberId: string;
  private running = false;
  private autonomous = false;
  private currentTaskId: string | null = null;
  private lastCompletedTaskId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenMessageCount: number = 0;

  // Tasks we've handed off but are still watching for lead replies.
  // Maps taskId → message count at time of handoff (so we only react to new messages).
  private watchedTasks: Map<string, number> = new Map();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  // Callback to check if we should stay autonomous
  // (e.g., detect if human is typing)
  public onTaskComplete: ((taskId: string, result: string) => void) | null = null;

  constructor(pi: ExtensionAPI, client: TeamClient, memberId: string) {
    this.pi = pi;
    this.client = client;
    this.memberId = memberId;
  }

  /** Set the workflow config (received from server on join) */
  setWorkflow(wf: WorkflowConfig): void {
    this._workflow = wf;
  }
  private _workflow: WorkflowConfig | null = null;

  /**
   * Find the next valid state for a teammate from the current state.
   * Looks at transitions from currentStatus where permission is "teammate".
   * Falls back to the given default if no match found.
   */
  private resolveTeammateTransition(currentStatus: string, fallback: string): string {
    if (!this._workflow) return fallback;
    const transitions = this._workflow.transitions[currentStatus];
    if (!transitions) return fallback;
    // Find a state the teammate can transition to
    for (const [state, perm] of Object.entries(transitions)) {
      if (perm === "teammate" || perm === "any") return state;
    }
    return fallback;
  }

  get isAutonomous(): boolean {
    return this.autonomous;
  }

  get currentTask(): string | null {
    return this.currentTaskId;
  }

  /** The most recently completed task (for tools that run after task handoff) */
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
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.stopMessageChecking();
  }

  /** Pause autonomous work (e.g., human is mentoring) */
  pause(): void {
    this.autonomous = false;
    this.client.heartbeat("pairing").catch(() => {});
  }

  /** Resume autonomous work */
  resume(): void {
    this.autonomous = true;
    if (this.running) {
      this.pollForWork();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const status = this.autonomous
        ? this.currentTaskId ? "working" : "idle"
        : "pairing";
      this.client.heartbeat(status, this.currentTaskId || undefined).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async pollForWork(): Promise<void> {
    if (!this.running) return;

    // Don't poll if not autonomous or already working
    if (!this.autonomous || this.currentTaskId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextTask();

      if (response.task) {
        // Update workflow for this task (may differ per story)
        if (response.task.workflow) {
          this._workflow = response.task.workflow;
        }
        // Claim the task
        const claim = await this.client.claimTask(response.task.id);
        if (claim.success) {
          this.currentTaskId = response.task.id;
          // Stop watching this task if we had it in the watch list
          this.watchedTasks.delete(response.task.id);
          this.client.heartbeat("working", response.task.id).catch(() => {});
          await this.executeTask(response.task, claim.instructions);
        } else {
          // Someone else got it, try again
          this.schedulePoll();
        }
      } else {
        // No work available, keep polling
        this.schedulePoll();
      }
    } catch (err) {
      // Server unreachable, retry later
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
  }, instructions?: string): Promise<void> {
    // Build the prompt for the Pi agent
    let prompt = ``;
    if (instructions) {
      prompt += `## Transition Instructions\n\n${instructions}\n\n---\n\n`;
    }
    prompt += `## Task: ${task.title}\n\n${task.description}`;
    if (task.context) {
      prompt = `## Context from previous tasks:\n\n${task.context}\n\n---\n\n${prompt}`;
    }
    prompt += `\n\n---\nWhen you're done, provide a brief summary of what you accomplished.`;
    prompt += `\nIf you get stuck and need human guidance, say "NEEDS_INPUT:" followed by your question.`;

    // Start checking for new messages while working
    this.startMessageChecking(task.id);

    // Post a status message noting work has begun
    await this.client.postMessage(task.id, `[status] Started working on this task.`).catch(() => {});

    // Send as a user message — this triggers the agent loop
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });

    // The agent_end event handler will pick up the result
    // (registered in index.ts)
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

    // Stop checking messages for this task
    this.stopMessageChecking();

    // Report token usage from the agent's actual usage data
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await this.client.reportTokenUsage(taskId, {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model: tokenUsage.model,
      }).catch(() => {});
    }

    // Check if the agent is asking for help
    if (lastMessage.includes("NEEDS_INPUT:")) {
      const question = lastMessage.split("NEEDS_INPUT:").pop()?.trim() || "Need help with this task";
      await this.client.postMessage(taskId, question);
      // Transition to the workflow's "blocked" state — the server decides
      // what transitions are valid. "needs_input" is conventional but the
      // teammate just requests it; if the workflow doesn't have it, this
      // will 403 and the task stays in its current state (still fine — the
      // message is posted either way, and the lead can respond).
      await this.client.updateStatus(taskId, "needs_input").catch(() => {});
      this.lastCompletedTaskId = this.currentTaskId;
    this.currentTaskId = null;
      // Watch for lead's reply
      this.watchTask(taskId);
      this.schedulePoll();
      return;
    }

    // Task complete — post a summary and advance to next state
    const summary = lastMessage.slice(0, 500);
    await this.client.postMessage(taskId, `[done] Work complete. Summary:\n${summary}`).catch(() => {});

    // Try to advance to "review" — if the workflow doesn't have this
    // transition, it'll 403 and the task stays put. The lead can move it
    // manually. The message is posted either way so they have the summary.
    const reviewState = this.resolveTeammateTransition("in_progress", "review");
    const statusResponse = await this.client.updateStatus(taskId, reviewState, summary).catch(() => null);
    this.lastCompletedTaskId = this.currentTaskId;
    this.currentTaskId = null;

    // If there are transition instructions, deliver them
    if (statusResponse?.instructions) {
      this.pi.sendUserMessage(
        `## Transition Instructions\n\n${statusResponse.instructions}`,
        { deliverAs: "followUp" }
      );
    }

    this.onTaskComplete?.(taskId, summary);

    // Watch for lead feedback on this task
    this.watchTask(taskId);
    this.schedulePoll();
  }

  // ─── Unified message watching (workflow-agnostic) ──────────────────

  /**
   * Start watching a task we've handed off. If the lead posts a new
   * message, we'll pick it back up and address it — regardless of what
   * workflow state the task is in.
   */
  private async watchTask(taskId: string): Promise<void> {
    try {
      const res = await this.client.getMessages(taskId);
      this.watchedTasks.set(taskId, res.messages.length);
    } catch {
      this.watchedTasks.set(taskId, 0);
    }
  }

  /** Stop watching a task (e.g., we picked it back up) */
  private unwatchTask(taskId: string): void {
    this.watchedTasks.delete(taskId);
  }

  /**
   * Periodic check on all watched tasks. If any have new lead messages,
   * pick up the most recent one and address the feedback.
   */
  private startWatchLoop(): void {
    this.watchTimer = setInterval(async () => {
      if (!this.running || !this.autonomous) return;
      // Don't interrupt active work
      if (this.currentTaskId) return;

      for (const [taskId, baseCount] of this.watchedTasks) {
        try {
          const res = await this.client.getMessages(taskId);
          const messages = res.messages;

          if (messages.length > baseCount) {
            const newMessages = messages.slice(baseCount);
            const leadMessages = newMessages.filter(m => m.from === "lead");

            if (leadMessages.length > 0) {
              // Lead sent feedback — pick this task back up
              const feedback = leadMessages.map(m => m.body).join("\n\n");
              this.currentTaskId = taskId;
              this.unwatchTask(taskId);
              this.startMessageChecking(taskId);
              await this.client.postMessage(taskId, `[status] Addressing lead's feedback.`).catch(() => {});

              this.pi.sendUserMessage(
                `## Message from Team Lead\n\nThe lead sent feedback on a task you worked on:\n\n"${feedback}"\n\nPlease address this and provide a summary when done.\nIf you get stuck, say "NEEDS_INPUT:" followed by your question.`,
                { deliverAs: "followUp" }
              );
              return; // Handle one at a time
            } else {
              // New messages but not from lead (maybe our own status messages)
              // Update the baseline so we don't re-check these
              this.watchedTasks.set(taskId, messages.length);
            }
          }
        } catch {
          // Server unreachable, try next time
        }
      }
    }, WATCH_INTERVAL_MS);
  }

  // ─── Message checking while actively working ───────────────────────

  /** Start periodically checking for new messages from the lead */
  private startMessageChecking(taskId: string): void {
    this.stopMessageChecking();
    // Initialize with current message count so we only react to NEW messages
    this.client.getMessages(taskId).then(res => {
      this.lastSeenMessageCount = res.messages.length;
    }).catch(() => {
      this.lastSeenMessageCount = 0;
    });

    this.messageCheckTimer = setInterval(async () => {
      if (!this.currentTaskId || this.currentTaskId !== taskId) {
        this.stopMessageChecking();
        return;
      }
      try {
        const res = await this.client.getMessages(taskId);
        const messages = res.messages;
        if (messages.length > this.lastSeenMessageCount) {
          // Find new messages from the lead
          const newMessages = messages.slice(this.lastSeenMessageCount);
          const leadMessages = newMessages.filter(m => m.from === "lead");
          this.lastSeenMessageCount = messages.length;

          if (leadMessages.length > 0) {
            // Deliver lead messages to the agent as guidance
            const bodies = leadMessages.map(m => m.body).join("\n\n");
            this.pi.sendUserMessage(
              `## Message from team lead\n\nThe lead sent you a message while you're working:\n\n"${bodies}"\n\nTake this into account as you continue your work. Acknowledge briefly and continue.`,
              { deliverAs: "followUp" }
            );
          }
        }
      } catch {
        // Server unreachable, skip this check
      }
    }, MESSAGE_CHECK_INTERVAL_MS);
  }

  /** Stop the message checking interval */
  private stopMessageChecking(): void {
    if (this.messageCheckTimer) {
      clearInterval(this.messageCheckTimer);
      this.messageCheckTimer = null;
    }
  }
}

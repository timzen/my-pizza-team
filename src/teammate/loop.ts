// Teammate work loop: poll → claim → execute → report
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamClient } from "./client.js";

const POLL_INTERVAL_MS = 5000; // 5 seconds between polls
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

export class WorkLoop {
  private pi: ExtensionAPI;
  private client: TeamClient;
  private memberId: string;
  private running = false;
  private autonomous = false;
  private currentTaskId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Callback to check if we should stay autonomous
  // (e.g., detect if human is typing)
  public onTaskComplete: ((taskId: string, result: string) => void) | null = null;

  constructor(pi: ExtensionAPI, client: TeamClient, memberId: string) {
    this.pi = pi;
    this.client = client;
    this.memberId = memberId;
  }

  get isAutonomous(): boolean {
    return this.autonomous;
  }

  get currentTask(): string | null {
    return this.currentTaskId;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
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
  }

  /** Pause autonomous work (e.g., human is mentoring) */
  pause(): void {
    this.autonomous = false;
    this.client.heartbeat("pairing").catch(() => {});
  }

  /** Resume autonomous work */
  resume(): void {
    if (this.running && !this.autonomous) {
      this.autonomous = true;
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
        // Claim the task
        const claim = await this.client.claimTask(response.task.id);
        if (claim.success) {
          this.currentTaskId = response.task.id;
          await this.executeTask(response.task);
        } else {
          // Someone else got it, try again
          this.schedulePoll();
        }
      } else {
        // No work available
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
  }): Promise<void> {
    // Build the prompt for the Pi agent
    let prompt = `## Task: ${task.title}\n\n${task.description}`;
    if (task.context) {
      prompt = `## Context from previous tasks:\n\n${task.context}\n\n---\n\n${prompt}`;
    }
    prompt += `\n\n---\nWhen you're done, provide a brief summary of what you accomplished.`;
    prompt += `\nIf you get stuck and need human guidance, say "NEEDS_INPUT:" followed by your question.`;

    // Send as a user message — this triggers the agent loop
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });

    // The agent_end event handler will pick up the result
    // (registered in index.ts)
  }

  /** Called by the agent_end handler when the agent finishes */
  async handleAgentComplete(lastMessage: string): Promise<void> {
    if (!this.currentTaskId) return;

    const taskId = this.currentTaskId;

    // Check if the agent is asking for help
    if (lastMessage.includes("NEEDS_INPUT:")) {
      const question = lastMessage.split("NEEDS_INPUT:").pop()?.trim() || "Need help with this task";
      await this.client.postMessage(taskId, question);
      await this.client.updateStatus(taskId, "needs_input");
      this.currentTaskId = null;

      // Poll for when it's moved back to in_progress
      this.waitForUnblock(taskId);
      return;
    }

    // Task complete
    const result = lastMessage.slice(0, 500); // Keep result concise
    await this.client.updateStatus(taskId, "review", result);
    this.currentTaskId = null;

    this.onTaskComplete?.(taskId, result);

    // Poll for next task
    this.schedulePoll();
  }

  /** Wait for a blocked task to be unblocked by the lead */
  private async waitForUnblock(taskId: string): Promise<void> {
    const check = async () => {
      if (!this.running || !this.autonomous) return;

      try {
        const messages = await this.client.getMessages(taskId);
        const lastMsg = messages.messages[messages.messages.length - 1];

        // If lead replied, resume the task
        if (lastMsg && lastMsg.from === "lead") {
          this.currentTaskId = taskId;
          const guidance = `The team lead replied to your question:\n\n"${lastMsg.body}"\n\nPlease continue working on the task with this guidance.`;
          this.pi.sendUserMessage(guidance, { deliverAs: "followUp" });
          return;
        }
      } catch {
        // Server unreachable
      }

      // Check again
      setTimeout(check, POLL_INTERVAL_MS);
    };

    setTimeout(check, POLL_INTERVAL_MS);
  }
}

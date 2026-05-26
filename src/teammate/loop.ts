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
// The loop also handles the "needs_input" flow:
// - If the agent's response contains "NEEDS_INPUT:", it posts the question
//   to the leader and waits for a reply before continuing.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamClient } from "./client.js";

const POLL_INTERVAL_MS = 5000; // 5 seconds between polls
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
const MESSAGE_CHECK_INTERVAL_MS = 10000; // 10 seconds between message checks while working

export class WorkLoop {
  private pi: ExtensionAPI;
  private client: TeamClient;
  private memberId: string;
  private running = false;
  private autonomous = false;
  private currentTaskId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenMessageCount: number = 0;

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
        // Claim the task
        const claim = await this.client.claimTask(response.task.id);
        if (claim.success) {
          this.currentTaskId = response.task.id;
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
  async handleAgentComplete(lastMessage: string): Promise<void> {
    if (!this.currentTaskId) return;

    const taskId = this.currentTaskId;

    // Stop checking messages for this task (will restart if unblocked)
    this.stopMessageChecking();

    // Check if the agent is asking for help
    if (lastMessage.includes("NEEDS_INPUT:")) {
      const question = lastMessage.split("NEEDS_INPUT:").pop()?.trim() || "Need help with this task";
      await this.client.postMessage(taskId, `[needs_input] ${question}`);
      await this.client.updateStatus(taskId, "needs_input");
      this.currentTaskId = null;

      // Poll for when it's moved back to in_progress
      this.waitForUnblock(taskId);
      return;
    }

    // Task complete — post a summary message before transitioning
    const summary = lastMessage.slice(0, 500); // Keep result concise
    await this.client.postMessage(taskId, `[review] Work complete. Summary:\n${summary}`).catch(() => {});

    const statusResponse = await this.client.updateStatus(taskId, "review", summary);
    this.currentTaskId = null;

    // If there are on-enter-review instructions, send them as a follow-up message
    if (statusResponse.instructions) {
      this.pi.sendUserMessage(
        `## Review Instructions\n\n${statusResponse.instructions}`,
        { deliverAs: "followUp" }
      );
    }

    this.onTaskComplete?.(taskId, summary);

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
          this.startMessageChecking(taskId);
          await this.client.postMessage(taskId, `[status] Resuming work with lead's guidance.`).catch(() => {});
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

  // --- Message checking while working ---

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

// Unified HTTP client for extension → daemon communication
//
// Wraps all API calls the pi-pizza-team extension makes to the
// my-pizza-team daemon. Implements the daemon's agent protocol
// (/api/agents/*) plus supporting endpoints for stories, tasks,
// assistant queue, memory notes, and spawn requests.
//
// Replaces the old teammate/client.ts and assistant/client.ts with
// a single client. All roles (leader, teammate, assistant) use this.
//
// Error handling: methods throw a DaemonError on non-2xx responses
// with the error message from the response body. Callers should catch
// these for graceful degradation (e.g., daemon unreachable during polling).
//
// See /docs/ARCHITECTURE.md for the full route list and data flow.

import * as os from "node:os";
import type { WorkflowConfig } from "./shared/types.js";

// ─── Error Type ──────────────────────────────────────────────────────

/** Error thrown when the daemon returns a non-2xx response */
export class DaemonError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DaemonError";
    this.statusCode = statusCode;
  }
}

// ─── Response Types ──────────────────────────────────────────────────

/** Response from POST /api/agents/register */
export interface AgentRegisterResponse {
  success: boolean;
  config?: {
    defaultWorkflow: string;
    workflows: Record<string, WorkflowConfig>;
    tmuxSession: string;
    favoriteDirectories: string[];
  };
  error?: string;
}

/** Response from GET /api/agents/next-work */
export interface AgentNextWorkResponse {
  task: {
    id: string;
    storyId: string;
    title: string;
    description: string;
    status: string;
    context?: string;
    comments?: Array<{ from: string; body: string; at: string }>;
    workflow?: WorkflowConfig;
    availableTransitions: Array<{ state: string; permission: string }>;
  } | null;
}

/** Response from POST /api/agents/claim/:taskId */
export interface AgentClaimResponse {
  success: boolean;
  task?: {
    id: string;
    storyId: string;
    title: string;
    description: string;
    status: string;
  };
  availableTransitions?: Array<{ state: string; permission: string }>;
  error?: string;
}

/** Response from POST /api/agents/transition/:taskId */
export interface AgentTransitionResponse {
  success: boolean;
  released?: boolean;
  instructions?: string;
  availableTransitions?: Array<{ state: string; permission: string }>;
  error?: string;
}

/** Response from POST /api/agents/release/:taskId */
export interface AgentReleaseResponse {
  success: boolean;
  error?: string;
}

/** Response from GET /api/agents/comments/:taskId */
export interface CommentsResponse {
  comments: Array<{
    from: string;
    body: string;
    at: string;
    attachments?: Array<{ name: string; size: number; type: string }>;
  }>;
}

/** Response from POST /api/tasks/:id/token-usage */
export interface TokenUsageResponse {
  success: boolean;
  costUsd?: number;
  error?: string;
}

/** Response from GET /api/assistant/next */
export interface AssistantNextResponse {
  item: { id: string; prompt: string } | null;
}

/** Response from POST /api/assistant/queue/:id/claim */
export interface AssistantClaimResponse {
  success: boolean;
  error?: string;
}

/** Response from POST /api/assistant/queue/:id/complete */
export interface AssistantCompleteResponse {
  success: boolean;
  error?: string;
}

/** Response from POST /api/assistant/notes */
export interface AssistantSaveNoteResponse {
  success: boolean;
  note?: {
    id: string;
    title: string;
    content: string;
    categories: string[];
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
}

/** Response from GET /api/assistant/notes/search */
export interface NotesSearchResponse {
  results: Array<{ title: string; score: number; snippet: string }>;
}

/** Response from GET /api/spawn-requests */
export interface SpawnRequestsResponse {
  requests: Array<{
    id: string;
    name: string;
    cwd: string;
    leaderUrl: string;
  }>;
}

/** Response from GET /api/status */
export interface StatusResponse {
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  inbox: number;
  defaultWorkflow: string;
  workflows: Record<string, { states: string[]; transitions: Record<string, Record<string, string>> }>;
}

/** Response from POST /api/stories */
export interface CreateStoryResponse {
  success: boolean;
  story?: { id: string; title: string };
  error?: string;
}

/** Response from POST /api/stories/:storyId/tasks */
export interface CreateTaskResponse {
  success: boolean;
  task?: { id: string; seq: number; title: string };
  error?: string;
}

/** Response from POST /api/tasks/:id/attachments */
export interface UploadAttachmentResponse {
  success: boolean;
  type?: string;
  error?: string;
}

// ─── Client Class ────────────────────────────────────────────────────

/**
 * Unified HTTP client for the my-pizza-team daemon.
 *
 * Constructor takes the daemon URL, an agent ID (unique per Pi instance),
 * and an optional auth token (reserved for future multi-user auth).
 *
 * The `hostId` property is derived from `os.hostname()` by default and
 * used for spawn request scoping (only the host that matches gets spawns).
 */
export class DaemonClient {
  private baseUrl: string;
  private agentId: string;
  private authToken: string | undefined;

  /** Host identifier for spawn request scoping (defaults to os.hostname()) */
  public readonly hostId: string;

  constructor(daemonUrl: string, agentId: string, options?: { authToken?: string; hostId?: string }) {
    this.baseUrl = daemonUrl.replace(/\/$/, "");
    this.agentId = agentId;
    this.authToken = options?.authToken;
    this.hostId = options?.hostId || os.hostname();
  }

  /** The agent's unique ID */
  get id(): string {
    return this.agentId;
  }

  /** The daemon's base URL */
  get url(): string {
    return this.baseUrl;
  }

  // ─── Internal Helpers ────────────────────────────────────────────

  /**
   * Make a fetch request with standard headers. Throws DaemonError on
   * non-2xx responses with the error message from the response body.
   */
  private async request(path: string, options?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string> || {}),
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    if (options?.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json() as any;
        if (body.error) errorMsg = body.error;
      } catch {
        // If body isn't JSON, use status text
        errorMsg = res.statusText || errorMsg;
      }
      throw new DaemonError(errorMsg, res.status);
    }

    return res;
  }

  /** POST with JSON body, returns parsed JSON */
  private async post<T>(path: string, body: Record<string, any>): Promise<T> {
    const res = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }

  /** GET, returns parsed JSON */
  private async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return res.json() as Promise<T>;
  }

  /** DELETE, returns parsed JSON */
  private async delete<T>(path: string): Promise<T> {
    const res = await this.request(path, { method: "DELETE" });
    return res.json() as Promise<T>;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HEALTH
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Check if the daemon is reachable.
   * Returns true if GET /health responds with 2xx, false otherwise.
   * Never throws — safe for polling loops.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get the daemon's status summary (stories, tasks, members, inbox).
   */
  async getStatus(): Promise<StatusResponse> {
    return this.get<StatusResponse>("/api/status");
  }

  // ═══════════════════════════════════════════════════════════════════
  // AGENT PROTOCOL
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register this agent with the daemon.
   *
   * Called once at startup. Provides the agent's name, working directory,
   * hostId (for multi-host spawn routing), and capabilities.
   *
   * Returns workflow config and host-specific settings.
   */
  async register(opts: {
    name: string;
    cwd: string;
    capabilities?: string[];
  }): Promise<AgentRegisterResponse> {
    return this.post<AgentRegisterResponse>("/api/agents/register", {
      id: this.agentId,
      name: opts.name,
      cwd: opts.cwd,
      hostId: this.hostId,
      capabilities: opts.capabilities || ["http", "tools", "messages"],
    });
  }

  /**
   * Deregister this agent from the daemon.
   *
   * Called on clean shutdown. Releases any task assignments and removes
   * the agent from the team. The daemon also auto-reaps agents that
   * stop sending heartbeats.
   */
  async deregister(): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/agents/${encodeURIComponent(this.agentId)}`);
  }

  /**
   * Send a heartbeat to the daemon.
   *
   * Called periodically (e.g., every 30s) to confirm the agent is alive.
   * If heartbeats stop, the daemon considers the agent offline and may
   * release its assigned tasks.
   *
   * Never throws — safe for background intervals.
   */
  async heartbeat(status: "idle" | "working" | "pairing", currentTask?: string): Promise<void> {
    try {
      await this.post<{ success: boolean }>("/api/agents/heartbeat", {
        id: this.agentId,
        status,
        currentTask,
      });
    } catch {
      // Heartbeat failures are non-fatal — daemon may be temporarily unreachable
    }
  }

  /**
   * Poll for available work.
   *
   * Returns the next unclaimed task that has teammate-allowed transitions
   * from its current state. This covers both fresh tasks (in initial state)
   * and tasks returned by the lead (e.g., moved back with comments).
   *
   * Includes task comments so the agent can see lead feedback before starting.
   * Returns `{ task: null }` if no work is available or distribution is paused.
   */
  async getNextWork(): Promise<AgentNextWorkResponse> {
    return this.get<AgentNextWorkResponse>(
      `/api/agents/next-work?agentId=${encodeURIComponent(this.agentId)}`
    );
  }

  /**
   * Claim ownership of a task (no state change).
   *
   * Assigns the task to this agent. The agent should then call
   * `transitionTask()` to advance state. This separation allows reading
   * instructions and comments before deciding which transition to make.
   *
   * Returns the task's current state info and available transitions.
   */
  async claimTask(taskId: string): Promise<AgentClaimResponse> {
    return this.post<AgentClaimResponse>(
      `/api/agents/claim/${encodeURIComponent(taskId)}`,
      { agentId: this.agentId }
    );
  }

  /**
   * Advance a claimed task to the next state.
   *
   * Validates the transition against workflow permissions. On success:
   * - Updates task status (and optionally stores a result summary)
   * - If the new state is the done state, auto-releases the assignment
   * - Returns next available transitions so the agent knows if it can
   *   keep going or needs to release
   * - Returns transition instructions for the new state (if any)
   *
   * The `status` parameter is the target state name.
   */
  async transitionTask(taskId: string, status: string, result?: string): Promise<AgentTransitionResponse> {
    return this.post<AgentTransitionResponse>(
      `/api/agents/transition/${encodeURIComponent(taskId)}`,
      { agentId: this.agentId, status, result }
    );
  }

  /**
   * Release a task when blocked by a lead-only transition.
   *
   * Called when the agent hits a state where only the lead can make the
   * next move (e.g., `review → done`). Releases the assignment so the
   * lead can act. The agent may later re-discover and re-claim this task
   * if the lead moves it to a new state with teammate transitions.
   */
  async releaseTask(taskId: string): Promise<AgentReleaseResponse> {
    return this.post<AgentReleaseResponse>(
      `/api/agents/release/${encodeURIComponent(taskId)}`,
      { agentId: this.agentId }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMENTS (replaces old "messages")
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get comments for a task.
   *
   * Returns the full conversation history. Agents load this when starting
   * work on a task to see lead feedback, review comments, or rework
   * instructions.
   */
  async getComments(taskId: string): Promise<CommentsResponse> {
    return this.get<CommentsResponse>(
      `/api/agents/comments/${encodeURIComponent(taskId)}`
    );
  }

  /**
   * Post a comment on a task.
   *
   * Used for status updates, work summaries, questions, or attaching files.
   * Comments are task-level and visible to the lead and any future agent.
   */
  async postComment(taskId: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(
      `/api/agents/comments/${encodeURIComponent(taskId)}`,
      { agentId: this.agentId, body, attachments }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // TOKEN USAGE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Report token usage for a task.
   *
   * Records input/output token counts and model name. The daemon
   * calculates estimated cost and stores it with the task.
   */
  async reportTokenUsage(taskId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  }): Promise<TokenUsageResponse> {
    return this.post<TokenUsageResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/token-usage`,
      usage
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Upload a file attachment to a task.
   *
   * Stores the file in the task's attachments directory. The daemon
   * auto-detects the file type (diff, markdown, json, etc.).
   */
  async uploadAttachment(taskId: string, filename: string, content: string): Promise<UploadAttachmentResponse> {
    return this.post<UploadAttachmentResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
      { name: filename, content, encoding: "utf-8" }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // SPAWN REQUESTS (leader only)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Poll for pending spawn requests targeted at this host.
   *
   * The daemon queues spawn requests (from the web UI or API) and this
   * method returns any that match the given hostId. The leader executes
   * the spawns via tmux and acknowledges each one.
   */
  async getSpawnRequests(): Promise<SpawnRequestsResponse> {
    return this.get<SpawnRequestsResponse>(
      `/api/spawn-requests?hostId=${encodeURIComponent(this.hostId)}`
    );
  }

  /**
   * Acknowledge that a spawn request has been executed.
   *
   * Removes the request from the daemon's pending queue.
   */
  async ackSpawnRequest(requestId: string): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(
      `/api/spawn-requests/${encodeURIComponent(requestId)}/ack`,
      {}
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // ASSISTANT QUEUE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get next pending item from the assistant queue.
   *
   * Returns `{ item: null }` if the queue is empty.
   */
  async getNextQueueItem(): Promise<AssistantNextResponse> {
    return this.get<AssistantNextResponse>("/api/assistant/next");
  }

  /**
   * Claim an assistant queue item for processing.
   *
   * Marks the item as "processing" so no other assistant picks it up.
   */
  async claimQueueItem(id: string): Promise<AssistantClaimResponse> {
    return this.post<AssistantClaimResponse>(
      `/api/assistant/queue/${encodeURIComponent(id)}/claim`,
      {}
    );
  }

  /**
   * Complete an assistant queue item with a result.
   *
   * Marks the item as done (or failed) and stores the result text.
   */
  async completeQueueItem(id: string, result?: string, failed = false): Promise<AssistantCompleteResponse> {
    return this.post<AssistantCompleteResponse>(
      `/api/assistant/queue/${encodeURIComponent(id)}/complete`,
      { result, status: failed ? "failed" : "done" }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // MEMORY NOTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Save a memory note to the team's knowledge base.
   *
   * Notes are markdown documents with categories for organization.
   * They're indexed by the daemon's BM25 search engine.
   */
  async saveNote(title: string, content: string, categories: string[]): Promise<AssistantSaveNoteResponse> {
    return this.post<AssistantSaveNoteResponse>("/api/assistant/notes", {
      title,
      content,
      categories,
    });
  }

  /**
   * Search memory notes by keyword.
   *
   * Uses BM25 full-text search. Optionally filter by category and limit results.
   */
  async searchNotes(query: string, category?: string, limit?: number): Promise<NotesSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (category) params.set("category", category);
    if (limit) params.set("limit", String(limit));
    return this.get<NotesSearchResponse>(`/api/assistant/notes/search?${params}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STORIES / TASKS (for leader tools)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create a new story on the kanban board.
   *
   * Optionally include inline tasks to create them in the same request.
   */
  async createStory(story: {
    id: string;
    title: string;
    description: string;
    dependsOn?: string[];
    dir?: string;
    workflow?: string;
    categories?: string[];
    tasks?: Array<{ title: string; description: string }>;
  }): Promise<CreateStoryResponse> {
    return this.post<CreateStoryResponse>("/api/stories", story);
  }

  /**
   * Update an existing story's fields.
   *
   * Only the provided fields are changed. Set fields to null to clear them.
   */
  async updateStory(storyId: string, updates: Record<string, any>): Promise<{ success: boolean; error?: string }> {
    const res = await this.request(`/api/stories/${encodeURIComponent(storyId)}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    return res.json() as Promise<{ success: boolean; error?: string }>;
  }

  /**
   * Add a task to an existing story.
   *
   * Tasks are sequential within a story — the daemon assigns the next
   * sequence number automatically.
   */
  async createTask(storyId: string, title: string, description: string): Promise<CreateTaskResponse> {
    return this.post<CreateTaskResponse>(
      `/api/stories/${encodeURIComponent(storyId)}/tasks`,
      { title, description }
    );
  }

  /**
   * Enqueue a free-form request for the assistant to process.
   *
   * The assistant polls the queue and processes items in order.
   */
  async enqueueAssistantRequest(prompt: string): Promise<{ success: boolean; item?: { id: string }; error?: string }> {
    return this.post<{ success: boolean; item?: { id: string }; error?: string }>(
      "/api/assistant/queue",
      { prompt }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get the daemon's current configuration.
   *
   * Returns port, tmuxSession, defaultWorkflow, categories, etc.
   */
  async getConfig(): Promise<any> {
    return this.get<any>("/api/config");
  }

  /**
   * Get host-specific configuration (directories, tmuxSession).
   *
   * Used by the leader to get its host's settings from the daemon.
   */
  async getHostConfig(): Promise<any> {
    return this.get<any>(`/api/hosts/${encodeURIComponent(this.hostId)}`);
  }
}

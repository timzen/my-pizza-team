// Unified HTTP client for extension → daemon communication
//
// Wraps all API calls the pi-pizza-team extension makes to the
// my-pizza-team daemon. Implements the daemon's agent protocol
// (/api/agents/*) plus supporting endpoints for stories, tasks,
// assistant queue, context library, and spawn requests.
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
  };
  error?: string;
}

/** Response from GET /api/agents/next-work */
export interface AgentNextWorkResponse {
  workItem: { id: string; title: string } | null;
}

/** Response from POST /api/agents/claim/:workItemId */
export interface AgentClaimResponse {
  success: boolean;
  /** Minimal bookkeeping id (the prose is in `prompt`). */
  workItem?: { id: string };
  /** Full assembled prompt from the daemon — delivered verbatim to the agent. */
  prompt?: string;
  error?: string;
}

/** Response from POST /api/agents/work-items/:workItemId/state */
export interface AgentSetStateResponse {
  success: boolean;
  newStatus?: string;
  completed?: boolean;
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

/** Response from POST /api/assistant/messages/:id/complete */
export interface AssistantCompleteResponse {
  success: boolean;
  error?: string;
}

/** Response from POST /api/assistant/messages/:id/say */
export interface AssistantSayResponse {
  success: boolean;
  error?: string;
}

/** A context-library entry (reusable prompt/context; see daemon /api/context). */
export interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** A Thoughts-board sticky note (see the daemon's Thought type). */
export interface Thought {
  id: string;
  content: string;
  color: string;
  status: "active" | "archived";
  pinned: boolean;
  groupId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A named group of thoughts. */
export interface ThoughtGroup { id: string; title: string; }

/** A workflow summary from GET /api/workflows. */
export interface WorkflowSummary {
  name: string;
  stateCount: number;
  agentCount: number;
  manualCount: number;
  isDefault: boolean;
}

/** A leader directive: an ask to the leader to act on an agent. */
export interface LeaderDirective {
  id: string;
  action: string;
  memberId?: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  createdAt: string;
}

/** Response from GET /api/hosts/:hostId/leader/directives */
export interface LeaderDirectivesResponse {
  directives: LeaderDirective[];
}

/** Response from POST /api/hosts/:hostId/leader/directives */
export interface CreateLeaderDirectiveResponse {
  success: boolean;
  directive?: LeaderDirective;
  error?: string;
}

/** Response from GET /api/status */
export interface StatusResponse {
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
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

  /** PUT with JSON body, returns parsed JSON */
  private async put<T>(path: string, body: Record<string, any>): Promise<T> {
    const res = await this.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
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
   * hostId (for multi-host spawn routing), and its working directory.
   *
   * Returns workflow config and host-specific settings.
   */
  async register(opts: {
    name: string;
    /** The agent's working directory (its pi cwd). Drives directory-affinity matching. */
    directory?: string;
    /** Opaque harness metadata (e.g. tmux window) the daemon stores + relays back. */
    metadata?: Record<string, unknown>;
  }): Promise<AgentRegisterResponse> {
    return this.post<AgentRegisterResponse>("/api/agents/register", {
      id: this.agentId,
      name: opts.name,
      hostId: this.hostId,
      directory: opts.directory,
      metadata: opts.metadata,
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
  async heartbeat(status: "idle" | "working" | "pairing", currentTask?: string): Promise<{ dismissed?: boolean; reregister?: boolean }> {
    try {
      const res = await this.post<{ success: boolean; dismissed?: boolean; reregister?: boolean }>("/api/agents/heartbeat", {
        id: this.agentId,
        status,
        currentTask,
      });
      return { dismissed: res.dismissed, reregister: res.reregister };
    } catch {
      // Heartbeat failures are non-fatal — daemon may be temporarily unreachable
      return {};
    }
  }

  /**
   * Report this host's readiness to the daemon.
   *
   * Readiness is a host-level fact (shared credentials, VPN, etc.), so the
   * leader — the per-host singleton — runs a probe and reports the result here.
   * The daemon holds scheduled enqueues destined for a not-ready host until it
   * recovers (see the daemon's docs/ARCHITECTURE.md "Scheduler readiness gating").
   *
   * Never throws — safe for background intervals.
   */
  async reportHostReadiness(ready: boolean, reason?: string): Promise<void> {
    try {
      await this.post(`/api/hosts/${encodeURIComponent(this.hostId)}/readiness`, { ready, reason });
    } catch {
      // Non-fatal — the daemon may be temporarily unreachable; retried next tick.
    }
  }

  /**
   * Poll for available work. Returns the next `READY` WorkItem the daemon
   * matches to this agent (directory affinity), or `{ workItem: null }` when
   * none is available or distribution is paused.
   */
  async getNextWork(): Promise<AgentNextWorkResponse> {
    return this.get<AgentNextWorkResponse>(
      `/api/agents/next-work?agentId=${encodeURIComponent(this.agentId)}`
    );
  }

  /**
   * Claim (lease) a READY WorkItem (→ IN_PROGRESS). Returns the daemon-assembled
   * prompt (state persona + story/task context, or the WorkDef's goal) to
   * deliver verbatim.
   */
  async claimWorkItem(workItemId: string): Promise<AgentClaimResponse> {
    return this.post<AgentClaimResponse>(
      `/api/agents/claim/${encodeURIComponent(workItemId)}`,
      { agentId: this.agentId }
    );
  }

  /**
   * Set the WorkItem's terminal state (the single state-setter). `COMPLETE`
   * advances a task ref to its next workflow state (workers never move tasks);
   * `FAILED` leaves the task stuck for a human. "Giving up" is a comment plus a
   * FAILED here — the daemon bundles nothing.
   */
  async setWorkItemState(workItemId: string, state: "COMPLETE" | "FAILED", result?: string): Promise<AgentSetStateResponse> {
    return this.post<AgentSetStateResponse>(
      `/api/agents/work-items/${encodeURIComponent(workItemId)}/state`,
      { agentId: this.agentId, state, result }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMENTS (replaces old "messages")
  // ═══════════════════════════════════════════════════════════════════

  /** Get comments on a WorkItem's ref (task or WorkDef). */
  async getComments(workItemId: string): Promise<CommentsResponse> {
    return this.get<CommentsResponse>(
      `/api/agents/comments/${encodeURIComponent(workItemId)}`
    );
  }

  /** Post a comment on a WorkItem's ref (task or WorkDef). */
  async postComment(workItemId: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(
      `/api/agents/comments/${encodeURIComponent(workItemId)}`,
      { agentId: this.agentId, body, attachments }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // TOKEN USAGE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Report token usage for a work item.
   *
   * Records input/output token counts and model name. When `costUsd` is
   * supplied (pi's real, cache-aware cost — the number its powerline footer
   * shows), the daemon stores it verbatim; otherwise the daemon falls back to a
   * rough estimate from the model + token counts.
   */
  async reportTokenUsage(workItemId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costUsd?: number;
  }): Promise<TokenUsageResponse> {
    return this.post<TokenUsageResponse>(
      `/api/agents/work-items/${encodeURIComponent(workItemId)}/token-usage`,
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
  async uploadAttachment(workItemId: string, filename: string, content: string): Promise<UploadAttachmentResponse> {
    return this.post<UploadAttachmentResponse>(
      `/api/agents/work-items/${encodeURIComponent(workItemId)}/attachments`,
      { name: filename, content, encoding: "utf-8" }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // SPAWN REQUESTS (leader only)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Poll this host's leader directives — the single queue of asks (spawn,
   * reset-session, ...). Each directive carries its action, params, and the
   * target member's opaque metadata (e.g. tmux window) so the leader can act.
   */
  async getLeaderDirectives(): Promise<LeaderDirectivesResponse> {
    return this.get<LeaderDirectivesResponse>(
      `/api/hosts/${encodeURIComponent(this.hostId)}/leader/directives`
    );
  }

  /**
   * Create a leader directive for this host (e.g. a `spawn`). For `spawn` the
   * daemon generates a unique agent name into the returned directive's params.
   */
  async createLeaderDirective(action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): Promise<CreateLeaderDirectiveResponse> {
    return this.post<CreateLeaderDirectiveResponse>(
      `/api/hosts/${encodeURIComponent(this.hostId)}/leader/directives`,
      { action, memberId: opts?.memberId, params: opts?.params }
    );
  }

  /** Mark a directive complete once the leader has realized it. */
  async completeLeaderDirective(id: string): Promise<{ success: boolean }> {
    return this.put<{ success: boolean }>(
      `/api/hosts/${encodeURIComponent(this.hostId)}/leader/directives/${encodeURIComponent(id)}`,
      { status: "done" }
    );
  }

  /**
   * Mark a directive failed when it can't be realized (e.g. an invalid spawn
   * cwd). This removes it from the pending queue so the leader stops retrying
   * an ask that will never succeed — the alternative is an infinite retry loop.
   */
  async failLeaderDirective(id: string): Promise<{ success: boolean }> {
    return this.put<{ success: boolean }>(
      `/api/hosts/${encodeURIComponent(this.hostId)}/leader/directives/${encodeURIComponent(id)}`,
      { status: "failed" }
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
   * Get the assistant's active persona and the effective system prompt to
   * inject. When no persona is selected the daemon returns its default
   * assistant persona in `systemPrompt`, so this is never empty in practice.
   */
  async getPersona(): Promise<{ personaId: string | null; entry: ContextEntry | null; systemPrompt: string }> {
    return this.get("/api/assistant/persona");
  }

  /**
   * Read the user's Thoughts board (markdown sticky notes) + groups. Read-only:
   * the assistant reads notes — often by group — to help turn them into work
   * (a story/task/schedule). Optional status filter (active|archived).
   */
  async listThoughts(status?: string): Promise<{ thoughts: Thought[]; groups: ThoughtGroup[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.get(`/api/thoughts${q}`);
  }

  /** Read a single thought by id. */
  async getThought(id: string): Promise<{ success: boolean; thought?: Thought; error?: string }> {
    return this.get(`/api/thoughts/${encodeURIComponent(id)}`);
  }

  /**
   * Create a standalone WorkDef. Solitary by default (enqueued immediately so it
   * lands in the Inbox when done); pass `type: "Scheduled"` + `cron` to create a
   * recurring job instead. This is how the assistant turns thoughts into work.
   */
  async createWorkDef(body: {
    title: string; goal: string; acceptanceCriteria?: string; additionalContext?: string;
    directory?: string; contextRefs?: string[]; type?: "Solitary" | "Scheduled"; cron?: string; enqueue?: boolean;
  }): Promise<{ success: boolean; workDef?: { id: string; title: string }; error?: string }> {
    return this.post("/api/work-defs", body);
  }

  // ─── Thoughts: write (the assistant refines the board) ─────────────────

  /** Create a sticky note. `createdBy` attributes it (e.g. "assistant"). */
  async createThought(body: { content?: string; color?: string; groupId?: string; pinned?: boolean; createdBy?: string }): Promise<{ success: boolean; thought?: Thought; error?: string }> {
    return this.post("/api/thoughts", body);
  }

  /** Update a note (partial). `groupId: null` removes it from its group. */
  async updateThought(id: string, updates: { content?: string; color?: string; pinned?: boolean; groupId?: string | null; status?: "active" | "archived" }): Promise<{ success: boolean; thought?: Thought; error?: string }> {
    return this.patch(`/api/thoughts/${encodeURIComponent(id)}`, updates);
  }

  /** Archive a note (moves it off the active board; recoverable). */
  async archiveThought(id: string): Promise<{ success: boolean; error?: string }> {
    return this.post(`/api/thoughts/${encodeURIComponent(id)}/archive`, {});
  }

  /** Create a thought group, optionally seeding it with member note ids. */
  async createThoughtGroup(body: { title?: string; memberIds?: string[] }): Promise<{ success: boolean; group?: ThoughtGroup; error?: string }> {
    return this.post("/api/thought-groups", body);
  }

  /**
   * Claim an assistant response turn for processing.
   *
   * Marks the turn "processing" (single-flight) and flips its coalesced user
   * messages to "read" (read receipts).
   */
  async claimQueueItem(id: string): Promise<AssistantClaimResponse> {
    return this.post<AssistantClaimResponse>(
      `/api/assistant/messages/${encodeURIComponent(id)}/claim`,
      {}
    );
  }

  /**
   * Append one chat bubble to a processing turn (the `send_message` tool).
   *
   * A turn can call this many times to stream several bubbles, iMessage-style;
   * the web UI polls and shows them progressively.
   */
  async sayAssistantMessage(turnId: string, content: string): Promise<AssistantSayResponse> {
    return this.post<AssistantSayResponse>(
      `/api/assistant/messages/${encodeURIComponent(turnId)}/say`,
      { content }
    );
  }

  /**
   * Complete an assistant response turn.
   *
   * `result` is only a fallback: the daemon appends it as a single bubble if
   * the turn produced none via sayAssistantMessage. Normally bubbles are sent
   * with send_message and this just closes the turn.
   */
  async completeQueueItem(id: string, result?: string, failed = false): Promise<AssistantCompleteResponse> {
    return this.post<AssistantCompleteResponse>(
      `/api/assistant/messages/${encodeURIComponent(id)}/complete`,
      { result, status: failed ? "failed" : "done" }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXT LIBRARY
  // ═══════════════════════════════════════════════════════════════════
  //
  // The context library is vended by the daemon where needed (e.g. the
  // assistant's persona system prompt via getPersona). Agents do not perform
  // context CRUD/search through tools, so no list/save methods live here.

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
    /** Where the work happens — story data; teammates cd here (directory affinity). */
    directory?: string;
    paused?: boolean;
    workflow?: string;
    /** Context-library entry ids to attach to the whole story (injected into every task prompt). */
    context?: string[];
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
   * sequence number automatically. `context` attaches context-library entry
   * ids to this task (injected into its prompt).
   */
  async createTask(storyId: string, title: string, description: string, context?: string[]): Promise<CreateTaskResponse> {
    return this.post<CreateTaskResponse>(
      `/api/stories/${encodeURIComponent(storyId)}/tasks`,
      { title, description, context }
    );
  }

  /**
   * List the team's workflows (name, state/transition counts, and which is the
   * default). Lets a planner pick a valid workflow for a story.
   */
  async listWorkflows(): Promise<WorkflowSummary[]> {
    return this.get<WorkflowSummary[]>("/api/workflows");
  }

  /**
   * List the shared context-library entries so a planner can decide which to
   * attach to a story or task.
   */
  async listContext(): Promise<{ entries: ContextEntry[] }> {
    return this.get<{ entries: ContextEntry[] }>("/api/context");
  }

  /**
   * Send a free-form message to the assistant conversation.
   *
   * Appends a user message and creates the pending assistant turn that the
   * assistant agent will answer.
   */
  async enqueueAssistantRequest(prompt: string): Promise<{ success: boolean; error?: string }> {
    return this.post<{ success: boolean; error?: string }>(
      "/api/assistant/messages",
      { content: prompt }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get the daemon's current configuration.
   *
   * Returns port, tmuxSession, defaultWorkflow, etc.
   */
  async getConfig(): Promise<any> {
    return this.get<any>("/api/config");
  }

  /**
   * Get host-specific configuration (tmuxSession).
   *
   * Used by the leader to get its host's settings from the daemon.
   */
  async getHostConfig(): Promise<any> {
    return this.get<any>(`/api/hosts/${encodeURIComponent(this.hostId)}`);
  }
}

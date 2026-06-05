// HTTP client for extension → daemon communication
//
// Unified client that wraps all API calls the extension makes to the
// my-pizza-team daemon. Replaces the old teammate/client.ts and
// assistant/client.ts with a single client targeting the daemon's REST API.
//
// The daemon URL defaults to http://localhost:7437 and can be overridden
// with the --ppt-daemon flag.

import type { WorkflowConfig } from "./shared/types.js";

/** Response from GET /api/status */
export interface StatusResponse {
  running?: boolean;
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  inbox: number;
  defaultWorkflow: string;
  workflows: Record<string, { states: string[]; transitions: Record<string, Record<string, string>> }>;
}

/** Response from POST /api/agents/register */
export interface AgentRegisterResponse {
  success: boolean;
  agentId?: string;
  config?: {
    defaultWorkflow: string;
    workflows: Record<string, WorkflowConfig>;
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
    context?: string;
    workflow?: WorkflowConfig;
    instructions?: string;
  } | null;
}

/** Response from POST /api/agents/claim/:taskId */
export interface AgentClaimResponse {
  success: boolean;
  instructions?: string;
  error?: string;
}

/** Response from POST /api/agents/transition/:taskId */
export interface AgentTransitionResponse {
  success: boolean;
  instructions?: string;
  error?: string;
}

/** Response from POST /api/agents/release/:taskId */
export interface AgentReleaseResponse {
  success: boolean;
  error?: string;
}

/** Response from GET /api/tasks/:id/comments */
export interface CommentsResponse {
  comments: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }>;
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
  note?: { id: string; title: string; content: string; categories: string[]; createdAt: string; updatedAt: string };
  error?: string;
}

/** Response from GET /api/spawn-requests */
export interface SpawnRequestsResponse {
  requests: Array<{ id: string; name: string; cwd: string; leaderUrl: string }>;
}

export class DaemonClient {
  private baseUrl: string;
  private agentId: string;

  constructor(baseUrl: string, agentId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.agentId = agentId;
  }

  get id(): string {
    return this.agentId;
  }

  get url(): string {
    return this.baseUrl;
  }

  // ─── Health / Status ───────────────────────────────────────────────

  async checkServer(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<StatusResponse> {
    const res = await fetch(`${this.baseUrl}/api/status`);
    return res.json() as Promise<StatusResponse>;
  }

  // ─── Agent Protocol (new daemon API) ───────────────────────────────

  async register(name: string, cwd: string, role: "teammate" | "assistant" | "leader"): Promise<AgentRegisterResponse> {
    const res = await fetch(`${this.baseUrl}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId, name, cwd, role }),
    });
    return res.json() as Promise<AgentRegisterResponse>;
  }

  async heartbeat(status: "idle" | "working" | "pairing", currentTask?: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/agents/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId, status, currentTask }),
    }).catch(() => {});
  }

  async getNextWork(): Promise<AgentNextWorkResponse> {
    const res = await fetch(`${this.baseUrl}/api/agents/next-work?agentId=${encodeURIComponent(this.agentId)}`);
    return res.json() as Promise<AgentNextWorkResponse>;
  }

  async claimTask(taskId: string): Promise<AgentClaimResponse> {
    const res = await fetch(`${this.baseUrl}/api/agents/claim/${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId }),
    });
    return res.json() as Promise<AgentClaimResponse>;
  }

  async transitionTask(taskId: string, toState: string, result?: string): Promise<AgentTransitionResponse> {
    const res = await fetch(`${this.baseUrl}/api/agents/transition/${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId, toState, result }),
    });
    return res.json() as Promise<AgentTransitionResponse>;
  }

  async releaseTask(taskId: string): Promise<AgentReleaseResponse> {
    const res = await fetch(`${this.baseUrl}/api/agents/release/${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.agentId }),
    });
    return res.json() as Promise<AgentReleaseResponse>;
  }

  // ─── Comments (replaces messages) ─────────────────────────────────

  async getComments(taskId: string): Promise<CommentsResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/comments`);
    return res.json() as Promise<CommentsResponse>;
  }

  async postComment(taskId: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): Promise<{ success: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.agentId, body, attachments }),
    });
    return res.json() as Promise<{ success: boolean }>;
  }

  // ─── Token Usage ───────────────────────────────────────────────────

  async reportTokenUsage(taskId: string, usage: { inputTokens: number; outputTokens: number; model: string }): Promise<TokenUsageResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/token-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usage),
    });
    return res.json() as Promise<TokenUsageResponse>;
  }

  // ─── Attachments ───────────────────────────────────────────────────

  async uploadAttachment(taskId: string, filename: string, content: string): Promise<{ success: boolean; type?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: filename, content, encoding: "utf-8" }),
    });
    return res.json() as Promise<{ success: boolean; type?: string; error?: string }>;
  }

  // ─── Assistant Queue ───────────────────────────────────────────────

  async getNextAssistantItem(): Promise<AssistantNextResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/next`);
    return res.json() as Promise<AssistantNextResponse>;
  }

  async claimAssistantItem(id: string): Promise<AssistantClaimResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/queue/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return res.json() as Promise<AssistantClaimResponse>;
  }

  async completeAssistantItem(id: string, result?: string, failed = false): Promise<AssistantCompleteResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/queue/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, status: failed ? "failed" : "done" }),
    });
    return res.json() as Promise<AssistantCompleteResponse>;
  }

  // ─── Memory Notes ──────────────────────────────────────────────────

  async saveNote(title: string, content: string, categories: string[]): Promise<AssistantSaveNoteResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, categories }),
    });
    return res.json() as Promise<AssistantSaveNoteResponse>;
  }

  async searchNotes(query: string, category?: string, limit?: number): Promise<{ results: Array<{ title: string; score: number; snippet: string }> }> {
    const params = new URLSearchParams({ q: query });
    if (category) params.set("category", category);
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${this.baseUrl}/api/assistant/notes/search?${params}`);
    return res.json() as Promise<{ results: Array<{ title: string; score: number; snippet: string }> }>;
  }

  // ─── Spawn Requests (for leader polling) ───────────────────────────

  async getSpawnRequests(hostId: string): Promise<SpawnRequestsResponse> {
    const res = await fetch(`${this.baseUrl}/api/spawn-requests?hostId=${encodeURIComponent(hostId)}`);
    return res.json() as Promise<SpawnRequestsResponse>;
  }

  async ackSpawnRequest(requestId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/spawn-requests/${encodeURIComponent(requestId)}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return res.json() as Promise<{ success: boolean }>;
  }

  // ─── Config ────────────────────────────────────────────────────────

  async getConfig(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/config`);
    return res.json();
  }

  async getHostConfig(hostId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/hosts/${encodeURIComponent(hostId)}`);
    return res.json();
  }

  // ─── Stories / Tasks (for leader tools) ────────────────────────────

  async createStory(story: { id: string; title: string; description: string; dependsOn?: string[]; dir?: string; workflow?: string; categories?: string[]; tasks?: Array<{ title: string; description: string }> }): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/stories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(story),
    });
    return res.json() as Promise<{ success: boolean; error?: string }>;
  }

  async updateStory(storyId: string, updates: Record<string, any>): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/stories/${encodeURIComponent(storyId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return res.json() as Promise<{ success: boolean; error?: string }>;
  }

  async addTask(storyId: string, title: string, description: string): Promise<{ success: boolean; task?: { id: string; seq: number }; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/stories/${encodeURIComponent(storyId)}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    return res.json() as Promise<{ success: boolean; task?: { id: string; seq: number }; error?: string }>;
  }

  async enqueueAssistantRequest(prompt: string): Promise<{ success: boolean; item?: { id: string }; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/assistant/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    return res.json() as Promise<{ success: boolean; item?: { id: string }; error?: string }>;
  }
}

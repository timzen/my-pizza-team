/**
 * shared/protocol.ts — API request/response shapes for the HTTP protocol.
 *
 * Defines the contract between daemon, CLI, and UI. All endpoints return
 * JSON conforming to these interfaces.
 */

import type { WorkflowConfig } from "./types.ts";

// GET /api/status
export interface StatusResponse {
  running: boolean;
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  defaultWorkflow: string;
  workflows: Record<string, WorkflowConfig>;
  workflow?: WorkflowConfig;
}

// GET /api/stories
export interface StoriesResponse {
  stories: StoryView[];
}

export interface StoryView {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  ready: boolean;
  requirements?: Record<string, string | null>;
  paused?: boolean;
  workflow?: string;
  context?: string[];
  tasks: TaskView[];
}

export interface TaskView {
  id: string;
  seq: number;
  title: string;
  status: string;
  description?: string;
  context?: string[];
  assignee: string | null;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}

// POST /api/tasks/:taskId/comment
export interface PostCommentRequest { from: string; body: string; attachments?: Array<{ name: string; size: number; type: string }> }
export interface PostCommentResponse { success: boolean }

// GET /api/tasks/:taskId/comments
export interface CommentsResponse { comments: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }> }

// POST /api/stories
export interface CreateStoryRequest { id: string; title: string; description: string; status?: "open" | "done"; dependsOn?: string[]; requirements?: Record<string, string | null>; paused?: boolean; workflow?: string; context?: string[]; tasks?: Array<{ title: string; description: string; context?: string[] }> }
export interface CreateStoryResponse { success: boolean; story?: StoryView; error?: string }

// POST /api/stories/:storyId/tasks
export interface CreateTaskRequest { title: string; description: string; context?: string[] }
export interface CreateTaskResponse { success: boolean; task?: { id: string; seq: number; title: string; description: string; status: string }; error?: string }

// PUT /api/tasks/:id
export interface UpdateTaskRequest { title?: string; description?: string; context?: string[] | null }
export interface UpdateTaskResponse { success: boolean; error?: string }

// DELETE /api/tasks/:id
export interface DeleteTaskResponse { success: boolean; error?: string }

// POST /api/stories/:storyId/tasks/reorder
export interface ReorderTasksRequest { order: string[] }
export interface ReorderTasksResponse { success: boolean; error?: string }

// POST /api/tasks/:id/move
export interface MoveTaskRequest { status: string }
export interface MoveTaskResponse { success: boolean; error?: string }

// POST /api/tasks/:id/token-usage
export interface TokenUsageRequest { inputTokens: number; outputTokens: number; model: string }
export interface TokenUsageResponse { success: boolean; costUsd?: number; error?: string }


// PUT /api/stories/:id
export interface UpdateStoryRequest { title?: string; description?: string; status?: "open" | "done"; dependsOn?: string[]; requirements?: Record<string, string | null> | null; paused?: boolean; workflow?: string | null; context?: string[] | null }
export interface UpdateStoryResponse { success: boolean; error?: string }

// DELETE /api/stories/:id
export interface DeleteStoryResponse { success: boolean; error?: string }

// POST /api/stories/:id/archive
export interface ArchiveStoryResponse { success: boolean; synopsis?: string; error?: string }

// --- Capabilities (recently used) ---
// GET /api/capabilities
export interface CapabilitiesResponse { capabilities: Record<string, string[]> }
// POST /api/capabilities
export interface AddCapabilityRequest { name: string; value?: string }
// POST/DELETE responses
export interface CapabilityMutationResponse { success: boolean; capabilities?: Record<string, string[]>; error?: string }

// GET /api/archived
export interface ArchivedStoriesResponse { stories: Array<{ id: string; title: string; archivedAt: string; synopsis: string }> }

// --- Assistant Conversation ---
export interface AssistantMessage { id: string; role: "user" | "assistant"; content: string; status: "pending" | "processing" | "done" | "failed"; createdAt: string }
export interface AssistantMessagesResponse { messages: AssistantMessage[] }
export interface AssistantSendRequest { content: string }
export interface AssistantSendResponse { success: boolean; userMessage?: AssistantMessage; assistantMessage?: AssistantMessage; error?: string }
// Agent-facing turn processing
export interface AssistantNextResponse { item: { id: string; prompt: string } | null }
export interface AssistantClaimResponse { success: boolean; error?: string }
export interface AssistantCompleteRequest { result?: string; status?: "done" | "failed" }
export interface AssistantCompleteResponse { success: boolean; error?: string }
export interface AssistantDeleteResponse { success: boolean; error?: string }

// --- Context Library ---
export interface ContextEntry { id: string; title: string; description: string; tags: string[]; content: string; createdAt: string; updatedAt: string }
export interface ContextEntriesResponse { entries: ContextEntry[] }
export interface ContextEntryResponse { entry?: ContextEntry; success?: boolean; error?: string }
export interface SaveContextEntryRequest { title: string; description?: string; tags?: string[]; content: string }
export interface UpdateContextEntryRequest { title?: string; description?: string; tags?: string[]; content?: string }
export interface SaveContextEntryResponse { success: boolean; entry?: ContextEntry; error?: string }
export interface DeleteContextEntryResponse { success: boolean; error?: string }

// --- Scratch Pad ---
export interface TodoItem { status: "open" | "done"; item: string; created: string; completed: string }
export interface ScratchpadResponse { todos: TodoItem[]; notes: string }
export interface AddTodoRequest { item: string }
export interface UpdateTodoRequest { status?: "open" | "done"; item?: string }
export interface TodosMutationResponse { success: boolean; todos?: TodoItem[]; error?: string }
export interface SetNotesRequest { content: string }
export interface SetNotesResponse { success: boolean; error?: string }

// --- Assistant Persona ---
// GET /api/assistant/persona
export interface AssistantPersonaResponse { personaId: string | null; entry: ContextEntry | null; systemPrompt: string }
// PUT /api/assistant/persona
export interface SetAssistantPersonaRequest { personaId: string | null }
export interface SetAssistantPersonaResponse { success: boolean; personaId?: string | null; entry?: ContextEntry | null; systemPrompt?: string; error?: string }

// --- Agents API ---

// POST /api/agents/register
export interface AgentRegisterRequest {
  id: string;
  name: string;
  /** Capabilities this agent has (well-known `directory` key = working dir). */
  capabilities?: Record<string, string | null>;
  /** How this agent selects work (default: eager-helper). */
  workMode?: "eager-helper" | "assigned-story";
  /** For workMode `assigned-story`: the story to bind to. */
  assignedStoryId?: string;
  hostId?: string;
}
export interface AgentRegisterResponse { success: boolean; config: { defaultWorkflow: string; workflows: Record<string, WorkflowConfig> }; error?: string }

// POST /api/agents/heartbeat
export interface AgentHeartbeatRequest { id: string; status: "idle" | "working" | "pairing" | "offline"; currentTask?: string }
export interface AgentHeartbeatResponse { success: boolean }

// GET /api/agents/next-work?agentId=X
/** `dismiss: true` tells an assigned-story agent its story is exhausted (archived) and it should stop. */
export interface AgentNextWorkResponse { task: { id: string; storyId: string; title: string } | null; dismiss?: boolean }

// POST /api/agents/claim/:taskId
export interface AgentClaimRequest { agentId: string }
export interface AgentClaimResponse { success: boolean; error?: string; task?: { id: string; storyId: string; status: string }; prompt?: string }

// POST /api/agents/release/:taskId
export interface AgentReleaseRequest { agentId: string; result?: string }
export interface AgentReleaseResponse { success: boolean; error?: string; newStatus?: string; completed?: boolean }

// GET /api/agents/comments/:taskId
export interface AgentCommentsResponse { comments: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }> }

// POST /api/agents/comments/:taskId
export interface AgentPostCommentRequest { agentId: string; body: string; attachments?: Array<{ name: string; size: number; type: string }> }
export interface AgentPostCommentResponse { success: boolean }

// GET /api/agents
export interface AgentListResponse { agents: Array<{ id: string; name: string; capabilities: Record<string, string | null>; workMode: string; assignedStoryId?: string; status: string; currentTask: string | null; lastHeartbeat: number }> }

// DELETE /api/agents/:id
export interface AgentDeleteResponse { success: boolean; error?: string }
// --- Leader Directives (the single daemon->leader work queue, per host) ---

/** A directive is an ask to the leader: "do X about an agent" (spawn, reset-session, ...). */
export interface LeaderDirective {
  id: string;
  action: string;
  /** Target member for actions on an existing agent (absent for spawn). */
  memberId?: string;
  /** Action params, e.g. spawn { name, cwd, storyId, reason }. */
  params: Record<string, unknown>;
  /** Target member's opaque metadata (e.g. tmux window), resolved for the leader. */
  metadata: Record<string, unknown>;
  status: "pending" | "done";
  createdAt: string;
}

// GET /api/hosts/:hostId/leader/directives
export interface LeaderDirectivesResponse { directives: LeaderDirective[] }

// POST /api/hosts/:hostId/leader/directives
export interface CreateLeaderDirectiveRequest { action: string; memberId?: string; params?: Record<string, unknown> }
export interface CreateLeaderDirectiveResponse { success: boolean; directive?: LeaderDirective; error?: string }

// PUT /api/hosts/:hostId/leader/directives/:id
export interface UpdateLeaderDirectiveRequest { status: string }
export interface UpdateLeaderDirectiveResponse { success: boolean; error?: string }

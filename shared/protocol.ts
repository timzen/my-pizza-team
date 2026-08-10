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
  /** Where the work happens (soft affinity bias; agents cd here). */
  directory?: string;
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
  /** Active WorkItem state for this task, if any (drives the board chip). */
  workItemState?: string | null;
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
export interface CreateStoryRequest { id: string; title: string; description: string; status?: "open" | "done"; dependsOn?: string[]; directory?: string; paused?: boolean; workflow?: string; context?: string[]; tasks?: Array<{ title: string; description: string; context?: string[] }> }
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
export interface UpdateStoryRequest { title?: string; description?: string; status?: "open" | "done"; dependsOn?: string[]; directory?: string | null; paused?: boolean; workflow?: string | null; context?: string[] | null }
export interface UpdateStoryResponse { success: boolean; error?: string }

// DELETE /api/stories/:id
export interface DeleteStoryResponse { success: boolean; error?: string }

// POST /api/stories/:id/archive
export interface ArchiveStoryResponse { success: boolean; synopsis?: string; error?: string }

// --- Capabilities removed: matching is now directory-affinity only (see refactor plan). ---

// GET /api/archived
export interface ArchivedStoriesResponse { stories: Array<{ id: string; title: string; archivedAt: string; synopsis: string }> }

// --- Assistant Conversation ---
// User messages: 'sent' (delivered) -> 'read' (coalesced into a turn). Assistant
// bubbles are appended already-'done' (or 'failed'). `turnId` groups a message
// under the response turn it belongs to.
export interface AssistantMessage { id: string; role: "user" | "assistant"; content: string; status: "sent" | "read" | "done" | "failed"; turnId: string | null; createdAt: string }
/** The active (processing) response turn, or null when idle. Drives the typing indicator + composer lock. */
export interface AssistantTurn { id: string; status: "processing" }
export interface AssistantMessagesResponse { messages: AssistantMessage[]; activeTurn: AssistantTurn | null }
export interface AssistantSendRequest { content: string }
export interface AssistantSendResponse { success: boolean; userMessage?: AssistantMessage; error?: string }
// Typing presence ping (POST /api/assistant/typing, no body) — feeds the pre-claim debounce.
export interface AssistantTypingResponse { success: boolean }
// Agent-facing turn processing
export interface AssistantNextResponse { item: { id: string; prompt: string } | null }
export interface AssistantClaimResponse { success: boolean; error?: string }
// Append one chat bubble to the active turn (the `send_message` tool).
export interface AssistantSayRequest { content: string }
export interface AssistantSayResponse { success: boolean; message?: AssistantMessage; error?: string }
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

// --- Scratch Pad (removed: replaced by the Thoughts board) ---

// --- Assistant Persona ---
// GET /api/assistant/persona
export interface AssistantPersonaResponse { personaId: string | null; entry: ContextEntry | null; systemPrompt: string }
// PUT /api/assistant/persona
export interface SetAssistantPersonaRequest { personaId: string | null }
export interface SetAssistantPersonaResponse { success: boolean; personaId?: string | null; entry?: ContextEntry | null; systemPrompt?: string; error?: string }

// --- Agents API (WorkItem-centric; see refactor plan) ---

// POST /api/agents/register
export interface AgentRegisterRequest {
  id: string;
  name: string;
  /** The agent's working directory (its pi cwd). Drives directory-affinity matching. */
  directory?: string;
  hostId?: string;
  /** Opaque harness metadata (e.g. tmux window), relayed verbatim. */
  metadata?: Record<string, unknown>;
}
export interface AgentRegisterResponse { success: boolean; config: { defaultWorkflow: string; workflows: Record<string, WorkflowConfig> }; error?: string }

// POST /api/agents/heartbeat
export interface AgentHeartbeatRequest { id: string; status: "idle" | "working" | "pairing" | "offline"; currentTask?: string }
export interface AgentHeartbeatResponse { success: boolean }

// GET /api/agents/next-work?agentId=X
export interface AgentNextWorkResponse { workItem: { id: string; title: string } | null }

// POST /api/agents/claim/:workItemId
export interface AgentClaimRequest { agentId: string }
export interface AgentClaimResponse { success: boolean; error?: string; workItem?: { id: string }; prompt?: string }

// POST /api/agents/work-items/:workItemId/state — the single state-setter.
// The daemon reacts: COMPLETE advances a task ref; FAILED leaves it stuck.
export interface AgentSetWorkItemStateRequest { agentId: string; state: "COMPLETE" | "FAILED"; result?: string }
export interface AgentSetWorkItemStateResponse { success: boolean; error?: string; newStatus?: string; completed?: boolean }

// GET /api/agents/comments/:workItemId
export interface AgentCommentsResponse { comments: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }> }

// POST /api/agents/comments/:workItemId
export interface AgentPostCommentRequest { agentId: string; body: string; attachments?: Array<{ name: string; size: number; type: string }> }
export interface AgentPostCommentResponse { success: boolean }

// GET /api/agents
export interface AgentListResponse { agents: Array<{ id: string; name: string; directory?: string; status: string; currentWork: string | null; lastHeartbeat: number }> }

// DELETE /api/agents/:id
export interface AgentDeleteResponse { success: boolean; error?: string }

// --- WorkItems (queue) ---
export interface WorkItemView {
  id: string;
  title: string;
  ref: { workDefId: string };
  /** The backing WorkDef's parent, so clients can route to the right detail page. */
  parent?: { kind: "story" | "schedule"; id: string };
  directory?: string;
  state: string;
  read: boolean;
  memberId?: string;
  enqueuedAt: string;
  lastStateChangeAt: string;
}
// GET /api/work-items?state=READY,IN_PROGRESS&read=false&limit=&offset=
export interface WorkItemsResponse { items: WorkItemView[]; total: number }
export interface WorkItemMutationResponse { success: boolean; error?: string }
// POST /api/work-items/:id/force-fail
export interface ForceFailWorkItemRequest { reEnqueue?: boolean }
// POST /api/work-items/re-enqueue
export interface ReEnqueueRequest { ref: { workDefId: string } }

// --- WorkDefs (every unit of work; parent-owned; see WORKDEF_UNIFICATION.md) ---
export interface WorkDefView {
  id: string;
  title: string;
  /** Derived from parent kind: story→Board, schedule→Scheduled, none→Solitary. */
  type: "Solitary" | "Scheduled" | "Board";
  parent?: { kind: "story" | "schedule"; id: string };
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string;
  /** Aggregate token usage/cost across this def's runs (recorded on the ref). */
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}
export interface WorkDefsResponse { workDefs: WorkDefView[] }
export interface WorkDefResponse { workDef?: WorkDefView; success?: boolean; error?: string }
export interface SaveWorkDefRequest {
  title: string;
  /** Solitary (default) or Scheduled; Scheduled also creates a Schedule from `cron`. */
  type?: "Solitary" | "Scheduled";
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string;
  /** Required when type === "Scheduled": the cron for the created Schedule. */
  cron?: string;
  /** When true (default) for Solitary, also enqueue a WorkItem immediately. */
  enqueue?: boolean;
}
export interface UpdateWorkDefRequest {
  title?: string;
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string | null;
  contextRefs?: string[] | null;
  directory?: string | null;
  /** For a Scheduled WorkDef, update its parent Schedule's cron. */
  cron?: string | null;
}
export interface SaveWorkDefResponse { success: boolean; workDef?: WorkDefView; error?: string }

// --- Task Templates (reusable molds for Solitary tasks; see docs/ARCHITECTURE.md) ---
export interface TemplateView {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string;
}
export interface TemplatesResponse { templates: TemplateView[] }
export interface TemplateResponse { template?: TemplateView; success?: boolean; error?: string }
export interface SaveTemplateRequest {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string;
}
export interface UpdateTemplateRequest {
  title?: string;
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string | null;
  contextRefs?: string[] | null;
  directory?: string | null;
}
export interface SaveTemplateResponse { success: boolean; template?: TemplateView; error?: string }

// --- Schedules (cron parents) ---
export interface ScheduleView { id: string; title?: string; cron: string; lastEnqueuedAt?: string }
export interface SchedulesResponse { schedules: ScheduleView[] }
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

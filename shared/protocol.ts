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
  inbox: number;
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
  dir?: string;
  workflow?: string;
  categories?: string[];
  tasks: TaskView[];
}

export interface TaskView {
  id: string;
  seq: number;
  title: string;
  status: string;
  description?: string;
  assignee: string | null;
  hasMessages: boolean;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}

// GET /api/next-task?memberId=X
export interface NextTaskResponse {
  task: {
    id: string;
    storyId: string;
    title: string;
    description: string;
    context?: string;
    workflow?: WorkflowConfig;
  } | null;
}

// POST /api/tasks/:taskId/claim
export interface ClaimRequest { memberId: string }
export interface ClaimResponse { success: boolean; error?: string; instructions?: string }

// POST /api/tasks/:taskId/status
export interface StatusUpdateRequest { status: string; result?: string; actor: "lead" | "teammate"; memberId?: string }
export interface StatusUpdateResponse { success: boolean; error?: string; instructions?: string }

// POST /api/tasks/:taskId/message
export interface PostMessageRequest { from: string; body: string; attachments?: Array<{ name: string; size: number; type: string }> }
export interface PostMessageResponse { success: boolean }

// GET /api/tasks/:taskId/messages
export interface MessagesResponse { messages: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }> }

// POST /api/team/join
export interface JoinRequest { id: string; name: string; cwd: string; tmuxWindow: string }
export interface JoinResponse { success: boolean; config: { defaultWorkflow: string; workflows: Record<string, WorkflowConfig>; workflow?: WorkflowConfig } }

// POST /api/team/heartbeat
export interface HeartbeatRequest { id: string; status: "idle" | "working" | "pairing"; currentTask?: string }

// POST /api/stories
export interface CreateStoryRequest { id: string; title: string; description: string; status?: "open" | "done"; dependsOn?: string[]; dir?: string; workflow?: string; categories?: string[]; tasks?: Array<{ title: string; description: string }> }
export interface CreateStoryResponse { success: boolean; story?: StoryView; error?: string }

// GET /api/team
export interface TeamResponse { members: Array<{ id: string; name: string; status: string; currentTask: string | null; tmuxWindow: string; lastHeartbeat: number }> }

// POST /api/stories/:storyId/tasks
export interface CreateTaskRequest { title: string; description: string }
export interface CreateTaskResponse { success: boolean; task?: { id: string; seq: number; title: string; description: string; status: string }; error?: string }

// PUT /api/tasks/:id
export interface UpdateTaskRequest { title?: string; description?: string }
export interface UpdateTaskResponse { success: boolean; error?: string }

// DELETE /api/tasks/:id
export interface DeleteTaskResponse { success: boolean; error?: string }

// POST /api/tasks/:id/move
export interface MoveTaskRequest { status: string }
export interface MoveTaskResponse { success: boolean; error?: string; instructions?: string }

// POST /api/tasks/:id/token-usage
export interface TokenUsageRequest { inputTokens: number; outputTokens: number; model: string }
export interface TokenUsageResponse { success: boolean; costUsd?: number; error?: string }

// POST /api/tasks/:id/mark-read
export interface MarkReadResponse { success: boolean; error?: string }

// PUT /api/stories/:id
export interface UpdateStoryRequest { title?: string; description?: string; status?: "open" | "done"; dependsOn?: string[]; dir?: string | null; workflow?: string | null; categories?: string[] | null }
export interface UpdateStoryResponse { success: boolean; error?: string }

// DELETE /api/stories/:id
export interface DeleteStoryResponse { success: boolean; error?: string }

// POST /api/stories/:id/archive
export interface ArchiveStoryResponse { success: boolean; synopsis?: string; error?: string }

// GET /api/archived
export interface ArchivedStoriesResponse { stories: Array<{ id: string; title: string; archivedAt: string; synopsis: string }> }

// --- Assistant Queue ---
export interface AssistantQueueItem { id: string; prompt: string; status: "pending" | "processing" | "done" | "failed"; result?: string; createdAt: string; startedAt?: string; completedAt?: string }
export interface AssistantQueueResponse { items: AssistantQueueItem[] }
export interface AssistantEnqueueRequest { prompt: string }
export interface AssistantEnqueueResponse { success: boolean; item?: AssistantQueueItem; error?: string }
export interface AssistantNextResponse { item: { id: string; prompt: string } | null }
export interface AssistantClaimResponse { success: boolean; error?: string }
export interface AssistantCompleteRequest { result?: string; status?: "done" | "failed" }
export interface AssistantCompleteResponse { success: boolean; error?: string }
export interface AssistantDeleteResponse { success: boolean; error?: string }

// --- Assistant Notes ---
export interface AssistantNote { id: string; title: string; content: string; categories: string[]; createdAt: string; updatedAt: string }
export interface AssistantNotesResponse { notes: AssistantNote[] }
export interface AssistantSaveNoteRequest { title: string; content: string; categories?: string[] }
export interface AssistantSaveNoteResponse { success: boolean; note?: AssistantNote; error?: string }
export interface AssistantDeleteNoteResponse { success: boolean; error?: string }

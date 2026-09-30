/**
 * shared/protocol.ts — API request/response shapes for the HTTP protocol.
 *
 * Defines the contract between daemon, CLI, UI, and harnesses. All endpoints
 * return JSON conforming to these interfaces.
 */

import type { MemberSessionStats, WorkflowConfig } from "./types.ts";

// ─── Protocol version ────────────────────────────────────────────────
// (Additive, optional routes — like POST /api/agents/:id/session-stats — are not
// a protocol change: an older harness simply never calls them.)

/**
 * The agent-protocol version this build speaks.
 *
 * **Bump this only on a breaking change to the agent protocol** — a route an
 * agent depends on moving or changing shape. Do *not* bump it for the release
 * version: the two are deliberately separate, because gating on build version
 * would nag the whole team on every patch release until people learned to ignore
 * the warning (docs/DESIGN.md "One Protocol, One Version").
 *
 * The daemon refuses to register an agent speaking a version it cannot serve, so
 * skew fails loudly at startup instead of silently half-working — the failure
 * mode docs/DESIGN.md "One Protocol, One Version" describes, where an old extension kept running
 * but streamed no transcript and recorded no usage.
 *
 * History:
 *   1 — WorkItem-centric agent protocol, per-host leader directives.
 *   2 — Leader directives moved from /api/hosts/:hostId/leader/directives to
 *       /api/leader/directives (one leader, so no host key). P1c-1.
 *   3 — Readiness moved from POST /api/hosts/:hostId/readiness to
 *       POST /api/readiness, and is a team-level fact. P1c-3.
 *   4 — Host routing removed: register no longer takes hostId, and
 *       GET /api/hosts/:hostId is gone (use GET /api/config). P1c-2.
 *   5 — GET /api/assistant/inbox no longer returns `chat`: with one leader there
 *       is no chat-agent designation to report. P1c-4.
 */
export const PROTOCOL_VERSION = 5;

/**
 * The lowest agent-protocol version this daemon still serves. Raise it in the
 * same commit that removes the compatibility it covers.
 *
 * Raised in step with each P1c break. A v1 extension polls a directive path that
 * no longer exists and would sit there silently spawning nobody; a v2 one reports
 * readiness to a path that 404s, silently losing the gating that stops overnight
 * cron pile-ups. Refusing at registration turns both into a message telling the
 * user to restart the agent.
 */
export const MIN_PROTOCOL_VERSION = 5;

/** Which harness an agent runs under. Open-ended: Tier 0 harnesses self-report. */
export type HarnessKind = "pi" | (string & {});

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

// --- Capabilities removed: matching is now directory-affinity only (docs/DESIGN.md "Work Matching: Directory Affinity"). ---

// GET /api/archived
export interface ArchivedStoriesResponse { stories: Array<{ id: string; title: string; archivedAt: string; synopsis: string }> }

// --- Assistant Conversation (chat v2) ---
// The chat mirrors the assistant's Pi session: there are no response turns, the
// composer never locks, and delivery receipts advance queued -> delivered -> read
// as the agent picks a message up. See docs/DESIGN.md "Assistant Chat Model".

/** Where a message came from: the web UI, the agent's terminal, the agent, the daemon. */
export type AssistantOrigin = "web" | "tui" | "agent" | "system";
/** Receipt states for a user message (null on assistant/system rows). */
export type AssistantDelivery = "queued" | "delivered" | "read";

export interface AssistantMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  origin: AssistantOrigin;
  delivery: AssistantDelivery | null;
  /** 'ok' | 'failed' — only meaningful for assistant bubbles. */
  state: string;
  /** Id of the message this one quotes, if any. */
  replyTo: string | null;
  /** Resolved excerpt of `replyTo` for rendering the quote inline. */
  quoted: { id: string; role: "user" | "assistant" | "system"; content: string } | null;
  createdAt: string;
}

/** One continuous conversation, backed by one Pi session and one persona. */
export interface AssistantSession {
  id: string;
  personaId: string | null;
  personaTitle: string | null;
  title: string;
  piSessionPath: string | null;
  status: "active" | "ended";
  snapshotPath: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
}

// GET /api/assistant/messages?sessionId=
// `chatAgent` is the agent that answers (the designated leader), or null if none
// is online — the chat is answered by the leader, not a dedicated assistant.
export interface AssistantMessagesResponse { session: AssistantSession | null; messages: AssistantMessage[]; thinking: boolean; chatAgent: { id: string; name: string } | null }
// POST /api/assistant/messages
export interface AssistantSendRequest { content: string; replyTo?: string | null; origin?: AssistantOrigin }
/** `chatAgent` is the id of the agent that will answer, or null if none is online. */
export interface AssistantSendResponse { success: boolean; userMessage?: AssistantMessage; chatAgent?: string | null; error?: string }
export interface AssistantDeleteResponse { success: boolean; error?: string }

// GET /api/assistant/stream (SSE). Each frame is one of these, JSON-encoded.
export type AssistantStreamEvent =
  | { type: "hello"; thinking: boolean; session: AssistantSession | null }
  | { type: "message"; message: AssistantMessage }
  | { type: "message-deleted"; id: string }
  | { type: "delivery"; id: string; delivery: AssistantDelivery }
  | { type: "thinking"; active: boolean; chunk?: string }
  | { type: "session"; session: AssistantSession };

// --- Assistant agent-facing (the extension mirrors Pi <-> daemon) ---

/**
 * GET /api/assistant/inbox?agentId= — user messages not yet handed to Pi.
 * `chat` is false for any agent that is not the designated chat agent; it gets no
 * messages and must not mirror its own output.
 */
export interface AssistantInboxItem { id: string; content: string; replyTo: string | null; quoted: string | null; origin: AssistantOrigin }
export interface AssistantInboxResponse { chat: boolean; messages: AssistantInboxItem[] }
// POST /api/assistant/inbox/ack — empty `ids` with state 'read' promotes all delivered.
export interface AssistantAckRequest { ids?: string[]; state: AssistantDelivery }
export interface AssistantAckResponse { success: boolean; updated?: number; error?: string }
// POST /api/assistant/bubbles — mirror one paragraph of the agent's reply.
export interface AssistantBubbleRequest { content: string; failed?: boolean }
export interface AssistantBubbleResponse { success: boolean; message?: AssistantMessage; error?: string }
// POST /api/assistant/thoughts — ephemeral reasoning peek + the `…` indicator.
export interface AssistantThoughtRequest { chunk?: string; clear?: boolean; thinking?: boolean }
// GET /api/assistant/thoughts
export interface AssistantThoughtsResponse { chunks: string[]; updatedAt: string | null; thinking: boolean }
// POST /api/assistant/session — the extension reports its live Pi session file.
export interface AssistantReportSessionRequest { piSessionPath: string }
export interface AssistantReportSessionResponse { success: boolean; session?: AssistantSession; error?: string }

// --- Assistant sessions ---
// GET /api/assistant/sessions
export interface AssistantSessionsResponse { sessions: AssistantSession[] }
// POST /api/assistant/sessions/new, POST /api/assistant/sessions/:id/resume
export interface AssistantSessionResponse { success: boolean; session?: AssistantSession; contextRestored?: boolean; error?: string }

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
// Swapping a persona ends the current session (snapshotted) and starts a new one.
// GET /api/assistant/persona
export interface AssistantPersonaResponse { personaId: string | null; entry: ContextEntry | null; systemPrompt: string }
// PUT /api/assistant/persona
export interface SetAssistantPersonaRequest { personaId: string | null }
export interface SetAssistantPersonaResponse { success: boolean; personaId?: string | null; entry?: ContextEntry | null; systemPrompt?: string; session?: AssistantSession; error?: string }

// --- Agents API (WorkItem-centric; see docs/DESIGN.md "The WorkItem") ---

// POST /api/agents/register
export interface AgentRegisterRequest {
  id: string;
  name: string;
  /** The agent's working directory (its pi cwd). Drives directory-affinity matching. */
  directory?: string;
  /** Opaque harness metadata (e.g. tmux window), relayed verbatim. */
  metadata?: Record<string, unknown>;
  /**
   * The agent-protocol version the harness speaks. Absent means a pre-handshake
   * harness: it is accepted and flagged rather than refused, so upgrading the
   * daemon first doesn't strand a running team.
   */
  protocolVersion?: number;
  /** Which harness this agent runs under (e.g. "pi"). Informational. */
  harness?: HarnessKind;
  /** The harness integration's own build version. Informational only. */
  harnessVersion?: string;
}
export interface AgentRegisterResponse {
  success: boolean;
  config: { defaultWorkflow: string; workflows: Record<string, WorkflowConfig> };
  error?: string;
  /** The daemon's protocol version, so a harness can warn on its own side too. */
  protocolVersion?: number;
  /** The daemon's build version, for the UI's skew banner. */
  daemonVersion?: string;
}

// POST /api/agents/heartbeat
export interface AgentHeartbeatRequest { id: string; status: "idle" | "working" | "pairing" | "offline"; currentTask?: string }
export interface AgentHeartbeatResponse { success: boolean }

// POST /api/agents/:id/session-stats — context-window fill and session cost,
// after every turn (see MemberSessionStats). The daemon stamps `at`.
export type AgentSessionStatsRequest = Omit<MemberSessionStats, "at">;
export interface AgentSessionStatsResponse { success: boolean; error?: string }

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
  parent?: { kind: "story" | "schedule" | "thought"; id: string };
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

// --- WorkDefs (every unit of work; parent-owned; see docs/DESIGN.md "WorkDefs & Parents") ---
export interface WorkDefView {
  id: string;
  title: string;
  /** Derived from parent kind: story→Board, schedule→Scheduled, thought→Triage, none→Solitary. */
  type: "Solitary" | "Scheduled" | "Board" | "Triage";
  parent?: { kind: "story" | "schedule" | "thought"; id: string };
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
// --- Leader Directives (the single daemon->leader work queue) ---

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

// GET /api/leader/directives
export interface LeaderDirectivesResponse { directives: LeaderDirective[] }

// POST /api/leader/directives
export interface CreateLeaderDirectiveRequest { action: string; memberId?: string; params?: Record<string, unknown> }
export interface CreateLeaderDirectiveResponse { success: boolean; directive?: LeaderDirective; error?: string }

// PUT /api/leader/directives/:id
export interface UpdateLeaderDirectiveRequest { status: string }
export interface UpdateLeaderDirectiveResponse { success: boolean; error?: string }

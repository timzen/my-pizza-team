/**
 * shared/protocol.ts — API request/response shapes for the HTTP protocol.
 *
 * Defines the contract between daemon, CLI, UI, and harnesses. All endpoints
 * return JSON conforming to these interfaces.
 */

import type { FeaturesConfig, MemberSessionStats, Persona, PersonaKind, PersonaRef, PersonaUsage, TriageBadge, WorkflowConfig } from "./types.ts";

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
  /** Task distribution paused (control/pause). */
  paused: boolean;
  /** READY WorkItems — queued, not yet picked up (Pizza Team link badge). */
  queuedCount: number;
  /** Unread COMPLETE/FAILED WorkItems — the Inbox's unread count (Pizza Team link badge). */
  unreadInboxCount: number;
  defaultWorkflow: string;
  workflows: Record<string, WorkflowConfig>;
  workflow?: WorkflowConfig;
  /** Which work-item kinds are on, defaults applied (`resolveFeatures`). */
  features: Required<FeaturesConfig>;
  /**
   * One-line, dismissable notices (`DELETE /api/notices/:id`) — today only the
   * persona migration's "the context library was removed" line.
   */
  notices: Array<{ id: string; message: string }>;
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
  /** A pending story: nothing new is admitted or handed out; dependents wait. Reversible. */
  pending?: boolean;
  workflow?: string;
  tasks: TaskView[];
}

export interface TaskView {
  id: string;
  seq: number;
  title: string;
  status: string;
  /** A pending task: holds its place in the story, gets no WorkItem until activated. */
  pending?: boolean;
  /** Active WorkItem state for this task, if any (drives the board chip). */
  workItemState?: string | null;
  description?: string;
  assignee: string | null;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}

// POST /api/tasks/:taskId/comment
export interface PostCommentRequest { from: string; body: string; attachments?: Array<{ name: string; size: number; type: string }> }
export interface PostCommentResponse { success: boolean }

// GET /api/tasks/:taskId/comments
export interface CommentsResponse { comments: Array<{ from: string; body: string; at: string; attachments?: Array<{ name: string; size: number; type: string }> }> }

// POST /api/stories
/**
 * `pending` creates the story pending (nothing runs until it is activated). The
 * legacy `paused` field is still accepted as a deprecated alias (one release).
 */
export interface CreateStoryRequest { id: string; title: string; description: string; status?: "open" | "done"; dependsOn?: string[]; directory?: string; pending?: boolean; /** @deprecated use `pending` */ paused?: boolean; workflow?: string; tasks?: Array<{ title: string; description: string; pending?: boolean; /** @deprecated use `pending` */ draft?: boolean }> }
export interface CreateStoryResponse { success: boolean; story?: StoryView; error?: string }

// POST /api/stories/:storyId/tasks
/**
 * `pending` creates it as pending: it holds its place in the story until activated.
 * The legacy `draft` field is still accepted as a deprecated alias (one release).
 */
export interface CreateTaskRequest { title: string; description: string; pending?: boolean; /** @deprecated use `pending` */ draft?: boolean }
export interface CreateTaskResponse { success: boolean; task?: { id: string; seq: number; title: string; description: string; status: string; pending?: boolean }; error?: string }

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
/** `pending` moves the story active ⇄ pending; `paused` is a deprecated alias (one release). */
export interface UpdateStoryRequest { title?: string; description?: string; status?: "open" | "done"; dependsOn?: string[]; directory?: string | null; pending?: boolean; /** @deprecated use `pending` */ paused?: boolean; workflow?: string | null }
export interface UpdateStoryResponse { success: boolean; error?: string }

// DELETE /api/stories/:id
export interface DeleteStoryResponse { success: boolean; error?: string }

// POST /api/stories/:id/archive
export interface ArchiveStoryResponse { success: boolean; synopsis?: string; error?: string }

// POST /api/stories/:id/pending, POST /api/stories/:id/activate
export interface SetStoryPendingResponse { success: boolean; pending?: boolean; error?: string }

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

// --- Personas (docs/DESIGN.md "Personas: One Library, Selected by Reference") ---
// The context library (`/api/context*`) was removed; those routes answer 410.
// GET /api/personas[?kind=worker|triage|assistant] — team, built-in, package (hinted kind first)
export interface PersonasResponse { personas: Persona[] }
// GET /api/personas/:id
export interface PersonaResponse { persona?: Persona; usedBy?: PersonaUsage[]; success?: boolean; error?: string }
// POST /api/personas (id optional: derived from the title)
export interface SavePersonaRequest { id?: string; title: string; description?: string; tags?: string[]; kinds?: PersonaKind[]; content: string }
// PUT /api/personas/:id (team personas only)
export interface UpdatePersonaRequest { title?: string; description?: string; tags?: string[]; kinds?: PersonaKind[]; content?: string }
/** Create/update/duplicate: the saved persona plus any lint warnings (errors refuse with 400). */
export interface SavePersonaResponse { success: boolean; persona?: Persona; warnings?: string[]; errors?: string[]; error?: string }
// DELETE /api/personas/:id — 409 with `usedBy` while referenced
export interface DeletePersonaResponse { success: boolean; usedBy?: PersonaUsage[]; error?: string }
// GET /api/personas/:id/usage
export interface PersonaUsageResponse { usedBy: PersonaUsage[] }
// POST /api/personas/:id/duplicate
export interface DuplicatePersonaRequest { id?: string; title?: string }
// PUT /api/workflows/:name/states/:state
export interface SetStatePersonaRequest { persona: string | null }
export interface SetStatePersonaResponse { success: boolean; workflow?: WorkflowConfig; error?: string }

// --- Scratch Pad (removed: replaced by the Thoughts board) ---

// --- Assistant Persona ---
// Swapping a persona ends the current session (snapshotted) and starts a new one.
// GET /api/assistant/persona
// `personaId` is the selection (null = `builtin:assistant`); `persona` is what it
// resolves to (the built-in when unset). `entry` is the selected persona, or null
// when none is selected — the pre-persona field name, kept for the chat UI.
export interface AssistantPersonaResponse { personaId: string | null; persona: Persona; entry: Persona | null; systemPrompt: string }
// PUT /api/assistant/persona
export interface SetAssistantPersonaRequest { personaId: string | null }
export interface SetAssistantPersonaResponse { success: boolean; personaId?: string | null; persona?: Persona; entry?: Persona | null; systemPrompt?: string; session?: AssistantSession; error?: string }

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
// FAILED with `sessionError` means the agent's session errored (the model call
// failed), not that the agent gave up: the daemon then retries with backoff and
// posts the attempt's comment itself (docs/DESIGN.md "Errored Sessions Retry").
export interface AgentSetWorkItemStateRequest { agentId: string; state: "COMPLETE" | "FAILED"; result?: string; sessionError?: string }
export interface AgentSetWorkItemStateResponse {
  success: boolean; error?: string; newStatus?: string; completed?: boolean;
  /** Present when a `sessionError` FAILED scheduled a retry. */
  retry?: { workItemId: string; attempt: number; maxAttempts: number; retryAt: string };
}

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
  parent?: { kind: "story" | "schedule" | "thought" | "external"; id: string; source?: string };
  directory?: string;
  state: string;
  read: boolean;
  memberId?: string;
  enqueuedAt: string;
  lastStateChangeAt: string;
  /** 1 for a first run; n for an automatic retry after an errored session. */
  attempt: number;
  /** A READY retry waits until this time (its backoff). */
  retryAt?: string;
  /** Why this attempt's agent session errored, if it did. */
  error?: string;
  /** The persona this run was given, snapshotted at claim (absent: no persona, or not claimed yet). */
  persona?: PersonaRef;
  /**
   * READY only: the active WorkItem holding an overlapping directory lease, when
   * that's why this one is waiting (`exclusiveDirectories`; docs/DESIGN.md
   * "Work Matching: Directory Affinity"). Absent when the item isn't blocked.
   */
  blockedBy?: { workItemId: string; title: string; directory?: string; memberId?: string; memberName?: string };
  /**
   * True when the item is a run on a triage-mode external item (docs/DESIGN.md
   * "External sources" — "Triage mode"): its result is an analysis with
   * proposals, so clients open the mirror's Triage tab rather than its Thread.
   * Absent otherwise (a note's triage run is told by `parent.kind: "thought"`).
   */
  triage?: boolean;
}
// GET /api/work-items?state=READY,IN_PROGRESS&read=false&workDefId=&limit=&offset=  (newest first)
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
  /** Derived from parent kind: story→Board, schedule→Scheduled, thought→Triage, external→External, none→Solitary. */
  type: "Solitary" | "Scheduled" | "Board" | "Triage" | "External";
  parent?: { kind: "story" | "schedule" | "thought" | "external"; id: string; source?: string };
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  directory?: string;
  /** Solitary/Scheduled (and a mirror's suggestion): the persona id it runs with. */
  persona?: string;
  /** Still pending: editable, never enqueued until activated (docs/DESIGN.md "Pending: Write, Review, Activate"). */
  pending: boolean;
  /** Aggregate token usage/cost across this def's runs (recorded on the ref). */
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  /**
   * How many WorkItems were created for this def, CANCELED ones excluded — 0 means
   * "never run". Derived from the WorkItem table on every read, never stored
   * (docs/DESIGN.md "Execution Count: Derived, not Counted").
   */
  executionCount: number;
  /** When the latest counted WorkItem was enqueued (ISO), or null if never run. */
  lastRunAt: string | null;
  /**
   * Mirrored (External) defs only: where it comes from. Read-only — the edit,
   * delete, and create routes refuse it (pull only; docs/DESIGN.md "Work Sources").
   */
  mirror?: MirrorView;
}

/** A mirrored WorkDef's provenance (WorkDefView.mirror). */
export interface MirrorView {
  sourceId: string;
  /** The source's display name ("Jira"), for "Open in <label>". */
  sourceLabel: string;
  externalId: string;
  url?: string;
  /** The revision last mirrored (the source's change marker). */
  revision?: string;
  /** True once sync stopped reporting it (it was archived for that). */
  vanished: boolean;
  /**
   * "triage" when the item is in triage mode (its own or its source's
   * `mode`): a teammate triages it into proposals rather than working it —
   * see `GET /api/work-defs/:id/triage`. Default "work".
   */
  mode: "work" | "triage";
  /**
   * A person's persona override for this mirror (`PUT /api/work-defs/:id/persona`,
   * kept in the source's kv so re-syncs never touch it), when set. It wins over
   * the source's suggestion (`WorkDefView.persona`) and the source's settings.
   */
  personaOverride?: string;
}

/** One registered external (pull-only) Work Source (`/api/status` `externalSources`). */
export interface ExternalSourceView {
  id: string;
  label: string;
  /**
   * Its `features.<name>` toggle (by default its id), or absent when it opted
   * out (`toggle: null`) and is always on. The UI hides its Work tab while
   * that feature is off.
   */
  feature?: string;
}

/**
 * One toggleable feature as the Config page lists it (`GET /api/config`
 * `featureSources`, in display order): the source that owns it, the source's
 * label, and whether it's external — an external source with active mirrors
 * can be *disconnected* (`POST /api/work-sources/:id/disconnect`).
 */
export interface FeatureSourceView {
  feature: string;
  sourceId: string;
  label: string;
  external: boolean;
}

/** `POST /api/work-sources/:id/disconnect`: the feature switched off and the mirrors archived. */
export interface DisconnectSourceResponse {
  success: boolean;
  error?: string;
  feature?: string;
  archived?: string[];
}

/**
 * How one `TeamConfig.packages` entry fared at daemon startup
 * (daemon/plugins/loader.ts): `GET /api/work-sources` `plugins`, and `mpt doctor`.
 */
export interface PluginLoadStatus {
  /** The package's dedupe identity (daemon/plugins/spec.ts), or null for an entry that didn't parse. */
  identity: string | null;
  /** The spec as written in config.json. */
  spec: string;
  /** "loaded": every entry (and persona) registered cleanly; "error": the package, or at least one of its entries or personas, failed. */
  state: "loaded" | "error";
  /** What went wrong (several failures joined by "; "), when `state` is "error". */
  error?: string;
  /** The ids of the Work Sources it registered (a partly failed package may still have some). */
  sources: string[];
  /**
   * The full ids (`<package name>/<id>`) of the personas it registered
   * (docs/DESIGN.md "Persona packages"). A persona with a lint error is still
   * registered (and makes `state` "error"). Always set by this daemon; optional
   * so a CLI talking to an older daemon reads its statuses.
   */
  personas?: string[];
  /**
   * Non-fatal problems found at load: a source's settings that don't match its
   * `configSchema` (daemon/sources/config-schema.ts), or a schema outside the
   * supported subset; a persona's lint warnings; a persona glob matching no
   * files. The source (or persona) still loaded.
   */
  warnings?: string[];
}

/** `GET /api/work-sources`: the registered external sources and each plugin package's load status. */
export interface WorkSourcesResponse {
  sources: ExternalSourceView[];
  plugins: PluginLoadStatus[];
}

/**
 * What `GET /api/sources` shows in place of a secret-looking setting (a string
 * under a token/secret/password/apiKey key, or a non-name in an env-var field).
 * Send it back unchanged in `PUT /api/sources/:id/config` / `preview` and the
 * stored value is kept (daemon/sources/settings.ts `restoreRedacted`).
 */
export const REDACTED_SETTING = "__mpt_redacted__";

/** One env-var reference in a source's settings: shown by name, with whether the daemon's environment has it. */
export interface SourceEnvVarRef {
  /** Where it is in the settings block: `key`, `group.key`, or `list[0]`. */
  path: string;
  /** The variable's name (never its value). */
  name: string;
  set: boolean;
}

/** One field-level settings problem (daemon/sources/config-schema.ts `ConfigFieldError`). */
export interface SourceFieldError {
  /** `""` for the block itself, else `key`, `group.key`, or `list[2]`. */
  path: string;
  message: string;
}

/** One registered Work Source as the Config page's Sources tab sees it (`GET /api/sources`). */
export interface SourceView {
  id: string;
  label: string;
  /**
   * Where it came from: `"built-in"` (stories, tasks, schedules, notes),
   * `"plugin"` (a `packages` entry — the only kind whose settings can be
   * saved), or `"external"` (an in-daemon external source, e.g. the dev fixture).
   */
  kind: "built-in" | "plugin" | "external";
  /** Declares `sync` (pull-only; mirrors items). */
  syncs: boolean;
  /** Its plugin package (`kind: "plugin"`): the spec as written and its identity. */
  package?: { spec: string; identity: string };
  /** External sources: `"work"` or `"triage"`. Absent for in-daemon kinds. */
  mode?: "work" | "triage";
  /** Its feature toggle, or null when it's always on. */
  toggle: { feature: string; enabled: boolean } | null;
  /**
   * Its declared settings schema (`WorkSource.configSchema`, a JSON Schema
   * subset with UI hints; plugin/index.ts `SourceConfigSchema`), when it has one.
   */
  configSchema?: Record<string, unknown>;
  /** Where that block lives in the package entry's `config`: all of it, or `config[<id>]`. */
  configScope: "package" | "source";
  /** Its current settings block (secrets replaced by `REDACTED_SETTING`). */
  options: Record<string, unknown>;
  /** Paths of the settings shown as `REDACTED_SETTING`. */
  redacted: string[];
  /** Env-var references in its settings, by name, and whether each is set. */
  envVars: SourceEnvVarRef[];
  /** Can `PUT /api/sources/:id/config` save it (a plugin source whose package entry is in config.json)? */
  configurable: boolean;
  /** Can `POST /api/sources/:id/preview` run it (it has `preview` or `sync`)? */
  previewable: boolean;
  /**
   * Why it isn't working: its last `init` failed (startup, or a re-init after
   * a Save), or — when init is fine — a persona problem: a triage-mode source
   * with no triage persona (or one that doesn't resolve), which doesn't sync
   * until one is set, or a work-mode source with triage-mode items waiting for
   * one (docs/DESIGN.md "Work Source personas"). Absent when fine.
   */
  initError?: string;
  /** The persona problem alone (also folded into `initError` when init is fine); absent when none. */
  personaError?: string;
  /**
   * The team's per-source persona setting for its work-mode items
   * (`sourcePersonas.<id>.persona`), or null. Set with `PUT /api/sources/:id/persona`.
   */
  persona: string | null;
  /** The source's declared `WorkSource.defaultPersona`, or null. */
  defaultPersona: string | null;
  /** The team's per-source triage persona (`sourcePersonas.<id>.triagePersona`), or null. */
  triagePersona: string | null;
  /** The source's declared `WorkSource.triagePersona`, or null. */
  defaultTriagePersona: string | null;
  /** External sources: sync health — the last sync that ran, and any backoff. Null otherwise. */
  sync: {
    running: boolean;
    failures: number;
    /** Backing off until (epoch ms); null when not. */
    backoffUntil: number | null;
    last: { at: number; ok: boolean; error?: string; mirrored: number; enqueued: number; archived: number; held: number } | null;
  } | null;
  /** External sources: how many active (non-archived) mirrored defs it has. Null otherwise. */
  activeMirrors: number | null;
}

/** `GET /api/sources`. */
export interface SourcesResponse {
  sources: SourceView[];
}

/** `POST /api/sources/:id/preview` body, and `PUT /api/sources/:id/config` body: the settings block. */
export interface SourceOptionsRequest {
  options: Record<string, unknown>;
}

/**
 * `POST /api/sources/:id/preview`: what a sync with the draft settings would
 * report — nothing mirrored or enqueued. `fieldErrors` with a 400.
 */
export interface SourcePreviewResponse {
  success: boolean;
  error?: string;
  fieldErrors?: SourceFieldError[];
  /** Which hook answered: the source's own `preview`, or its `sync` on a no-side-effects ctx. */
  via?: "preview" | "sync";
  items?: Array<{ externalId: string; revision: string; title: string; goal: string; url?: string; directory?: string; mode?: "work" | "triage" }>;
  warnings?: string[];
  note?: string;
}

/**
 * `PUT /api/sources/:id/config`: saved to config.json, then re-initialized.
 * `success` with `reinit.ok: false` = saved, but its `init` failed (the
 * source is marked errored). `reinit` lists every source of the package
 * (they share its `config`).
 */
export interface SourceConfigResponse {
  success: boolean;
  error?: string;
  fieldErrors?: SourceFieldError[];
  reinit?: Array<{ id: string; ok: boolean; error?: string }>;
  source?: SourceView;
}

/**
 * `PUT /api/sources/:id/persona`: the team's persona settings for a source
 * (config.json `sourcePersonas.<id>`). Absent keeps a field; null or "" clears
 * it; an id must resolve (400). Never re-initializes the source.
 */
export interface SourcePersonaRequest {
  persona?: string | null;
  triagePersona?: string | null;
}

/** `PUT /api/sources/:id/persona`. */
export interface SourcePersonaResponse {
  success: boolean;
  error?: string;
  source?: SourceView;
}

/** `PUT /api/work-defs/:id/persona`: a person's persona override on a mirror (null clears it). */
export interface MirrorPersonaRequest {
  persona: string | null;
}

/** One row of `GET /api/work-sources/:id/defs`: a mirrored def and how its runs went. */
export interface MirroredDefRow {
  id: string;
  title: string;
  externalId: string;
  url?: string;
  revision?: string;
  status: "active" | "archived";
  /** State of its newest WorkItem (any state, CANCELED included), or null if never run. */
  latestState: string | null;
  /** WorkItems created, CANCELED excluded (as `executionCount`). */
  runCount: number;
  lastRunAt: string | null;
  /** "triage" for an item in triage mode (MirrorView.mode). */
  mode: "work" | "triage";
  /** Triage-mode items only: the latest analysis's badge, as on a note (TriageBadge; "none" once decided). */
  triageBadge?: TriageBadge;
}

// GET /api/work-sources/:id/defs
export interface MirroredDefsResponse { source: ExternalSourceView; defs: MirroredDefRow[] }
export interface WorkDefsResponse { workDefs: WorkDefView[] }
export interface WorkDefResponse { workDef?: WorkDefView; success?: boolean; error?: string }
export interface SaveWorkDefRequest {
  title: string;
  /** Solitary (default) or Scheduled; Scheduled also creates a Schedule from `cron`. */
  type?: "Solitary" | "Scheduled";
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  directory?: string;
  /** Optional persona id (Solitary/Scheduled only; every run of a schedule uses it). */
  persona?: string;
  /** Required when type === "Scheduled": the cron for the created Schedule. */
  cron?: string;
  /** When true (default) for Solitary, also enqueue a WorkItem immediately. Ignored when pending. */
  enqueue?: boolean;
  /** Save as pending: editable, never enqueued until `POST /api/work-defs/:id/activate`. */
  pending?: boolean;
  /** @deprecated Legacy alias for `pending`, accepted for one release. */
  draft?: boolean;
}
export interface UpdateWorkDefRequest {
  title?: string;
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string | null;
  directory?: string | null;
  /** Solitary/Scheduled only: the persona id (`null` clears it). Changeable after activating. */
  persona?: string | null;
  /** For a Scheduled WorkDef, update its parent Schedule's cron. */
  cron?: string | null;
}
export interface SaveWorkDefResponse { success: boolean; workDef?: WorkDefView; error?: string }
// POST /api/work-defs/:id/activate — end pending (409 if it isn't pending).
// `POST /api/work-defs/:id/publish` is a deprecated alias, kept for one release.
export interface ActivateWorkDefRequest {
  /** Solitary only: enqueue on activate (default true). Board/Scheduled follow their parent. */
  enqueue?: boolean;
}
export interface ActivateWorkDefResponse { success: boolean; workDef?: WorkDefView; workItemId?: string | null; error?: string }

// --- Task Templates (reusable molds for Solitary tasks; see docs/ARCHITECTURE.md) ---
export interface TemplateView {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  additionalContext?: string;
  directory?: string;
}
export interface TemplatesResponse { templates: TemplateView[] }
export interface TemplateResponse { template?: TemplateView; success?: boolean; error?: string }
export interface SaveTemplateRequest {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  directory?: string;
}
export interface UpdateTemplateRequest {
  title?: string;
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string | null;
  directory?: string | null;
}
export interface SaveTemplateResponse { success: boolean; template?: TemplateView; error?: string }

// --- Schedules (cron parents) ---
/** `pending` is the Schedule's reversible pending flag (docs/DESIGN.md "Pending schedules: reversible, no catch-up"). */
export interface ScheduleView { id: string; title?: string; cron: string; lastEnqueuedAt?: string; pending: boolean }
export interface SchedulesResponse { schedules: ScheduleView[] }
// PUT /api/schedules/:id
export interface UpdateScheduleRequest { title?: string | null; cron?: string; pending?: boolean }
// POST /api/schedules/:id/pending, POST /api/schedules/:id/activate
export interface SetSchedulePendingResponse { success: boolean; schedule?: ScheduleView; error?: string }
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

// ─── Directory suggestions (docs/DESIGN.md "Favorite Directories") ───

// GET /api/directories — what every directory picker offers, in order.
export interface DirectoriesResponse {
  /** Favorites, in the user's order (team config `favoriteDirectories`). */
  favorites: string[];
  /** Recently used directories, most recent first, favorites excluded. */
  recent: string[];
}
// POST /api/directories/favorites  { directory }
export interface AddFavoriteDirectoryRequest { directory: string }
// PUT /api/directories/favorites   { directories } — replace (reorder) the list
export interface SetFavoriteDirectoriesRequest { directories: string[] }
// POST / PUT / DELETE /api/directories/favorites
export interface FavoriteDirectoriesResponse { success: boolean; favorites?: string[]; error?: string }

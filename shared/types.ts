/**
 * shared/types.ts — Shared type definitions and utilities used across daemon, CLI, and UI.
 *
 * Ported from pi-pizza-team/src/shared/types.ts for Deno runtime.
 */

/** Standard API response envelope. */
export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string;
}

export interface TeamConfig {
  port: number;
  tmuxSession: string;
  /** Built-in default workflows (used when no workflows/ directory exists). */
  workflows?: Record<string, WorkflowConfig>;
  defaultWorkflow: string;
  autosave: AutosaveConfig;
  maxTeammates?: number;
  teammates?: TeammateConfig;
  /** Seconds without heartbeat before an agent is marked offline (default: 90) */
  agentTimeoutSeconds?: number;
  /** Seconds a claimed assistant response turn may run before it's failed and the composer unlocks (default: 300) */
  assistantTurnTimeoutSeconds?: number;
  /** Seconds of user quiet (no typing, no new message) required before the assistant may claim a turn (default: 5) */
  assistantTurnDebounceSeconds?: number;
  /** API token for authentication (optional; required when binding non-localhost) */
  apiToken?: string;
  /** Per-host configuration (keyed by host ID) */
  hosts?: Record<string, HostConfig>;
}

/** Per-host configuration for multi-machine setups */
export interface HostConfig {
  /** tmux session name for this host (overrides top-level tmuxSession) */
  tmuxSession?: string;
}

export interface TeammateConfig {
  /** Nouns for name generation (defaults to sci-fi characters) */
  nouns?: string[];
}

/**
 * A workflow is an ordered list of **active states** between the implicit
 * `todo` and `done` buckets (see docs/WORK-MODEL.md). There is no transition
 * matrix: the daemon advances completed agent-state tasks to the next state
 * mechanically, admission pulls from `todo` (CONWIP), and humans/the leader
 * may move any task anywhere.
 */
export interface WorkflowConfig {
  states: WorkflowState[];
}

export interface WorkflowState {
  /** State name (must not be the reserved bucket names "todo"/"done"). */
  name: string;
  /**
   * - `agent`: worked by teammates via the claim protocol (its task's WorkItem
   *   is the in-flight unit; has an optional persona markdown file
   *   `workflows/<wf>/<name>.md`).
   * - `manual`: worked by a human/leader; moving the card onward is the
   *   completion. No WorkItem, no persona.
   */
  type: "agent" | "manual";
}

/** Implicit bucket states present in every workflow (never in config). */
export const TODO_STATE = "todo";
export const DONE_STATE = "done";

/**
 * The unit of agent execution: a single, dumb, terminal-only attempt to do some
 * work (see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md). A WorkItem points at its
 * work via a polymorphic `ref` (a story task, or a standalone WorkDef) and only
 * ever moves toward a terminal state. All rich detail (goal, comments, results)
 * lives on the ref, never here.
 */
export type WorkItemState =
  | "READY"        // waiting for a teammate to claim it
  | "IN_PROGRESS"  // leased to a teammate
  | "MORIBUND"     // the owning teammate went quiet (reaped); not dead yet
  | "COMPLETE"     // finished successfully (terminal)
  | "FAILED"       // the teammate gave up, or a moribund item was force-failed (terminal)
  | "CANCELED";    // a human canceled it before/instead of running (terminal)

/** Non-terminal states — a WorkItem in one of these is "in the queue / in flight". */
export const ACTIVE_WORK_ITEM_STATES: WorkItemState[] = ["READY", "IN_PROGRESS", "MORIBUND"];

/** Polymorphic pointer to the work a WorkItem represents. */
export type WorkItemRef =
  | { kind: "task"; storyId: string; taskId: string }
  | { kind: "workdef"; workDefId: string };

export interface WorkItem {
  id: string;
  /** Denormalized title for the queue/inbox/sidebar (from the ref at creation). */
  title: string;
  ref: WorkItemRef;
  /** Working directory copied from the ref at creation (affinity bias). */
  directory?: string;
  state: WorkItemState;
  /** Inbox unread flag (a notification concern, not part of the lifecycle). */
  read: boolean;
  /** The teammate that is/was working it. */
  memberId?: string;
  enqueuedAt: string;
  lastStateChangeAt: string;
}

/**
 * A durable, standalone work definition (see the refactor plan). `Solitary` is a
 * one-shot; `Scheduled` re-enqueues on its `cron`. (`Story` is reserved for a
 * future step folding story subtasks into WorkDefs.)
 */
export type WorkDefType = "Solitary" | "Scheduled";

export interface WorkDef {
  id: string;
  title: string;
  type: WorkDefType;
  /** What to achieve. */
  goal: string;
  /** How the agent knows it's done (MUST/SHOULD/MAY bullets). */
  acceptanceCriteria: string;
  /** Optional freeform markdown context. */
  additionalContext?: string;
  /** Context-library entry ids to inline into the prompt. */
  contextRefs?: string[];
  /** Optional working directory (affinity bias; agents cd here). */
  directory?: string;
  /** Cron expression (5-field); required when type === "Scheduled". */
  cron?: string;
  /** ISO timestamp of the last time a run was enqueued (scheduling bookkeeping). */
  lastEnqueuedAt?: string;
}

/**
 * Normalize a directory value for comparison: expand a leading `~` to $HOME and
 * strip a trailing slash. Applied at write time. Directory matching is only a
 * soft affinity bias, so an imperfect normalization (symlink/mount variants)
 * merely loses the preference — it never strands work (see the refactor plan).
 */
export function normalizeDirectory(dir: string): string {
  return dir.replace(/^~(?=$|\/)/, Deno.env.get("HOME") || "~").replace(/\/+$/, "");
}

export interface AutosaveConfig {
  flushIntervalMinutes: number;
  commitIntervalHours: number;
  commitMessage: string;
  autoCommit: boolean;
}

export interface Story {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  /**
   * Where the work happens. Plain data used as a soft affinity bias for
   * matching (agents cd here; see the refactor plan). Copied onto a task's
   * WorkItem at enqueue time.
   */
  directory?: string;
  /** When true, the story's tasks are not handed out to agents (temporal gate). */
  paused?: boolean;
  workflow?: string;
  /** Context-library entry ids attached to this story (injected into every task's prompt). */
  context?: string[];
  /**
   * The story owns its task ordering: an ordered list of task IDs. This keeps
   * order separate from a task's stable `id` and its `title`. `loadFromDisk`
   * reconciles it against the tasks actually on disk (appends orphans, ignores
   * danglers), so it tolerates hand-edits. Absent = fall back to creation order.
   */
  taskOrder?: string[];
  archivedAt?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Workflow position: an active state name, or the "todo"/"done" buckets. */
  status: string;
  result: string | null;
  /** Context-library entry ids attached to this task (injected into its prompt). */
  context?: string[];
  tokenUsage?: TokenUsage[];
}

export interface TaskWithMeta extends Task {
  storyId: string;
  seq: number;
  slug: string;
  dirPath: string;
}

export interface CommentAttachment {
  name: string;
  size: number;
  type: string;
}

export interface Comment {
  from: string;
  body: string;
  at: string;
  attachments?: CommentAttachment[];
}

export interface Member {
  id: string;
  name: string;
  /** Working directory (the agent's pi cwd). Drives directory-affinity matching. */
  directory?: string;
  /**
   * Opaque harness-owned metadata supplied at registration (e.g. the leader's
   * tmux window). The daemon stores and relays it verbatim and never interprets
   * it — it exists so the harness can realize control intents (see agent commands).
   */
  metadata?: Record<string, unknown>;
  hostId?: string;
  status: "idle" | "working" | "pairing" | "offline";
  lastHeartbeat: number;
}

export interface Assignment {
  taskId: string;
  memberId: string;
  claimedAt: number;
}

export const DEFAULT_CONFIG: TeamConfig = {
  port: 7437,
  tmuxSession: "my-pizza-team",
  defaultWorkflow: "default",
  workflows: {
    default: {
      states: [
        { name: "in_progress", type: "agent" },
        { name: "review", type: "manual" },
      ],
    },
  },
  autosave: {
    flushIntervalMinutes: 30,
    commitIntervalHours: 24,
    commitMessage: "my-pizza-team: checkpoint {timestamp}",
    autoCommit: true,
  },
  maxTeammates: 4,
  agentTimeoutSeconds: 90,
  assistantTurnTimeoutSeconds: 300,
  assistantTurnDebounceSeconds: 5,
  teammates: {},
};

export const TEAM_DIR = ".my-pizza-team";
export const CONFIG_FILE = "config.json";
export const STATE_DB = "state.db";
export const STORIES_DIR = "stories";
export const ARCHIVED_DIR = "archived";
export const BACKLOG_DIR = "backlog";
export const WORKFLOWS_DIR = "workflows";
/** Directory holding standalone WorkDef markdown files (Solitary + Scheduled). */
export const WORKDEFS_DIR = "tasks";

/** Generate a URL-safe slug from a title (max 40 chars) */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Default adjectives for teammate name generation */
export const DEFAULT_ADJECTIVES = [
  "swift", "bold", "keen", "calm", "bright",
  "deft", "firm", "sharp", "brave", "quick",
  "sly", "warm", "cool", "wild", "fair",
  "wry", "apt", "sage", "prime", "vivid",
];

/** Default nouns for teammate name generation (sci-fi characters) */
export const DEFAULT_NOUNS = [
  "ripley", "kirk", "spock", "solo", "neo",
  "trinity", "deckard", "muad-dib", "case", "molly",
  "picard", "data", "worf", "uhura", "sulu",
  "riker", "bones", "chekov", "scotty", "seven",
  "janeway", "tuvok", "odo", "quark", "kira",
  "adama", "starbuck", "gaius", "athena", "apollo",
];

/** Generate a unique teammate name (adjective-noun) that doesn't collide with existing names */
export function generateTeammateName(existingNames: Set<string>, config?: TeammateConfig): string {
  const nouns = config?.nouns?.length ? config.nouns : DEFAULT_NOUNS;
  const adjectives = DEFAULT_ADJECTIVES;

  for (let i = 0; i < 100; i++) {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const name = `${adj}-${noun}`;
    if (!existingNames.has(name)) return name;
  }

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  let name = `${adj}-${noun}`;
  let i = 2;
  while (existingNames.has(name)) { name = `${adj}-${noun}-${i}`; i++; }
  return name;
}

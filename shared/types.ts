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
  /**
   * Recently used capabilities, as a map of capability name -> known values
   * (most-recent-first, deduped, capped). Presence-only capabilities map to an
   * empty array. Auto-populated when stories declare `requirements` and when
   * agents register `capabilities`; also editable via the /api/capabilities API.
   * Used to drive autocomplete for requirement/capability keys and their values.
   */
  recentCapabilities?: Record<string, string[]>;
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
   * - `agent`: worked by teammates via the claim protocol (has substatus,
   *   and an optional persona markdown file `workflows/<wf>/<name>.md`).
   * - `manual`: worked by a human/leader; moving the card onward is the
   *   completion. No substatus, no persona.
   */
  type: "agent" | "manual";
}

/** Implicit bucket states present in every workflow (never in config). */
export const TODO_STATE = "todo";
export const DONE_STATE = "done";

/** A task's within-state position. Only tasks in agent states have one. */
export type TaskSubstatus = "ready" | "claimed";

/**
 * A capability/requirement map.
 *
 * Used two ways:
 * - On an agent (Member.capabilities): the capabilities the agent *has*.
 *   Keys are capability names, values are optional detail (e.g. a version).
 * - On a story (Story.requirements): the capabilities a story *needs*.
 *   A `null` value means "agent must have this capability, any value";
 *   a non-null value means "agent's value for this capability must match exactly".
 *
 * Note: a story's working directory is NOT a capability — it's the plain
 * `Story.directory` field; agents `cd` there (see docs/WORK-MODEL.md).
 */
export type Capabilities = Record<string, string | null>;

/**
 * How an agent selects which work to pick up.
 * - `eager-helper` (default): any story whose requirements the agent satisfies.
 * - `assigned-story`: only the agent's assigned story; when its tasks are
 *   exhausted the daemon archives the story and dismisses the agent.
 */
export type WorkMode = "eager-helper" | "assigned-story";

/** Default work mode when an agent does not specify one. */
export const DEFAULT_WORK_MODE: WorkMode = "eager-helper";

/**
 * Normalize a directory value for exact-match comparison: expand a leading
 * `~` to $HOME and strip a trailing slash. Applied at write time so the
 * matcher itself can stay a dumb exact-string comparison.
 */
export function normalizeDirectory(dir: string): string {
  return dir.replace(/^~(?=$|\/)/, Deno.env.get("HOME") || "~").replace(/\/+$/, "");
}

/**
 * Does an agent with the given capabilities satisfy all of a story's requirements?
 * For each required (name, value): the agent must have `name`, and if `value`
 * is non-null the agent's value must equal it exactly.
 */
export function meetsRequirements(capabilities: Capabilities, requirements?: Capabilities): boolean {
  if (!requirements) return true;
  for (const [name, requiredValue] of Object.entries(requirements)) {
    if (!(name in capabilities)) return false;
    if (requiredValue !== null && capabilities[name] !== requiredValue) return false;
  }
  return true;
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
  /** Capabilities an agent must have to work this story (see Capabilities). */
  requirements?: Capabilities;
  /**
   * Where the work happens. Plain data (not a matching key): the task prompt
   * instructs the agent to `cd` here and read the repo's AGENTS.md first.
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
  /** Within-state position; only present for tasks in agent states. */
  substatus?: TaskSubstatus | null;
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
  /** Capabilities this agent has, including the well-known `directory` key. */
  capabilities: Capabilities;
  /** How this agent selects work. */
  workMode: WorkMode;
  /** For workMode `assigned-story`: the story this agent is bound to. */
  assignedStoryId?: string;
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

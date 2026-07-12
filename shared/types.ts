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
  /** Configurable memory categories for the knowledge base */
  categories?: string[];
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

/** Default memory categories for the knowledge base */
export const DEFAULT_CATEGORIES = ["coding", "research", "doc-writing"];

export interface WorkflowConfig {
  states: string[];
  transitions: Record<string, Record<string, TransitionPermission>>;
  /** The state tasks start in (defaults to first state in states array) */
  initialState?: string;
  /** The terminal state meaning work is complete (defaults to last state in states array) */
  doneState?: string;
  /** Default memory categories for stories using this workflow */
  categories?: string[];
  /** Instruction files per state (relative to workflow directory) */
  instructions?: Record<string, string>;
}

export type TransitionPermission = "any" | "teammate" | "lead";

/**
 * A capability/requirement map.
 *
 * Used two ways:
 * - On an agent (Member.capabilities): the capabilities the agent *has*.
 *   Keys are capability names, values are optional detail (e.g. a version,
 *   or the agent's working directory for the well-known `directory` key).
 * - On a story (Story.requirements): the capabilities a story *needs*.
 *   A `null` value means "agent must have this capability, any value";
 *   a non-null value means "agent's value for this capability must match exactly".
 *
 * There is no special case for working directory: it is simply the well-known
 * `directory` capability (see DIRECTORY_CAP) whose required value is matched
 * exactly. See docs/DESIGN.md "Capability-Based Work Matching".
 */
export type Capabilities = Record<string, string | null>;

/** Well-known capability key for an agent's working directory / a story's directory affinity. */
export const DIRECTORY_CAP = "directory";

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
  /** When true, the story's tasks are not handed out to agents (temporal gate). */
  paused?: boolean;
  workflow?: string;
  categories?: string[];
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
  status: string;
  result: string | null;
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
      states: ["todo", "in_progress", "review", "done"],
      transitions: {
        todo: { in_progress: "any" },
        in_progress: { review: "teammate" },
        review: { done: "lead", in_progress: "lead" },
      },
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
  categories: DEFAULT_CATEGORIES,
  teammates: {},
};

export interface TransitionInstructions {
  onEnter?: string;
  onExit?: string;
}

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

/** Get the initial state for a workflow (first state unless overridden) */
export function getInitialState(wf: WorkflowConfig): string {
  return wf.initialState || wf.states[0] || "todo";
}

/** Get the done/terminal state for a workflow (last state unless overridden) */
export function getDoneState(wf: WorkflowConfig): string {
  return wf.doneState || wf.states[wf.states.length - 1] || "done";
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

/**
 * shared/types.ts — Shared type definitions and utilities used across daemon, CLI, and UI.
 *
 * Originally ported from the standalone pi-pizza-team extension for the Deno
 * runtime. That extension now lives in this repo at harnesses/pi/, and P1c-7 folds
 * its remaining local type copy into this file.
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
  /**
   * Target size of the generalist teammate pool: the daemon keeps at least this
   * many teammates online, spawning replacements (via leader `spawn` directives)
   * whenever the pool dips below it. When unset, defaults to half of
   * `maxTeammates` (rounded down) — see `resolveMinTeammates`. An explicit value
   * (including 0) always wins. Capped by `maxTeammates`. Team size is declared
   * once, not clicked into existence.
   */
  minTeammates?: number;
  teammates?: TeammateConfig;
  /** Seconds without heartbeat before an agent is marked offline (default: 90) */
  agentTimeoutSeconds?: number;
  /** API token for authentication (optional; required when binding non-localhost) */
  apiToken?: string;
  /**
   * Start-command templates by harness name.
   *
   * The daemon fills a template and types it into a fresh tmux window
   * (docs/DESIGN.md "The Daemon Is the Supervisor"). Living in team config rather than in
   * extension code is the point: adding a harness becomes a config change instead of
   * an extension release, which is what makes Tier 0 support possible at all (DESIGN.md "Harness Tiers, and Why Not MCP").
   *
   * Placeholders: `{name}` (daemon-assigned agent name), `{url}` (daemon URL),
   * `{cwd}` (working directory, shell-quoted on substitution), `{session}` and
   * `{window}` (its tmux location).
   *
   * Unset means the built-in defaults (`DEFAULT_HARNESS_TEMPLATES`).
   */
  harnesses?: Record<string, HarnessTemplates>;
  /** Which harness to spawn when none is named. Defaults to "pi". */
  defaultHarness?: string;
  /**
   * Readiness probe command. The leader runs this on each heartbeat; exit 0 =
   * ready, non-zero = not ready (stdout's first line = reason). A not-ready team
   * holds scheduled enqueues instead of failing them. See docs/ARCHITECTURE.md
   * "Scheduler readiness gating".
   */
  readinessProbe?: string;
}

export interface TeammateConfig {
  /** Nouns for name generation (defaults to sci-fi characters) */
  nouns?: string[];
}

/**
 * A workflow is an ordered list of **active states** between the implicit
 * `todo` and `done` buckets (see docs/DESIGN.md "The Work Model"). There is no transition
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
 * work (see docs/DESIGN.md "The WorkItem"). A WorkItem points at its
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

/** Polymorphic pointer to the work a WorkItem represents. Every unit of work is
 * now a WorkDef, so the ref is simply its id (the old task|workdef union
 * collapsed — see docs/DESIGN.md "WorkDefs & Parents"). */
export interface WorkItemRef {
  workDefId: string;
}

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
 * Every unit of work is a WorkDef: purely *authored* content (see
 * docs/DESIGN.md "WorkDefs & Parents"). A WorkDef names its `parent` (the enqueuer that
 * decides when it emits WorkItems); its "type" is derived from the parent kind:
 *   - parent { kind: "story" }    → a board task (workflow-driven)
 *   - parent { kind: "schedule" } → scheduled (cron-driven)
 *   - no parent                    → Solitary (manual)
 * No mutable/runtime state lives on a WorkDef: workflow status lives on the
 * Story, cron/lastEnqueuedAt on the Schedule. The daemon never rewrites a
 * WorkDef file except on an explicit human/agent edit.
 */
export type WorkDefParentKind = "story" | "schedule";

export interface WorkDefParent {
  kind: WorkDefParentKind;
  id: string;
}

/** Derived label for a WorkDef, from its parent kind. */
export type WorkDefType = "Solitary" | "Scheduled" | "Board";

/** Derive the display type from a WorkDef's parent. */
export function workDefType(parent?: WorkDefParent): WorkDefType {
  if (!parent) return "Solitary";
  return parent.kind === "schedule" ? "Scheduled" : "Board";
}

export interface WorkDef {
  id: string;
  title: string;
  /** The enqueuer that owns this WorkDef. Absent = Solitary (manual). */
  parent?: WorkDefParent;
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
  /** Lifecycle status: active (default) or archived. */
  status?: "active" | "archived";
}

/**
 * A Task Template: a reusable *mold* for a Solitary WorkDef. It carries the same
 * authored fields as a WorkDef (title / goal / acceptance criteria / additional
 * context / directory / contextRefs) but has **no parent and no runtime state**
 * — it never enqueues a WorkItem and never appears in the WorkItem queue. It
 * exists only to pre-fill a new Solitary task. Stored as
 * `templates/<id>/template.md`, reusing the WorkDef markdown format (files are
 * the source of truth, like Schedules/Thoughts — no SQLite index). See
 * docs/ARCHITECTURE.md "Templates".
 */
export interface Template {
  id: string;
  title: string;
  /** What to achieve (pre-fills the new task's Goal). */
  goal: string;
  /** How the agent knows it's done (pre-fills Acceptance Criteria). */
  acceptanceCriteria: string;
  /** Optional freeform markdown context. */
  additionalContext?: string;
  /** Context-library entry ids to pre-select on the new task. */
  contextRefs?: string[];
  /** Optional working directory to pre-fill. */
  directory?: string;
}

/** A cron enqueuer: fires a WorkItem for each of its child WorkDefs on schedule. */
export interface Schedule {
  id: string;
  title?: string;
  /** 5-field cron expression. */
  cron: string;
  /** ISO timestamp of the last time this schedule enqueued its children. */
  lastEnqueuedAt?: string;
  /**
   * Set when a due occurrence was held back because no ready agent could take
   * its work (e.g. a teammate whose credentials expired reported not-ready).
   * The scheduler fires the held occurrence once when an agent becomes ready
   * again — collapsing any missed occurrences into a single catch-up run so
   * the queue never accumulates a per-occurrence backlog. See
   * docs/ARCHITECTURE.md "Scheduler readiness gating".
   */
  heldForReadiness?: boolean;
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

/** A child WorkDef of a story: its id plus its workflow position (the story owns
 * both the ordering and the mutable status — see docs/DESIGN.md "WorkDefs & Parents"). */
export interface StoryTaskRef {
  id: string;
  /** Workflow position: an active state name, or the "todo"/"done" buckets. */
  status: string;
}

export interface Story {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  /**
   * Where the work happens. Plain data used as a soft affinity bias for
   * matching (agents cd here). A child WorkDef's own `directory` takes
   * precedence; this is the story-wide fallback, copied onto the WorkItem.
   */
  directory?: string;
  /** When true, the story's tasks are not handed out to agents (temporal gate). */
  paused?: boolean;
  workflow?: string;
  /** Context-library entry ids attached to this story (injected into every child's prompt). */
  context?: string[];
  /**
   * The story's child WorkDefs, in order, each with its workflow position. This
   * is the single source of truth for both ordering and status (no parallel
   * taskOrder/taskStatus that could drift). `loadFromDisk` reconciles it against
   * the WorkDefs actually on disk (appends orphans, ignores danglers).
   */
  tasks: StoryTaskRef[];
  archivedAt?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
  at: string;
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
  /**
   * The agent-protocol version this agent's harness reported at registration.
   * `undefined` means a pre-handshake harness — accepted, but surfaced in the UI
   * so an un-upgraded agent is visible rather than silently half-working
   * (docs/DESIGN.md "One Protocol, One Version", P1b).
   */
  protocolVersion?: number;
  /** Which harness this agent runs under (e.g. "pi"). */
  harness?: string;
  /** The harness integration's build version. Informational — never gated on. */
  harnessVersion?: string;
  status: "idle" | "working" | "pairing" | "offline";
  lastHeartbeat: number;
}

/**
 * The team's current readiness, from an optional probe (e.g. "are the shared
 * credentials on this box valid?").
 *
 * Motivating case (docs/ARCHITECTURE.md "Scheduler readiness gating"): when
 * credentials expire on a cloud desktop, every claimed WorkItem fails, so an
 * overnight cron would pile up FAILED runs. A not-ready team *holds* scheduled
 * enqueues instead, and the held Schedule re-fires exactly once on recovery.
 *
 * Team-level, not per-host: multi-host was removed in P1c (docs/DESIGN.md
 * DESIGN.md "One Host, One Leader"), and credential/VPN/network state is a property of the machine the team
 * runs on. Ephemeral connection state, not persisted across restarts — with no
 * report yet, the team is treated as ready.
 */
export interface TeamReadiness {
  ready: boolean;
  /** Human-readable reason when not ready (e.g. "mwinit credentials expired"). */
  reason?: string;
  /** Epoch ms of the last report. */
  at: number;
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
  // minTeammates is deliberately absent: unset means "half of maxTeammates"
  // (resolveMinTeammates), so the default tracks the cap instead of freezing it.
  agentTimeoutSeconds: 90,
  teammates: {},
};

// ─── Shared constants ────────────────────────────────────────────────
//
// Canonical home for the handful of values both the daemon and a harness need.
// harnesses/pi/src/shared/types.ts is *generated* from these by
// `deno task sync-shared`, so there is one definition rather than two that drift
// (docs/DESIGN.md "One Protocol, One Version", P1c-7).

/** Team directory name. */
export const TEAM_DIR = ".my-pizza-team";
/** Team directory name before the rename; still recognised when discovering one. */
export const LEGACY_TEAM_DIR = ".pi-pizza-team";
/** Where a harness looks for the daemon when nothing else says otherwise. */
export const DEFAULT_DAEMON_URL = "http://localhost:7437";

export const CONFIG_FILE = "config.json";

/**
 * How to start each role under one harness.
 *
 * Separated by role because they are not interchangeable, and because a Tier 0
 * harness may be able to do useful work as a teammate while being unable to host the
 * chat — leading needs an in-process adapter (Tier 2), so `leader` is optional.
 */
export interface HarnessTemplates {
  /** Command to start a teammate (an autonomous worker). */
  teammate: string;
  /** Command to start the leader, for a harness that can host the chat. */
  leader?: string;
}

/**
 * Built-in templates, used when `TeamConfig.harnesses` is unset.
 *
 * `-a` (--approve) matters on the teammate: without it a teammate spawned into a
 * folder outside a trusted parent blocks on Pi's "Trust project folder?" prompt, and
 * the permissive config written into the cwd is only applied once the project is
 * trusted anyway. The leader is started by `mpt lead` in a folder the user chose, so
 * `mpt setup` has already trusted it.
 *
 * Both pass their tmux location so the agent reports it at registration, which is
 * how the daemon addresses the right window later (spawn, dismiss, reset-session).
 */
export const DEFAULT_HARNESS_TEMPLATES: Record<string, HarnessTemplates> = {
  pi: {
    teammate:
      "pi -a --ppt-worker --ppt-daemon={url} --ppt-name={name} --ppt-tmux-session={session} --ppt-tmux-window={window}",
    leader: "pi --ppt-lead --ppt-daemon={url} --ppt-tmux-session={session} --ppt-tmux-window={window}",
  },
};

/** The tmux window name the leader runs in. Fixed, since there is exactly one. */
export const LEADER_WINDOW = "leader";

/** The harness spawned when nothing says otherwise. */
export const DEFAULT_HARNESS = "pi";

/**
 * The default steady team size when `minTeammates` isn't set: half the
 * `maxTeammates` cap, rounded down (4 → 2, 1 → 0). Derived rather than stored so
 * raising the cap raises the default too, until a size is declared explicitly.
 */
export function defaultMinTeammates(config: Pick<TeamConfig, "maxTeammates">): number {
  return Math.floor(Math.max(0, config.maxTeammates ?? 0) / 2);
}

/**
 * The effective steady team size: the explicit `minTeammates` (0 included) or,
 * when unset, `defaultMinTeammates`. Always capped by `maxTeammates` (0/unset
 * means uncapped).
 */
export function resolveMinTeammates(config: Pick<TeamConfig, "maxTeammates" | "minTeammates">): number {
  const min = config.minTeammates ?? defaultMinTeammates(config);
  const max = config.maxTeammates ?? 0;
  return max > 0 ? Math.min(min, max) : min;
}
export const STATE_DB = "state.db";
export const STORIES_DIR = "stories";
export const ARCHIVED_DIR = "archived";
export const BACKLOG_DIR = "backlog";
export const WORKFLOWS_DIR = "workflows";
/** Directory holding every WorkDef (`tasks/<id>/workdef.md` + comments + attachments). */
export const WORKDEFS_DIR = "tasks";
/** Directory holding cron Schedule files (`schedules/<id>.json`). */
export const SCHEDULES_DIR = "schedules";
/** Directory holding Task Templates (`templates/<id>/template.md`; molds for Solitary tasks). */
export const TEMPLATES_DIR = "templates";

/**
 * Directory holding assistant-chat artifacts. Session transcripts are markdown
 * snapshots under `assistant/sessions/<id>.md` (see docs/DESIGN.md "Assistant Chat Model").
 */
/**
 * The token-usage ledger: `usage/YYYY-MM.jsonl`, one JSON line per agent run
 * (daemon/store/usage.ts). Files are the source of truth — committed with the
 * rest of the team dir — and SQLite is a cache rebuilt from them on boot.
 */
export const USAGE_DIR = "usage";
export const ASSISTANT_DIR = "assistant";
export const ASSISTANT_SESSIONS_DIR = "sessions";

/** Directory holding thought notes (`thoughts/<id>.md`); groups live in `groups.json`. */
export const THOUGHTS_DIR = "thoughts";
export const THOUGHT_GROUPS_FILE = "groups.json";

/**
 * A thought: a markdown sticky note on the Thoughts canvas (a personal
 * workspace/outbox that feeds the assistant). Ported/simplified from the
 * standalone "Thoughts" product: two-state lifecycle (active⇄archived, direct
 * delete allowed), pinning as an orthogonal flag (not a state), and no
 * auto-sweeps. Stored as `thoughts/<id>.md` with frontmatter; the markdown
 * body is the note content. Canvas geometry (x/y/w/h/z) rides the frontmatter
 * and is flushed to disk debounced (dirty-flag), while content edits flush
 * promptly. See docs/ARCHITECTURE.md "Thoughts".
 */
export type ThoughtStatus = "active" | "archived";

export interface Thought {
  id: string;
  /** Markdown note body. */
  content: string;
  /** A color key from the fixed palette (see THOUGHT_COLORS). */
  color: string;
  status: ThoughtStatus;
  /** World coordinates (zoom/pan independent). */
  x: number;
  y: number;
  /** null until the user explicitly resizes (auto-sized otherwise). */
  w: number | null;
  h: number | null;
  zIndex: number;
  pinned: boolean;
  /** id of the ThoughtGroup this note belongs to (exclusive), or null. */
  groupId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A named group of thoughts (a spatial container rectangle on the canvas).
 * Membership lives on each note's `groupId` (the note file is the source of
 * truth); the group owns its own position/size so it can exist while empty and
 * act as a drop target. */
export interface ThoughtGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Manual plate tint: a THOUGHT_COLORS key, or null for the neutral default. */
  groupColor: string | null;
  /** Plate fill strength. */
  plateOpacity: "subtle" | "medium" | "solid";
}

export const PLATE_OPACITIES = ["subtle", "medium", "solid"] as const;

/** Default plate size for a newly created group. */
export const DEFAULT_GROUP_SIZE = { w: 360, h: 260 };

/** The fixed note palette (the lighter canvas drops the 16-key superset). */
export const THOUGHT_COLORS = ["yellow", "blue", "green", "pink", "purple", "orange"] as const;
export const DEFAULT_THOUGHT_COLOR = "yellow";

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

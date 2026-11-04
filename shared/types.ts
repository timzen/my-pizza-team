/**
 * shared/types.ts — Shared type definitions and utilities used across daemon, CLI, and UI.
 *
 * The canonical definitions. The Pi extension (harnesses/pi/) has no copy of
 * these types; the few constants it needs are generated from this file into
 * harnesses/pi/src/shared/types.ts by `npm run sync-shared`. (What it needs of the
 * protocol itself — feature names included — is shared/agent-protocol.ts.)
 *
 * Keep this module free of `node:` imports and Node globals: the web UI imports
 * its types (and a few pure constants) directly. Helpers that need the file
 * system live beside it — `normalizeDirectory` is in shared/directory.ts.
 */

import { FEATURE_NAMES, type FeatureName } from "./agent-protocol.ts";

/** Standard API response envelope. */
export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string;
}

export interface TeamConfig {
  port: number;
  /**
   * The name of the team's terminal container, whichever terminal backend runs
   * it: the tmux session (`tmux attach -t <tmuxSession>`), or the herdr workspace
   * label (docs/herdr.md). Kept under its historical name rather than renamed, so
   * every existing config.json, `/health` reader and menu bar app keeps working;
   * "tmux" in the key is history, not a constraint (docs/DESIGN.md "The Daemon Is
   * the Supervisor").
   */
  tmuxSession: string;
  /**
   * Which terminal backend the daemon opens agent windows in (`TERMINAL_KINDS`).
   * Unset = `"tmux"` (`resolveTerminal`). Applies to *new* windows only: an agent
   * already running stays in the terminal it was started under, and dismiss/focus
   * address it there (its `terminal` metadata), so switching never strands a
   * window. `"herdr"` needs herdr ≥ 0.9.5 on the daemon's PATH (daemon/terminal/herdr.ts,
   * docs/herdr.md); without it spawns are refused with the reason and fix.
   */
  terminal?: TerminalKind;
  /**
   * The herdr session (server) agent windows open in when `terminal` is `"herdr"`.
   * Unset = herdr's default session, the one plain `herdr` attaches to; a name
   * (letters, digits, `.`, `_`, `-`) gives the team its own server, attached with
   * `herdr session attach <name>`. config.json only — not on the Config page.
   */
  herdrSession?: string;
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
   * `{cwd}` (working directory, shell-quoted on substitution), `{terminal}` (the
   * terminal backend the window opens in, `TERMINAL_KINDS`), `{terminalSession}` and
   * `{terminalWindow}` (its location there — the container and window labels), and
   * `{terminalHandle}` (the backend's own ID for the window when it knows one before
   * the command runs, else empty). `{session}` and `{window}` are the older names of
   * `{terminalSession}`/`{terminalWindow}` and still work. See `TERMINAL_METADATA_KEYS`
   * for how an agent reports them back.
   *
   * Unset means the built-in defaults (`DEFAULT_HARNESS_TEMPLATES`).
   */
  harnesses?: Record<string, HarnessTemplates>;
  /** Which harness to spawn when none is named. Defaults to "pi". */
  defaultHarness?: string;
  /**
   * Opt-ins for what's still being vetted. `harnesses`: allow non-Pi teammates
   * (Kiro, Claude Code — `mpt agent`). Off by default: the daemon refuses to spawn or
   * register them without it.
   */
  experimental?: { harnesses?: boolean };
  /**
   * Development/test-only switches. `fixtureSource` registers the in-repo
   * markdown-folder Work Source (daemon/sources/fixture.ts) — the stand-in for
   * an external (pull-only) source while package loading is deferred (TODO.md
   * "Work Sources as plugins — package loading (deferred)"). Hand-edited only;
   * never written by `mpt setup` or the Config page.
   */
  dev?: { fixtureSource?: FixtureSourceConfig };
  /**
   * Plugin packages for this team (TODO.md "Work Sources as plugins — package
   * loading"), mirroring pi's `packages`. Each entry is a spec string or
   * `{ source, config }`; parsed and validated by daemon/plugins/spec.ts
   * (`parsePackageEntries`), where an invalid entry is reported, never fatal.
   * Hand-edited (or via `mpt plugins`); a change needs a daemon restart.
   */
  packages?: PackageEntry[];
  /**
   * One teammate per directory (default true). While a WorkItem with a
   * `directory` is IN_PROGRESS or MORIBUND, no other WorkItem whose directory
   * overlaps it (same path, parent, or child) is handed out — so two pieces of
   * work never edit and commit in the same checkout at once. Items with no
   * directory are exempt. `false` restores unrestricted parallelism. See
   * docs/DESIGN.md "Work Matching: Directory Affinity".
   */
  exclusiveDirectories?: boolean;
  /**
   * Favorite working directories, in the user's order. Every directory picker
   * in the UI offers these first, ahead of recently used directories. Stored
   * normalized (`normalizeDirectory`: `~` expanded, symlinks resolved) and
   * deduped. Edited through `/api/directories/favorites` (Store owns the list),
   * not `PUT /api/config`. See docs/DESIGN.md "Favorite Directories".
   */
  favoriteDirectories?: string[];
  /**
   * Readiness probe command. The daemon runs it every 30s (daemon/readiness.ts);
   * exit 0 = ready, non-zero = not ready (its first line of output = reason). A not-ready team
   * holds scheduled enqueues instead of failing them. See docs/ARCHITECTURE.md
   * "Scheduler readiness gating".
   */
  readinessProbe?: string;
  /**
   * A file of environment variables every agent window gets (shared/env-file.ts):
   * systemd `EnvironmentFile=` syntax (KEY=value lines, `#` comments, optional
   * quotes, no shell expansion). `~` is expanded and a relative path is resolved
   * against the team directory. Re-read each time the daemon (or `mpt lead`)
   * opens a window and passed with `tmux new-window -e`, so an edit applies to the
   * next teammate with no restart; `mpt install` also points the service at it.
   * A missing or invalid file never blocks a spawn — the window opens without it
   * and the daemon log and `mpt doctor` say why. Unset = nothing passed.
   * See docs/DESIGN.md "The Agent Environment Is a File".
   */
  agentEnvFile?: string;
  /**
   * Auto-triage: a teammate reads each changed note and replies with an analysis
   * (TODO.md "Auto Triage"). On by default. The sweep runs every
   * `intervalMinutes` and skips notes edited within `quietMinutes`, so it never
   * reads a half-written thought.
   */
  triage?: TriageConfig;
  /**
   * Automatic retry of a WorkItem whose agent session *errored* (the model call
   * failed — e.g. a Bedrock 503 or expired credentials — rather than the agent
   * finishing or giving up). See docs/DESIGN.md "Errored Sessions Retry".
   * Read it through `resolveRetry`, never directly.
   */
  retry?: RetryConfig;
  /**
   * Which work-item kinds this team uses (docs/DESIGN.md "Feature Toggles").
   * Absent — every team that predates the toggles — means everything on; a new
   * team (`mpt setup`) starts with `NEW_TEAM_FEATURES`. Read it through
   * `resolveFeatures`, never directly.
   */
  features?: FeaturesConfig;
  /**
   * How the user talks to the assistant (the leader). Read it through
   * `resolveAssistantChatMode`, never directly. See docs/DESIGN.md
   * "Assistant Chat Model" and "Watching and Pairing with a Teammate".
   */
  assistant?: AssistantConfig;
  /**
   * Per-source persona settings, daemon-held (docs/DESIGN.md "Work Source
   * personas"): `persona` for a source's work-mode items, `triagePersona` for its
   * triage-mode items. Keyed by Work Source id; values are persona ids.
   */
  sourcePersonas?: Record<string, SourcePersonaSetting>;
}

/** One `TeamConfig.sourcePersonas` entry. */
export interface SourcePersonaSetting {
  persona?: string;
  triagePersona?: string;
}

/**
 * The assistant's UI. `chat` (the default) is the iMessage-style bubble chat;
 * `terminal` is the same transcript view and composer used to watch and pair
 * with a teammate.
 */
export type AssistantChatMode = "chat" | "terminal";

/** Every assistant chat mode, default first. */
export const ASSISTANT_CHAT_MODES: readonly AssistantChatMode[] = ["chat", "terminal"];

/** The `assistant` block of TeamConfig. */
export interface AssistantConfig {
  /** Missing (or anything unrecognized) means `chat`, so existing teams see no change. */
  chatMode?: AssistantChatMode;
  /**
   * The assistant's persona id (docs/DESIGN.md "Personas"); unset means
   * `builtin:assistant`. Written by `PUT /api/assistant/persona`, which also ends
   * the current chat session.
   */
  persona?: string;
}

/** Is `value` a valid `AssistantChatMode`? Used to validate `PUT /api/config`. */
export function isAssistantChatMode(value: unknown): value is AssistantChatMode {
  return typeof value === "string" && (ASSISTANT_CHAT_MODES as readonly string[]).includes(value);
}

/**
 * The assistant chat mode with the default applied: a missing block, a missing
 * mode, or an invalid (hand-edited) value is `chat`.
 */
export function resolveAssistantChatMode(config: Pick<TeamConfig, "assistant">): AssistantChatMode {
  const mode = config.assistant?.chatMode;
  return isAssistantChatMode(mode) ? mode : "chat";
}

/**
 * The work-item kinds a team can switch off. `tasks` covers Solitary tasks and
 * Task Templates; `stories` covers stories and their board tasks; `schedules`
 * covers Scheduled WorkDefs and their Schedules. Thoughts, Context, and the
 * Inbox are always on. A missing flag means on.
 */
export type FeaturesConfig = Partial<Record<FeatureName, boolean>>;

// `FeatureName` (one switchable kind) and `FEATURE_NAMES` (every one, in display
// order) are defined with the agent protocol — a harness gates its tools on them —
// in agent-protocol.ts, and re-exported here.
export { FEATURE_NAMES, type FeatureName };

/** What `mpt setup` writes for a brand-new team: Tasks only. */
export const NEW_TEAM_FEATURES: Required<FeaturesConfig> = { tasks: true, stories: false, schedules: false };

/**
 * Feature toggles with defaults applied: a missing `features` block (an existing
 * team) or a missing flag is on, so no team loses a kind it was already using.
 */
export function resolveFeatures(config: Pick<TeamConfig, "features">): Required<FeaturesConfig> {
  const f = config.features ?? {};
  return {
    stories: f.stories !== false,
    tasks: f.tasks !== false,
    schedules: f.schedules !== false,
  };
}

/**
 * The config a brand-new team starts with: `DEFAULT_CONFIG` plus explicit
 * `NEW_TEAM_FEATURES`. Kept separate from `DEFAULT_CONFIG` because that one is
 * merged *under* existing configs, where a `features` block would switch kinds
 * off for teams already using them.
 */
export function newTeamConfig(): TeamConfig {
  return { ...structuredClone(DEFAULT_CONFIG), features: { ...NEW_TEAM_FEATURES } };
}

export interface TriageConfig {
  /** Default true. */
  enabled?: boolean;
  /** How often the sweep runs (default 60). */
  intervalMinutes?: number;
  /** Leave a note alone for this long after its last edit (default 10). */
  quietMinutes?: number;
  /**
   * The persona id note triage runs with (docs/DESIGN.md "Personas"); unset means
   * `builtin:triage`. Not a fallback for triage-mode Work Sources.
   */
  persona?: string;
}

/** Triage settings with defaults applied. */
export function resolveTriage(config: Pick<TeamConfig, "triage">): Required<Omit<TriageConfig, "persona">> {
  const t = config.triage ?? {};
  return {
    enabled: t.enabled !== false,
    intervalMinutes: t.intervalMinutes && t.intervalMinutes > 0 ? t.intervalMinutes : 60,
    quietMinutes: t.quietMinutes !== undefined && t.quietMinutes >= 0 ? t.quietMinutes : 10,
  };
}

/**
 * Retry policy for errored agent sessions. Each retry is a fresh WorkItem
 * (attempt n+1), held back until its backoff passes and the team is ready.
 */
export interface RetryConfig {
  /** Retries after the first errored attempt (default 3; 0 disables retrying). */
  maxRetries?: number;
  /**
   * Wait before each retry, in minutes (default [1, 5, 15]). Retry n waits
   * `backoffMinutes[n-1]`; past the end of the list, the last value repeats.
   */
  backoffMinutes?: number[];
}

/** Default backoff between errored-session retries (minutes). */
export const DEFAULT_RETRY_BACKOFF_MINUTES = [1, 5, 15];

/** Retry settings with defaults applied. */
export function resolveRetry(config: Pick<TeamConfig, "retry">): Required<RetryConfig> {
  const r = config.retry ?? {};
  const backoff = Array.isArray(r.backoffMinutes) && r.backoffMinutes.length > 0 &&
      r.backoffMinutes.every((m) => typeof m === "number" && m >= 0)
    ? r.backoffMinutes
    : DEFAULT_RETRY_BACKOFF_MINUTES;
  return {
    maxRetries: typeof r.maxRetries === "number" && Number.isInteger(r.maxRetries) && r.maxRetries >= 0 ? r.maxRetries : 3,
    backoffMinutes: backoff,
  };
}

/** Backoff before retry number `retry` (1-based), in milliseconds. */
export function retryBackoffMs(policy: Required<RetryConfig>, retry: number): number {
  const list = policy.backoffMinutes;
  const minutes = list[Math.min(Math.max(retry, 1), list.length) - 1]!;
  return minutes * 60_000;
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
   *   is the in-flight unit; may name a `persona`).
   * - `manual`: worked by a human/leader; moving the card onward is the
   *   completion. No WorkItem, no persona.
   */
  type: "agent" | "manual";
  /**
   * The persona id an agent state's worker runs with (docs/DESIGN.md
   * "Personas"). Unset: no persona block, just the one-line state framing.
   * Ignored (with a load warning) on a manual state.
   */
  persona?: string;
}

/** Implicit bucket states present in every workflow (never in config). */
export const TODO_STATE = "todo";
export const DONE_STATE = "done";

/**
 * The unit of agent execution: a single, dumb, terminal-only attempt to do some
 * work (see docs/DESIGN.md "The WorkItem"). A WorkItem points at its
 * work via `ref` — the id of the WorkDef it runs (board, Solitary, or Scheduled
 * alike) — and only ever moves toward a terminal state. All rich detail (goal, comments, results)
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

/** The work a WorkItem represents. Every unit of work is a WorkDef, so the ref is
 * simply its id (see docs/DESIGN.md "WorkDefs & Parents"). */
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
  /**
   * 1 for a first run; n for the (n-1)th automatic retry after an errored
   * agent session (see `RetryConfig`).
   */
  attempt: number;
  /** A READY retry is not handed out before this time (its backoff). */
  retryAt?: string;
  /** Why this attempt's agent session errored (the model call's error message). */
  error?: string;
  /**
   * The persona this run was given, snapshotted at claim (docs/DESIGN.md "The
   * in-flight persona"). Never rewritten: a later edit or delete of the persona
   * leaves it as it was. Absent when the run had no persona.
   */
  persona?: PersonaRef;
}

/**
 * Every unit of work is a WorkDef: purely *authored* content (see
 * docs/DESIGN.md "WorkDefs & Parents"). A WorkDef names its `parent` (the enqueuer that
 * decides when it emits WorkItems); its "type" is derived from the parent kind:
 *   - parent { kind: "story" }    → a board task (workflow-driven)
 *   - parent { kind: "schedule" } → scheduled (cron-driven)
 *   - parent { kind: "thought" }  → triage (a note's analysis thread)
 *   - parent { kind: "external", source } → a read-only mirror of an external
 *     source's item, written only by its sync (the one exception to authored-only)
 *   - no parent                    → Solitary (manual)
 * No mutable/runtime state lives on a WorkDef: workflow status lives on the
 * Story, cron/lastEnqueuedAt on the Schedule. The daemon never rewrites a
 * WorkDef file except on an explicit human/agent edit.
 */
export type WorkDefParentKind = "story" | "schedule" | "thought" | "external";

export interface WorkDefParent {
  kind: WorkDefParentKind;
  /** The parent's id; for `external`, the item's id in the external system. */
  id: string;
  /**
   * `external` only: the id of the Work Source that mirrors it (e.g. "jira").
   * See docs/DESIGN.md "Work Sources" — external sources.
   */
  source?: string;
}

/** Derived label for a WorkDef, from its parent kind. */
export type WorkDefType = "Solitary" | "Scheduled" | "Board" | "Triage" | "External";

/** Derive the display type from a WorkDef's parent. */
export function workDefType(parent?: WorkDefParent): WorkDefType {
  if (!parent) return "Solitary";
  if (parent.kind === "schedule") return "Scheduled";
  if (parent.kind === "thought") return "Triage";
  if (parent.kind === "external") return "External";
  return "Board";
}

/**
 * Is this a mirrored WorkDef — a read-only local copy of an item an external
 * (pull-only) Work Source supplies? MPT never authors these; only the source's
 * sync writes them (docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins").
 */
export function isMirroredWorkDef(def: { parent?: WorkDefParent }): boolean {
  return def.parent?.kind === "external";
}

/** `config.dev.fixtureSource`: the markdown-folder fixture source (daemon/sources/fixture.ts). */
/**
 * One `TeamConfig.packages` entry: a package spec string, or the object form
 * carrying per-plugin settings. Spec forms (like pi's packages; parsed by
 * daemon/plugins/spec.ts):
 *
 * - npm: `npm:<name>[@version]` (e.g. `npm:@acme/mpt-jira@1.2.0`)
 * - git: `git:<host>/<path>[@ref]`, `https://<host>/<path>[@ref]`, `ssh://<user>@<host>/<path>[@ref]`
 * - local path: absolute, `./`, `../`, or `~/`; relative paths resolve against the team dir
 */
export type PackageEntry = string | PackageEntryObject;

/** The object form of a `packages` entry. */
export interface PackageEntryObject {
  /** The package spec (any form above). */
  source: string;
  /**
   * Settings handed to every Work Source this package provides, as
   * `SourceContext.options()`. Secrets are never inline: reference an env var
   * by name (`tokenEnv: "JIRA_TOKEN"`) and let the source read `process.env`.
   */
  config?: Record<string, unknown>;
}

export interface FixtureSourceConfig {
  /** Folder of `*.md` files, one per def (absolute, or relative to the team dir). */
  dir: string;
  /** Source id (default "fixture"). */
  id?: string;
  /** Display name, for "Open in <label>" (default "Fixture"). */
  label?: string;
  /** Sync interval in seconds (default 60). */
  intervalSeconds?: number;
  /** "triage" puts the whole source in triage mode (docs/DESIGN.md "External sources"); default "work". */
  mode?: "work" | "triage";
  /** The source's declared work persona (`WorkSource.defaultPersona`; docs/DESIGN.md "Work Source personas"). */
  defaultPersona?: string;
  /** The source's declared triage persona (`WorkSource.triagePersona`) — a triage-mode source needs one (or a per-source setting). */
  triagePersona?: string;
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
  /** Optional working directory (affinity bias; agents cd here). */
  directory?: string;
  /**
   * Solitary / Scheduled (and a mirror's source suggestion) only: the persona id
   * this work runs with (docs/DESIGN.md "Personas"). Unset = no persona block.
   * Board tasks take theirs from the workflow state, so it is refused there.
   */
  persona?: string;
  /** Lifecycle status: active (default) or archived. */
  status?: "active" | "archived";
  /**
   * Pending: still being written (docs/DESIGN.md "Pending: Write, Review, Activate").
   * While true the definition is editable and the daemon never creates a WorkItem
   * for it — not on Run, not on cron, not on board admission. Activating clears it
   * (one-way), which locks the definition and lets its parent enqueue it. Absent =
   * active, so every WorkDef written before pending existed is active.
   */
  pending?: boolean;
  /**
   * Where this WorkDef came from, when it wasn't authored directly: the note and
   * proposal whose acceptance created it (docs/DESIGN.md "Auto Triage"). Structural
   * metadata, so it belongs in frontmatter; it makes the link note → work
   * navigable in both directions.
   */
  origin?: WorkDefOrigin;
  /**
   * Mirrored defs only: the link back to the item in the external system
   * (the "Open in <source>" link). Mirrored content, written by sync.
   */
  url?: string;
}

/**
 * The triage proposal a WorkDef was created from. Exactly one of `thought` /
 * `workDef` names the triage subject: a note, or a triage-mode mirrored WorkDef
 * (docs/DESIGN.md "External sources" — "Triage mode").
 */
export interface WorkDefOrigin {
  /** The note (`thoughts/<id>.md`), for a note's triage. */
  thought?: string;
  /** The triage-mode mirrored WorkDef, for an external item's triage. */
  workDef?: string;
  /** The proposal's id within its analysis. */
  proposal: string;
}

/**
 * A Task Template: a reusable *mold* for a Solitary WorkDef. It carries the same
 * authored fields as a WorkDef (title / goal / acceptance criteria / additional
 * context / directory) but has **no parent and no runtime state**
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
   * Set when a due occurrence was held back because the team was not ready (its
   * readiness probe failed — e.g. expired credentials) while agents were online.
   * The scheduler fires the held occurrence once when the team is ready
   * again — collapsing any missed occurrences into a single catch-up run so
   * the queue never accumulates a per-occurrence backlog. See
   * docs/ARCHITECTURE.md "Scheduler readiness gating".
   */
  heldForReadiness?: boolean;
  /**
   * When true the Schedule is **pending**: the scheduler never fires it (cron
   * matches are skipped) and never holds it for readiness. Reversible
   * (active ⇄ pending), like a story — unlike a WorkDef's one-way `pending`.
   * A child WorkDef fires only when *both* its Schedule and the WorkDef itself
   * are active. See docs/DESIGN.md "Pending schedules: reversible, no catch-up".
   */
  pending?: boolean;
  /**
   * ISO timestamp of the last pending → active transition. Together with
   * `lastEnqueuedAt` it is the scheduler's cursor: only a cron minute strictly
   * after the minute of both can fire, so reactivating resumes at the *next*
   * occurrence (never the activation minute itself) and never back-fires the
   * ones skipped while pending.
   */
  resumedAt?: string;
}

/**
 * Do two directories overlap — the same path, or one inside the other? Compares
 * whole path segments, not string prefixes, so `/ws/foo` and `/ws/foobar` do
 * **not** overlap while `/ws/mpt-dev` and `/ws/mpt-dev/my-pizza-team` do. Pass
 * already-normalized paths (`normalizeDirectory`). Used by the exclusive
 * directory lease (docs/DESIGN.md "Work Matching: Directory Affinity").
 */
export function directoriesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const within = (inner: string, outer: string) =>
    outer === "/" ? inner.startsWith("/") : inner.startsWith(outer + "/");
  return within(a, b) || within(b, a);
}

/**
 * Is the exclusive-directory lease on? Default true: only an explicit
 * `exclusiveDirectories: false` turns it off (see TeamConfig).
 */
export function exclusiveDirectoriesEnabled(config: Pick<TeamConfig, "exclusiveDirectories">): boolean {
  return config.exclusiveDirectories !== false;
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
  /**
   * When true the story is **pending**: none of its tasks are admitted or handed
   * out (an in-flight task finishes; nothing new starts), and stories that
   * `dependsOn` it wait. Reversible (active ⇄ pending). See
   * docs/DESIGN.md "Pending: Write, Review, Activate".
   */
  pending?: boolean;
  workflow?: string;
  /**
   * The story's child WorkDefs, in order, each with its workflow position. This
   * is the single source of truth for both ordering and status (no parallel
   * taskOrder/taskStatus that could drift). `loadFromDisk` reconciles it against
   * the WorkDefs actually on disk (appends orphans, ignores danglers).
   */
  tasks: StoryTaskRef[];
  /**
   * Set (ISO time) when the story is archived — the archived flag. An archived
   * story stays in `stories/<id>.json` (with an inline `synopsis`) but never
   * loads into the active board.
   */
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
  /**
   * Auto triage only: what this analysis concluded, and the work it proposes
   * (docs/DESIGN.md "Auto Triage"). Absent on every ordinary comment.
   */
  outcome?: TriageOutcome;
  proposals?: TriageProposal[];
  /**
   * Set on a comment that came **from** an external source — pulled into a
   * mirrored WorkDef's thread by sync (docs/DESIGN.md "External sources" —
   * "A mirrored thread"). Such a comment is never written back (`onComment`
   * doesn't fire for it). Absent on every comment written in MPT.
   */
  external?: CommentExternal;
}

/** Where an inbound external comment came from (`Comment.external`). */
export interface CommentExternal {
  /** The Work Source's id ("sim-t", "taskei"). */
  source: string;
  /** The source's own id for the comment (the dedupe key). */
  id: string;
  /** The source's thread or kind, when it has several ("Correspondence", "Worklog"). */
  channel?: string;
  /** Who wrote it, in the source's terms (also the comment's `from`). */
  author: string;
}

// ─── Auto triage: analyses, proposals, decisions ──────────────────────
//
// An analysis is a Comment in the note's triage thread carrying `outcome` and any
// `proposals`; the author's accept/reject is a TriageDecision **appended to the
// same `comments.jsonl`**. So one append-only file holds the conversation *and*
// its history, and current state is a fold over it (daemon/triage.ts).

/** What one analysis concluded. */
export type TriageOutcome =
  /** There's work worth doing; `proposals` says what. */
  | "proposals"
  /** A reference note, a journal entry, already-done work: nothing to create. */
  | "nothing"
  /** The teammate needs something from the author first (asked in the body). */
  | "question";

export type TriageProposalKind = "task" | "story-task" | "story" | "schedule";

/**
 * One piece of proposed work, structured so that accepting it creates the real
 * thing without parsing prose.
 */
export interface TriageProposal {
  /** Unique within its analysis (the teammate names it, e.g. "p1"). */
  id: string;
  kind: TriageProposalKind;
  title: string;
  /** What to achieve. Required except for `story`, where the tasks carry it. */
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  directory?: string;
  /** `story-task`: the existing story to add it to. */
  storyId?: string;
  /** `schedule`: a 5-field cron. */
  cron?: string;
  /** `story`: the tasks to create with the new story (at least one). */
  tasks?: Array<{ title: string; goal: string; acceptanceCriteria?: string }>;
  /** `story`: the new story's description. */
  description?: string;
}

export type TriageDecisionAction = "accepted" | "rejected";

/**
 * The author's answer to one proposal — a line in the triage thread, not a
 * comment and not a turn (only editing the note is a turn).
 */
export interface TriageDecision {
  kind: "decision";
  proposalId: string;
  action: TriageDecisionAction;
  /** What accepting created (a WorkDef, or a story for `kind: "story"`). */
  workDefId?: string;
  storyId?: string;
  from: string;
  at: string;
}

/** One line of a triage thread: an analysis/comment, or a decision. */
export type ThreadEntry = Comment | TriageDecision;

/** Is this thread line a decision rather than a comment? */
export function isTriageDecision(entry: ThreadEntry): entry is TriageDecision {
  return (entry as TriageDecision).kind === "decision";
}

/** A proposal plus what the author did about it (undecided = still pending). */
export interface TriageProposalState {
  proposal: TriageProposal;
  /** Which analysis it came from. */
  at: string;
  from: string;
  decision?: TriageDecision;
}

/**
 * What the note's badge shows — the latest analysis's outcome, not a count
 * (docs/DESIGN.md "Auto Triage"). `none` = nothing to show: never triaged, or
 * every proposal has been dealt with.
 */
export type TriageBadge = "none" | "proposal" | "nothing" | "question";

/** Why a note isn't due for triage, or null when it is (daemon/triage.ts `triageSkipReason`). */
export type TriageSkipReason =
  | "archived"
  | "empty"
  | "in-flight"
  | "unchanged"
  | "too-fresh";

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
 * A live agent's harness session, as the Team tab shows it: the model it's
 * running, how full its context window is, and what the session has cost so far
 * — what Pi's own footer shows. Reported by the harness after every turn (`POST
 * /api/agents/:id/session-stats`); held in memory only, like connection state,
 * and cleared when the agent (re)registers, i.e. starts a fresh session.
 */
export interface MemberSessionStats {
  /** Tokens in the context window, or null when unknown (e.g. just after compaction). */
  contextTokens: number | null;
  /** The model's context window size, or null when the harness doesn't know it. */
  contextWindow: number | null;
  /** contextTokens as a percentage of contextWindow (0–100), or null when unknown. */
  contextPercent: number | null;
  /** The session's cumulative cost in USD (Pi's cache-aware total). */
  costUsd: number;
  /** The model the session is running, or null when none is selected / unknown. */
  model: { id: string; name: string; provider: string } | null;
  /** When it was reported (epoch ms). */
  at: number;
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

/** The tmux session teammates run in, unless config names another. */
export const DEFAULT_TMUX_SESSION = "my-pizza-team";

// ─── Terminal backends ───────────────────────────────────────────────

/**
 * The terminal backends a team can choose (`TeamConfig.terminal`). tmux is the
 * default; herdr (docs/herdr.md, daemon/terminal/herdr.ts) is the alternative
 * (daemon/terminal/index.ts picks one).
 */
export const TERMINAL_KINDS = ["tmux", "herdr"] as const;

/** One of `TERMINAL_KINDS`. */
export type TerminalKind = typeof TERMINAL_KINDS[number];

/** The terminal a team gets when config doesn't say. */
export const DEFAULT_TERMINAL: TerminalKind = "tmux";

/** Is `value` a terminal backend mpt knows? */
export function isTerminalKind(value: unknown): value is TerminalKind {
  return typeof value === "string" && (TERMINAL_KINDS as readonly string[]).includes(value);
}

/**
 * The terminal backend new windows open in: `config.terminal`, else the default.
 * An unknown value (a hand-edited config.json) resolves to the default here; the
 * spawner's capability check (daemon/spawner.ts `terminalChoiceCapability`) is what
 * reports it, so a typo refuses spawns with a reason instead of crashing a reader.
 */
export function resolveTerminal(config: Partial<Pick<TeamConfig, "terminal">> | undefined): TerminalKind {
  const terminal = config?.terminal;
  return isTerminalKind(terminal) ? terminal : DEFAULT_TERMINAL;
}

// TERMINAL_METADATA_KEYS / terminalMetadata (how an agent reports its window) live
// in shared/agent-protocol.ts, since a harness needs them too; re-exported here.
export { TERMINAL_METADATA_KEYS, terminalMetadata } from "./agent-protocol.ts";

export const DEFAULT_CONFIG: TeamConfig = {
  port: 7437,
  tmuxSession: DEFAULT_TMUX_SESSION,
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
  // Auto-triage is on by default; every non-archived, non-empty note is eligible
  // (TODO.md "Auto Triage" Decisions 1–2).
  triage: { enabled: true, intervalMinutes: 60, quietMinutes: 10 },
  // `features` is deliberately absent: this is merged under existing configs,
  // and absent means "everything on" (resolveFeatures). New teams get theirs
  // from newTeamConfig().
};

// ─── Shared constants ────────────────────────────────────────────────
//
// Canonical home for the handful of values both the daemon and a harness need.
// harnesses/pi/src/shared/types.ts is *generated* from these by
// `npm run sync-shared`, so there is one definition rather than two that drift
// (docs/DESIGN.md "One Protocol, One Version", P1c-7).

/** Team directory name. */
export const TEAM_DIR = ".my-pizza-team";
/**
 * Team directory name before the rename. Never used as a team directory any more:
 * finding only this one (and no `TEAM_DIR`) is reported as a pre-0.36.0 layout
 * (daemon/layout-check.ts; docs/DESIGN.md "Upgrading from before 0.36.0").
 */
export const LEGACY_TEAM_DIR = ".pi-pizza-team";
/**
 * The oldest version a team can upgrade from. A team last run on an older one is
 * refused at startup (daemon/layout-check.ts) instead of being migrated: it has
 * to be started once on 0.36.x first, which migrates it.
 */
export const MIN_UPGRADE_FROM_VERSION = "0.36.0";
/** What to do about a pre-0.36.0 team: the one message the daemon, `mpt doctor` and the extension print. */
export const PRE_CUTOFF_UPGRADE_MESSAGE =
  "This team was last run on a version older than 0.36.0. Install my-pizza-team 0.36.x " +
  "(`npm i -g my-pizza-team@0.36`), start it once to migrate, then upgrade again.";
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
 * `-a` (--approve) matters on both: without it Pi blocks on its "Trust project
 * folder?" prompt in a folder outside a trusted parent, and the permissive config
 * written into the cwd is only applied once the project is trusted anyway. A
 * teammate never has a human attached to answer it; nor does a leader started from
 * the web UI (`POST /api/assistant/start`), which opens its window with nobody
 * watching. A config overriding `harnesses.pi.leader` needs `-a` too to be
 * startable from the UI.
 *
 * Both pass their terminal location (`{terminal}`, `{terminalSession}`,
 * `{terminalWindow}`) so the agent reports it at registration
 * (`TERMINAL_METADATA_KEYS`), which is how the daemon addresses the right window
 * later (dismiss, focus) — in the backend it was started under, even after the
 * team's `terminal` setting changes. `{terminalHandle}` is not passed: tmux has none
 * to give before the command runs, and labels are what windows are found by.
 */
export const DEFAULT_HARNESS_TEMPLATES: Record<string, HarnessTemplates> = {
  pi: {
    teammate:
      "pi -a --ppt-worker --ppt-daemon={url} --ppt-name={name} --ppt-terminal={terminal} --ppt-terminal-session={terminalSession} --ppt-terminal-window={terminalWindow}",
    leader: "pi -a --ppt-lead --ppt-daemon={url} --ppt-terminal={terminal} --ppt-terminal-session={terminalSession} --ppt-terminal-window={terminalWindow}",
  },
  // Experimental (behind `experimental.harnesses`): ACP agents supervised by
  // `mpt agent` (agent/supervisor.ts). Teammates only — they can't lead yet.
  kiro: {
    teammate: "{mpt} agent --harness kiro --daemon={url} --name={name} --terminal={terminal} --terminal-session={terminalSession} --terminal-window={terminalWindow}",
  },
  claude: {
    teammate: "{mpt} agent --harness claude --daemon={url} --name={name} --terminal={terminal} --terminal-session={terminalSession} --terminal-window={terminalWindow}",
  },
};

/** Is `harness` one of the experimental ones (anything but Pi)? */
export function isExperimentalHarness(harness: string | undefined): boolean {
  return !!harness && harness !== DEFAULT_HARNESS;
}

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
export const WORKFLOWS_DIR = "workflows";
/** Directory holding every WorkDef (`tasks/<id>/workdef.md` + comments + attachments). */
export const WORKDEFS_DIR = "tasks";
/** Directory holding cron Schedule files (`schedules/<id>.json`). */
export const SCHEDULES_DIR = "schedules";
/** Directory holding Task Templates (`templates/<id>/template.md`; molds for Solitary tasks). */
export const TEMPLATES_DIR = "templates";
/** Directory holding the team's persona library (`personas/<id>.md`; docs/DESIGN.md "Personas"). */
export const PERSONAS_DIR = "personas";

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
  /**
   * The note version (`updatedAt`) last handed to auto-triage — stamped when a
   * triage WorkItem is *enqueued*, not when the analysis comes back. The note is
   * eligible again once `updatedAt` moves past it, so an edit made mid-run isn't
   * swallowed, and a failed run doesn't re-cost every sweep (TODO.md "Auto
   * Triage"). Absent = never triaged.
   */
  triagedVersion?: string;
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

// ─── Personas (docs/DESIGN.md "Personas: One Library, Selected by Reference") ───

/** A picker hint (never a restriction): which pickers list a persona first. */
export type PersonaKind = "assistant" | "worker" | "triage";

/** Every persona kind hint, in display order. */
export const PERSONA_KINDS: readonly PersonaKind[] = ["worker", "triage", "assistant"];

/**
 * Where a persona comes from, which its id encodes: a team slug, `builtin:<name>`,
 * or `<package.json name>/<id>` (docs/DESIGN.md "Ids and origins").
 */
export type PersonaOrigin =
  | { kind: "team" }
  | { kind: "builtin" }
  | { kind: "package"; name: string; identity: string };

/** How a consumer arrived at the persona it uses (recorded on the WorkItem snapshot). */
export type PersonaVia =
  | "workflow-state" | "task" | "schedule" | "workdef"
  | "source-setting" | "source-default" | "triage" | "assistant";

/** The built-in personas: today's defaults, read-only. */
export type BuiltinPersonaId = "builtin:assistant" | "builtin:triage" | "builtin:worker";

/** The prefix only built-in ids carry (a team id has neither `:` nor `/`). */
export const BUILTIN_PERSONA_PREFIX = "builtin:";

/** The team-id grammar: a slug of at most 64 characters. */
export const TEAM_PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One persona in the library: frontmatter (title, description, tags, optional
 * `kinds` and `duplicatedFrom`) plus the markdown `content` injected into the
 * prompt. `readOnly` is true for built-in and package personas.
 */
export interface Persona {
  id: string;
  title: string;
  description: string;
  tags: string[];
  kinds?: PersonaKind[];
  /** Informational: the persona this one was duplicated from (no inheritance). */
  duplicatedFrom?: string;
  content: string;
  origin: PersonaOrigin;
  readOnly: boolean;
  /** Package personas only: the lint error that marked it (it still loads). */
  lintError?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** What `resolvePersona` hands a prompt builder (daemon/personas/resolve.ts). */
export interface ResolvedPersona {
  id: string;
  title: string;
  origin: PersonaOrigin;
  body: string;
  via: PersonaVia;
  /** Set when the requested id didn't resolve and a built-in stood in. */
  fallbackFrom?: string;
}

/**
 * A recorded reference to the persona a run used: the WorkItem snapshot
 * (`WorkItem.persona`). `origin` is flattened to `team` | `builtin` |
 * `package:<name>` — the `work_items.persona_origin` column's shape.
 */
export interface PersonaRef {
  id: string;
  title: string;
  origin: string;
  via: PersonaVia;
  fallbackFrom?: string;
}

/** One thing that references a persona (`GET /api/personas/:id` `usedBy`). */
export type PersonaUsage =
  | { kind: "workflow-state"; workflow: string; state: string }
  | { kind: "triage" }
  | { kind: "assistant" }
  | { kind: "workdef"; workDefId: string; title: string }
  | { kind: "mirror-override"; workDefId: string; source: string }
  | { kind: "source-setting"; source: string; field: "persona" | "triagePersona" };

/** `PersonaOrigin` flattened to the snapshot's string form (`PersonaRef.origin`). */
export function personaOriginLabel(origin: PersonaOrigin): string {
  return origin.kind === "package" ? `package:${origin.name}` : origin.kind;
}

/**
 * Classify a persona id by its grammar alone: `builtin:<name>`, a package id
 * `<package>/<id>` (split on the **last** `/`, so scoped npm names work), a team
 * slug, or invalid.
 */
export function parsePersonaId(id: string):
  | { kind: "builtin"; name: string }
  | { kind: "package"; packageName: string; name: string }
  | { kind: "team" }
  | { kind: "invalid" } {
  if (id.startsWith(BUILTIN_PERSONA_PREFIX)) return { kind: "builtin", name: id.slice(BUILTIN_PERSONA_PREFIX.length) };
  const slash = id.lastIndexOf("/");
  if (slash > 0 && slash < id.length - 1) {
    const name = id.slice(slash + 1);
    return TEAM_PERSONA_ID_PATTERN.test(name) ? { kind: "package", packageName: id.slice(0, slash), name } : { kind: "invalid" };
  }
  return TEAM_PERSONA_ID_PATTERN.test(id) ? { kind: "team" } : { kind: "invalid" };
}

/** Slugify text into the team-persona id grammar (lowercase, `-`, ≤ 64 chars). */
export function slugifyPersonaId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

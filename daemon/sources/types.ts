/**
 * daemon/sources/types.ts — The Work Source plugin interface.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins".
 *
 * A Work Source is what supplies (and enqueues) one kind of WorkDef: a Story's
 * board, a Schedule's cron, a note's triage, a Solitary task — and, eventually,
 * an external system (Jira, Asana, Taskei). The daemon still owns the queue,
 * leases, retries, readiness, and directory matching; a source only decides
 * *when* its WorkDefs want a WorkItem and contributes to how that item looks.
 *
 * This file is core-facing and plugin-agnostic: it imports nothing from the
 * Store, so a source can be written (and tested) against `SourceContext` alone.
 * Third-party packages are declared in the team's `packages`
 * (daemon/plugins/spec.ts); a plugin source's settings reach it as `ctx.options()`.
 * Plugin authors import these types from `my-pizza-team/plugin` (plugin/index.ts),
 * so a type exported there is public API.
 */

import type { Comment, TeamConfig, WorkDef, WorkItem } from "../../shared/types.ts";

/** The interface version a source was written against. Bumped on breaking change. */
export const WORK_SOURCE_API_VERSION = 1;

/**
 * How an external source's items are handled (docs/DESIGN.md "External sources"
 * — "Triage mode"):
 *   - `"work"` (the default): a teammate works the mirrored item itself;
 *   - `"triage"`: a teammate *triages* it — the same flow as a note's Auto
 *     Triage — posting an analysis and proposals (`propose_work`) the author
 *     accepts or rejects. Accepting creates real work; nothing runs the
 *     external item itself.
 * Set per source (`WorkSource.mode`) and/or per item (`ExternalDef.mode`, which
 * wins). Added in apiVersion 1 as an optional field, so it isn't a breaking change.
 */
export type WorkSourceMode = "work" | "triage";

/**
 * A WorkDef as an external (pull-only) source reports it from `sync` (or hands
 * to `ctx.upsertDef`). The daemon keeps a read-only local copy — a **mirrored
 * WorkDef** with id `mirroredWorkDefId(sourceId, externalId)` (daemon/sources/mirror.ts)
 * — so prompts, the thread, and the UI work offline. The `revision` is the
 * source's own change marker (an updated-at, an etag; opaque, compared for
 * equality only): the mirror is rewritten, and a WorkItem created, only when it moves.
 */
export interface ExternalDef {
  /** The source's own id for the item (stable across syncs). */
  externalId: string;
  /** Opaque change marker; an unchanged revision is a no-op on re-sync. */
  revision: string;
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  directory?: string;
  /** Link back to the item in the external system, for the UI. */
  url?: string;
  /**
   * This item's mode, overriding the source's `WorkSource.mode` (default
   * "work"). A `"triage"` item gets a triage run per revision instead of a
   * work run: its prompt is the team's `triage.md` plus this item's content,
   * and the teammate answers with proposals.
   */
  mode?: WorkSourceMode;
}

/** What one sync pass did (`Store.syncWorkSource`), for logs and tests. */
export interface SyncOutcome {
  ok: boolean;
  /** Why it failed (a throw, a timeout, a bad result), when `ok` is false. */
  error?: string;
  /**
   * Skipped without calling `sync` (or its result dropped): already running,
   * backing off after failures, or the source's feature toggle is off.
   */
  skipped?: "in-flight" | "backoff" | "disabled";
  /** Mirrored defs written (new, or a moved revision). */
  mirrored: string[];
  /** WorkItems created (one per new revision). */
  enqueued: string[];
  /** Mirrored defs archived because the source no longer reports them. */
  archived: string[];
  /** New revisions not enqueued because the daemon isn't ready (retried next sync). */
  held: string[];
}

/**
 * A source's own persisted key/value store (strings only), one per source,
 * kept in `sources/<sourceId>.json` (daemon/store/source-kv.ts). Runtime state
 * a source needs across restarts — cursors, revision stamps — lives here, never
 * in the authored `workdef.md`.
 */
export interface SourceKv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/**
 * Where `enqueueRevision` reads and writes "the revision last handed over" for
 * a WorkDef. The default is the source's own `kv`; a source whose stamp already
 * lives elsewhere (Thought: the note's `triagedVersion` frontmatter) passes its own.
 */
export interface RevisionCursor {
  get(defId: string): string | undefined;
  set(defId: string, revision: string): void;
}

/** Options for `SourceContext.enqueueRevision`. */
export interface EnqueueRevisionOptions {
  /**
   * Enqueue even if `revision` was already handed over (a manual re-run, e.g.
   * **Triage now**). An in-flight item still refuses: one run at a time.
   */
  force?: boolean;
  /** Where the stamp lives. Default: this source's `kv` (key `revision:<defId>`). */
  cursor?: RevisionCursor;
}

/** The outcome of a manual **Run** of a WorkDef (`WorkSource.run`). */
export type RunResult =
  | { ok: true; workItem: WorkItem }
  /** `conflict`: refused because of the def's state (pending, in flight) rather than a bad request. */
  | { ok: false; error: string; conflict?: boolean };

/**
 * What a source may report back from `onItemTerminal`, returned to the agent
 * that set the state (`POST /api/agents/work-items/:id/state`). Story: the
 * task's new board position, and whether that finished it (`done`).
 */
export interface ItemTerminalOutcome {
  newStatus?: string;
  completed?: boolean;
}

/**
 * The daemon-side capabilities handed to a source. Everything a source does to
 * the queue goes through here, so the core invariants hold by construction:
 * `enqueue` is the single `enqueueFor` (pending defs never enqueue), and
 * readiness is the daemon's, not the source's.
 */
export interface SourceContext {
  /** This source's id. */
  readonly sourceId: string;
  /** The team directory (built-in sources keep their own files under it). */
  readonly teamDir: string;
  /** The team's live config. */
  config(): TeamConfig;
  /**
   * This source's own settings. A plugin source gets its package entry's
   * `config` (`packages: [{ source, config: { ... } }]` in the team's
   * config.json; daemon/plugins/spec.ts); built-ins and in-code sources get `{}`
   * unless registered with `options` (`Store.registerWorkSource`). Read-only
   * (frozen), and fixed for the daemon's lifetime: a change needs a restart.
   *
   * **Secrets are never inline.** Reference an environment variable by name —
   * `{ "tokenEnv": "JIRA_TOKEN" }` — and read `process.env[options.tokenEnv]`,
   * so config.json stays safe to share and commit.
   */
  options(): Readonly<Record<string, unknown>>;
  /** Prefixed logging, so a source's output is attributable. */
  log(message: string): void;
  /** Every WorkDef (all statuses); a source filters to its own. */
  listWorkDefs(): WorkDef[];
  /** Is there already a READY/IN_PROGRESS/MORIBUND item for this WorkDef? */
  hasActiveItem(defId: string): boolean;
  /**
   * Enqueue a READY WorkItem for a WorkDef via the daemon's single creator
   * (`enqueueFor`). Returns null when it refuses (missing or pending def).
   */
  enqueue(defId: string): WorkItem | null;
  /**
   * Enqueue once per revision of the source content (the core dedupe; see
   * daemon/sources/revision.ts). Refuses (null) when an item is already in
   * flight, or — unless `force` — when `revision` is the one last handed over.
   * On success the revision is stamped **at enqueue**, so a change made during
   * the run is due again afterwards, and a failed run doesn't retry on its own.
   */
  enqueueRevision(defId: string, revision: string, opts?: EnqueueRevisionOptions): WorkItem | null;
  /**
   * External sources: write (or refresh) the read-only mirror of one external
   * item and return it. A no-op when its `revision` is the one already mirrored.
   * Mirroring alone never enqueues; the daemon's sync loop does that, once per
   * revision. Returns null for an invalid def (missing `externalId`/`revision`/`title`).
   */
  upsertDef(def: ExternalDef): WorkDef | null;
  /** This source's persisted key/value store (`sources/<sourceId>.json`). */
  kv: SourceKv;
  /** Readiness, as the daemon decides it (docs/DESIGN.md "Readiness Gating"). */
  readiness: {
    /** May timed work be enqueued right now? (no agents online → yes; else the team's report). */
    canEnqueueNow(): boolean;
  };
}

/**
 * What still holds a toggleable source on: its active (non-archived) item
 * count, worded for the user ("3 stories", "2 tasks and 1 template").
 */
export interface ActiveSourceItems {
  count: number;
  description: string;
}

/**
 * How a source is switched on/off (docs/DESIGN.md "Feature Toggles"). A source
 * that declares one gets, from daemon/features.ts, for free: the `features.<feature>`
 * config flag (missing = on), the 403 gate on its routes and on its WorkDefs'
 * `/api/work-defs` routes, hiding its WorkDefs from the list, and the 409
 * "can't switch off while it has active items" guard. A source without one
 * (Thought) is always on.
 */
export interface SourceToggle {
  /**
   * The key under config `features`. The built-ins keep their historical names
   * (story → "stories", task → "tasks", schedule → "schedules") so existing
   * configs read unchanged.
   */
  readonly feature: string;
  /**
   * Extra route patterns (Hono syntax) the gate refuses while off, beyond this
   * source's WorkDefs under `/api/work-defs`. Read once, when the app is built.
   */
  readonly routes?: readonly string[];
  /**
   * The items that block switching it off. Default: this source's non-archived
   * WorkDefs (pending ones included — held work is still work).
   */
  activeItems?(ctx: SourceContext): ActiveSourceItems;
}

/**
 * One WorkDef kind's plugin. Every hook but `id`/`apiVersion` is optional; the
 * daemon's default for a missing hook is the behavior of a Solitary task
 * (eligible while it exists, no title/directory override, the base prompt,
 * nothing on terminal, Run enqueues) — except `onActivate`, whose default is
 * to do nothing.
 */
export interface WorkSource {
  /**
   * Unique id. Built-ins use their `parent.kind` ("story", "schedule", "thought")
   * or "task". An external source's id must match `SOURCE_ID_PATTERN`
   * (lowercase, dashes): it names its kv file and prefixes its mirrored WorkDef ids.
   */
  readonly id: string;
  readonly apiVersion: 1;
  /** Display name ("Jira"), for the UI's tab and "Open in <label>" link. Default: the id. */
  readonly label?: string;
  /**
   * External sources: whether a teammate works this source's items (`"work"`,
   * the default) or triages them into proposed work (`"triage"` — like a
   * note's Auto Triage). An item's own `ExternalDef.mode` overrides it. In
   * triage mode the daemon owns the item's title ("Triage: …"), directory (the
   * mirror's, else the leader's), prompt (the triage prompt), and Run
   * (Triage now); this source's `resolveItem`, `buildPrompt`, and `run` are
   * not called for those items. Its other hooks (eligibility, write-back) are.
   */
  readonly mode?: WorkSourceMode;
  /**
   * On/off switch (feature toggle; docs/DESIGN.md "Feature Toggles"). Absent on
   * an in-daemon source = always on, not switchable. An **external** source
   * (one that declares `sync`) that leaves it absent gets a default toggle from
   * the registry: `{ feature: <id> }`, gating its `/api/work-sources/<id>/defs`
   * and `/sync` routes — so every plugin source can be switched off (and
   * disconnected) from the Config page. `null` opts out explicitly: always on.
   * A feature name must be unique and can't be a built-in's ("stories",
   * "tasks", "schedules"); a clash is refused at registration.
   */
  readonly toggle?: SourceToggle | null;
  /** Called once when registered: read config, set up state. */
  init?(ctx: SourceContext): Promise<void> | void;
  /**
   * The daemon's periodic tick (every 30s from `Store.startTimers`, and on
   * demand in tests). Time-driven sources (Schedule) fire from here. The daemon
   * owns the timer so `stopTimers` stops every source at once.
   */
  tick?(ctx: SourceContext, now: Date): void;
  /**
   * How often the daemon's timer runs this source's `tick`, in ms, read once at
   * `startTimers`. Default 30s; null (or ≤ 0) = no timer (the tick still runs
   * on demand via `Store.tickWorkSources`). Thought uses the triage interval.
   */
  tickEveryMs?(ctx: SourceContext): number | null;
  /**
   * A pending WorkDef was just activated (its flag already cleared): enqueue it
   * now if this kind does so. `enqueue: false` is the caller asking to activate
   * without running. Default: nothing (Scheduled: its next cron firing enqueues).
   */
  onActivate?(def: WorkDef, opts: { enqueue?: boolean }, ctx: SourceContext): WorkItem | null;
  /**
   * The author pressed **Run** (`POST /api/work-defs/:id/enqueue`). Default: the
   * Solitary rule — refuse a pending or in-flight def, else enqueue
   * (daemon/sources/task.ts `runSolitary`).
   */
  run?(def: WorkDef, ctx: SourceContext): RunResult;
  /**
   * Daemon-driven poll, for external (pull-only) sources: every item the source
   * has *now*. The daemon mirrors each (read-only), enqueues one WorkItem per new
   * revision (`ctx.enqueueRevision`; held while readiness says no), and archives
   * — never deletes — the mirrors of items no longer reported. Runs every
   * `syncEveryMs`, bounded by `syncTimeoutMs`; a throw or timeout is logged and
   * backs the source off, and never stalls the daemon or another source
   * (daemon/sources/sync.ts). Declaring `sync` is what makes a source external.
   */
  sync?(ctx: SourceContext): Promise<ExternalDef[]>;
  /** How often to run `sync`, in ms (read once at `startTimers`). Default 60s; null/≤ 0 = on demand only. */
  syncEveryMs?(ctx: SourceContext): number | null;
  /** How long one `sync` may take before it counts as failed, in ms. Default 30s. */
  syncTimeoutMs?: number;
  /**
   * The daemon just loaded its state from disk (startup): bring the queue in
   * line with the source's own state. Story: run admission for every story,
   * then make sure every task in an agent state has an active WorkItem.
   * Default: nothing.
   */
  reconcile?(ctx: SourceContext): void;
  /** May a READY item for this def still be handed out? Default: yes. */
  isEligible?(def: WorkDef, ctx: SourceContext): boolean;
  /** At enqueue: override the item's title/directory. Default: the def's own. */
  resolveItem?(def: WorkDef, ctx: SourceContext): { title?: string; directory?: string };
  /** At claim: the prompt, given the daemon's base prompt. Default: `base`. */
  buildPrompt?(def: WorkDef, base: string, ctx: SourceContext): string;
  /**
   * An item was just leased to a member (→ IN_PROGRESS). Synchronous and runs
   * inside the claim transaction. Story: records the board's assignment row.
   */
  onItemClaimed?(def: WorkDef, item: WorkItem, memberId: string, ctx: SourceContext): void;
  /**
   * After an item reaches COMPLETE/FAILED/CANCELED (e.g. a Story advances its
   * task on COMPLETE; an external source writes the outcome back). Called for
   * the agent's state change, a human cancel, a forced fail, and a board move
   * withdrawing an item. A synchronous return of an `ItemTerminalOutcome` is
   * handed back to the agent (state change only); an async hook is
   * fire-and-forget, its rejection logged.
   */
  onItemTerminal?(def: WorkDef, item: WorkItem, ctx: SourceContext): ItemTerminalOutcome | Promise<void> | void;
  /**
   * A comment was added to one of this source's WorkDef threads — by a human,
   * a teammate (its completion comment), or the daemon (`[retry]`). For
   * write-back. Fire-and-forget: called right after the comment is stored (so
   * a closing comment arrives before the state change after it); an async
   * hook's promise is never awaited, so it never blocks the route or the agent
   * protocol; a throw or rejection is logged. Do slow work asynchronously.
   */
  onComment?(def: WorkDef, comment: Comment, ctx: SourceContext): Promise<void> | void;
}

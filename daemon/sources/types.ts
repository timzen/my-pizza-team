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
 * Third-party package loading is deferred (TODO.md "Work Sources as plugins —
 * package loading (deferred)").
 */

import type { Comment, TeamConfig, WorkDef, WorkItem } from "../../shared/types.ts";

/** The interface version a source was written against. Bumped on breaking change. */
export const WORK_SOURCE_API_VERSION = 1;

/**
 * A WorkDef as an external (pull-only) source reports it from `sync`. The
 * `revision` is the source's own change marker (an updated-at, an etag): the
 * daemon re-mirrors a def only when its revision moves. Mirroring is not wired
 * yet — the type is fixed now so the interface is stable.
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
  /** Readiness, as the daemon decides it (docs/DESIGN.md "Readiness Gating"). */
  readiness: {
    /** May timed work be enqueued right now? (no agents online → yes; else the team's report). */
    canEnqueueNow(): boolean;
  };
}

/**
 * One WorkDef kind's plugin. Every hook but `id`/`apiVersion` is optional; the
 * daemon's default for a missing hook is the behavior of a Solitary task
 * (eligible while it exists, no title/directory override, the base prompt,
 * nothing on terminal).
 */
export interface WorkSource {
  /** Unique id. Built-ins use their `parent.kind` ("story", "schedule", "thought") or "task". */
  readonly id: string;
  readonly apiVersion: 1;
  /** Called once when registered: read config, set up state. */
  init?(ctx: SourceContext): Promise<void> | void;
  /**
   * The daemon's periodic tick (every 30s from `Store.startTimers`, and on
   * demand in tests). Time-driven sources (Schedule) fire from here. The daemon
   * owns the timer so `stopTimers` stops every source at once.
   */
  tick?(ctx: SourceContext, now: Date): void;
  /** Daemon-driven poll, for external sources: the defs the source has now. (Not wired yet.) */
  sync?(ctx: SourceContext): Promise<ExternalDef[]>;
  /** May a READY item for this def still be handed out? Default: yes. */
  isEligible?(def: WorkDef, ctx: SourceContext): boolean;
  /** At enqueue: override the item's title/directory. Default: the def's own. */
  resolveItem?(def: WorkDef, ctx: SourceContext): { title?: string; directory?: string };
  /** At claim: the prompt, given the daemon's base prompt. Default: `base`. */
  buildPrompt?(def: WorkDef, base: string, ctx: SourceContext): string;
  /** After an item reaches COMPLETE/FAILED (e.g. a Story advances its task). */
  onItemTerminal?(def: WorkDef, item: WorkItem, ctx: SourceContext): Promise<void> | void;
  /** A comment was posted on one of this source's items (write-back). (Not wired yet.) */
  onComment?(def: WorkDef, comment: Comment, ctx: SourceContext): Promise<void> | void;
}

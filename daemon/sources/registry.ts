/**
 * daemon/sources/registry.ts — The Work Source registry.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins".
 *
 * One registry per Store. It holds each registered `WorkSource` with the
 * `SourceContext` built for it, and maps a WorkDef to its source by
 * `parent.kind` (no parent → the "task" source). The Store calls through here
 * at its hook points instead of switching on kind; a kind with no registered
 * source (or a hook a source doesn't implement) falls back to the Store's
 * inline default.
 *
 * Plugin-agnostic: no package loading (deferred; TODO.md "Work Sources as
 * plugins — package loading (deferred)").
 */

import type { WorkDef } from "../../shared/types.ts";
import { type SourceContext, WORK_SOURCE_API_VERSION, type WorkSource } from "./types.ts";

/** The source id of a parent-less (Solitary) WorkDef. */
export const TASK_SOURCE_ID = "task";

/** A registered source and the context it was initialized with. */
export interface SourceEntry {
  source: WorkSource;
  ctx: SourceContext;
}

/**
 * Which source owns a WorkDef: its `parent.kind`, or "task" when it has none.
 * A mirrored def (`kind: "external"`) belongs to the source named in `parent.source`.
 */
export function sourceIdForWorkDef(def: Pick<WorkDef, "parent">): string {
  if (def.parent?.kind === "external") return def.parent.source ?? "external";
  return def.parent?.kind ?? TASK_SOURCE_ID;
}

/**
 * A source id that can name files (`sources/<id>.json`) and prefix mirrored
 * WorkDef ids: lowercase letters, digits, and dashes, starting with a letter.
 */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class SourceRegistry {
  private entries = new Map<string, SourceEntry>();

  private makeContext: (sourceId: string) => SourceContext;

  /** @param makeContext builds the daemon-side context for a source id (the Store supplies it). */
  constructor(makeContext: (sourceId: string) => SourceContext) {
    this.makeContext = makeContext;
  }

  /**
   * Register a source and run its `init`. Refuses a duplicate id or an
   * unsupported `apiVersion` (throws), so a misconfigured source fails loudly
   * at startup rather than silently shadowing another. An async `init` is not
   * awaited; its failure is logged through the source's own context.
   */
  register(source: WorkSource): SourceEntry {
    if (source.apiVersion !== WORK_SOURCE_API_VERSION) {
      throw new Error(`Work source "${source.id}" targets apiVersion ${source.apiVersion}; this daemon supports ${WORK_SOURCE_API_VERSION}`);
    }
    if (this.entries.has(source.id)) throw new Error(`Work source "${source.id}" is already registered`);
    // An external source's id names its mirrored WorkDefs' directories, so it must be file-system safe.
    if (source.sync && !SOURCE_ID_PATTERN.test(source.id)) {
      throw new Error(`Work source "${source.id}": an external source's id must match ${SOURCE_ID_PATTERN}`);
    }
    const entry: SourceEntry = { source, ctx: this.makeContext(source.id) };
    this.entries.set(source.id, entry);
    const init = source.init?.(entry.ctx);
    if (init instanceof Promise) init.catch((e) => entry.ctx.log(`init failed: ${e instanceof Error ? e.message : String(e)}`));
    return entry;
  }

  /**
   * Remove a source (no teardown hook: the daemon owns the timers). A test seam
   * for swapping a built-in for a fixture source; false if none was registered.
   */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  /** The source registered under `id`, with its context. */
  get(id: string): SourceEntry | undefined {
    return this.entries.get(id);
  }

  /** The source that owns `def` (by `parent.kind`), or undefined if none is registered. */
  forWorkDef(def: Pick<WorkDef, "parent">): SourceEntry | undefined {
    return this.entries.get(sourceIdForWorkDef(def));
  }

  /** Every registered source, in registration order. */
  all(): SourceEntry[] {
    return [...this.entries.values()];
  }

  /** The external (pull-only) sources: those with a `sync`, in registration order. */
  external(): SourceEntry[] {
    return this.all().filter((e) => typeof e.source.sync === "function");
  }

  /** Run every source's `tick` now. One source throwing doesn't stop the rest. */
  tickAll(now: Date = new Date()): void {
    for (const id of this.entries.keys()) this.tick(id, now);
  }

  /** Run one source's `tick` (its timer calls this). A throw is logged, not propagated. */
  tick(id: string, now: Date = new Date()): void {
    const entry = this.entries.get(id);
    if (!entry?.source.tick) return;
    try {
      entry.source.tick(entry.ctx, now);
    } catch (e) {
      entry.ctx.log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Run every source's `reconcile` (the daemon just loaded from disk), in
   * registration order. One source throwing is logged and doesn't stop the rest.
   */
  reconcileAll(): void {
    for (const { source, ctx } of this.entries.values()) {
      if (!source.reconcile) continue;
      try {
        source.reconcile(ctx);
      } catch (e) {
        ctx.log(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * How often each ticking source wants its timer, in ms (`tickEveryMs`, default
   * `defaultMs`); sources that opt out (null / ≤ 0) are left out.
   */
  tickSchedule(defaultMs: number): Array<{ id: string; everyMs: number }> {
    const out: Array<{ id: string; everyMs: number }> = [];
    for (const { source, ctx } of this.entries.values()) {
      if (!source.tick) continue;
      const everyMs = source.tickEveryMs ? source.tickEveryMs(ctx) : defaultMs;
      if (everyMs !== null && everyMs > 0) out.push({ id: source.id, everyMs });
    }
    return out;
  }
}

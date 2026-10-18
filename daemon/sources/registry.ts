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

/** Which source owns a WorkDef: its `parent.kind`, or "task" when it has none. */
export function sourceIdForWorkDef(def: Pick<WorkDef, "parent">): string {
  return def.parent?.kind ?? TASK_SOURCE_ID;
}

export class SourceRegistry {
  private entries = new Map<string, SourceEntry>();

  /** @param makeContext builds the daemon-side context for a source id (the Store supplies it). */
  constructor(private makeContext: (sourceId: string) => SourceContext) {}

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
    const entry: SourceEntry = { source, ctx: this.makeContext(source.id) };
    this.entries.set(source.id, entry);
    const init = source.init?.(entry.ctx);
    if (init instanceof Promise) init.catch((e) => entry.ctx.log(`init failed: ${e instanceof Error ? e.message : String(e)}`));
    return entry;
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

  /** Run every source's `tick` (the daemon's 30s timer). One source throwing doesn't stop the rest. */
  tickAll(now: Date = new Date()): void {
    for (const { source, ctx } of this.entries.values()) {
      if (!source.tick) continue;
      try {
        source.tick(ctx, now);
      } catch (e) {
        ctx.log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

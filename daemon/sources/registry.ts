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
 * Plugin-agnostic: package loading lives in daemon/plugins/loader.ts, which
 * registers plugin sources here through the same checks as the built-ins.
 */

import type { WorkDef } from "../../shared/types.ts";
import { type SourceContext, type SourceToggle, WORK_SOURCE_API_VERSION, type WorkSource } from "./types.ts";

/** The source id of a parent-less (Solitary) WorkDef. */
export const TASK_SOURCE_ID = "task";

/** A registered source and the context it was initialized with. */
export interface SourceEntry {
  source: WorkSource;
  ctx: SourceContext;
  /**
   * Its effective on/off switch: the source's own `toggle`, or for an external
   * source that declared none, the default (`defaultExternalToggle`); null =
   * always on. Kept on the entry, not the source, because a plugin's object
   * may be frozen and is the plugin's — the daemon never mutates it.
   * daemon/features.ts reads only this.
   */
  toggle: SourceToggle | null;
  /**
   * Why its last `init` failed (at registration, or a re-init after a settings
   * Save — `SourceRegistry.reinit`); absent when it succeeded. The source stays
   * registered either way; `GET /api/sources` shows it as errored.
   */
  initError?: string;
}

/**
 * The built-in features and the source each belongs to. Their names are
 * reserved: no other source may claim them (docs/DESIGN.md "Feature Toggles").
 */
const BUILTIN_FEATURE_OWNERS: Readonly<Record<string, string>> = { stories: "story", tasks: TASK_SOURCE_ID, schedules: "schedule" };

/**
 * The toggle an external source gets when it declares none: its id as the
 * feature name (`features.<id>`), gating its read-only routes. The default
 * `activeItems` (its non-archived mirrors) applies.
 */
export function defaultExternalToggle(sourceId: string): SourceToggle {
  return { feature: sourceId, routes: [`/api/work-sources/${sourceId}/defs`, `/api/work-sources/${sourceId}/sync`] };
}

/** A source's effective toggle: its own; else the default for an external source; `null` opts out. */
export function effectiveToggle(source: WorkSource): SourceToggle | null {
  if (source.toggle !== undefined) return source.toggle;
  return typeof source.sync === "function" ? defaultExternalToggle(source.id) : null;
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

const EMPTY_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({});

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Options for `SourceRegistry.register` / `Store.registerWorkSource`. */
export interface RegisterSourceOptions {
  /** The source's own settings, its `ctx.options()` (a plugin: its package entry's `config`). */
  options?: Record<string, unknown>;
}

export class SourceRegistry {
  private entries = new Map<string, SourceEntry>();

  /**
   * Each source's current settings (its `ctx.options()`), by id. A cell the
   * context reads on every call rather than a value baked into it, so a
   * re-init (`reinit`) swaps the settings for every holder of the ctx — even
   * one a source captured in its first `init`.
   */
  private options = new Map<string, Readonly<Record<string, unknown>>>();
  private makeContext: (sourceId: string, options: () => Readonly<Record<string, unknown>>) => SourceContext;
  private isSwitchedOff: (entry: SourceEntry) => boolean;

  /**
   * @param makeContext builds the daemon-side context for a source id and a
   *   reader of its current settings (what `ctx.options()` returns); the Store
   *   supplies it.
   * @param isSwitchedOff is this source's feature toggle off right now (the
   *   Store reads its live config)? An external source that's off isn't
   *   ticked; the built-ins' ticks run as they always have (their turn-off
   *   guard leaves nothing for them to fire).
   */
  constructor(
    makeContext: (sourceId: string, options: () => Readonly<Record<string, unknown>>) => SourceContext,
    isSwitchedOff: (entry: SourceEntry) => boolean = () => false,
  ) {
    this.makeContext = makeContext;
    this.isSwitchedOff = isSwitchedOff;
  }

  /**
   * Register a source and run its `init`. Refuses a duplicate id or an
   * unsupported `apiVersion` (throws), so a misconfigured source fails loudly
   * at startup rather than silently shadowing another. An async `init` is not
   * awaited; its failure is logged through the source's own context.
   * `opts.options` becomes the source's `ctx.options()` (default `{}`), copied
   * and frozen so the source can't change what the next reader sees.
   */
  register(source: WorkSource, opts: RegisterSourceOptions = {}): SourceEntry {
    if (source.apiVersion !== WORK_SOURCE_API_VERSION) {
      throw new Error(`Work source "${source.id}" targets apiVersion ${source.apiVersion}; this daemon supports ${WORK_SOURCE_API_VERSION}`);
    }
    if (this.entries.has(source.id)) throw new Error(`Work source "${source.id}" is already registered`);
    // An external source's id names its mirrored WorkDefs' directories, so it must be file-system safe.
    if (source.sync && !SOURCE_ID_PATTERN.test(source.id)) {
      throw new Error(`Work source "${source.id}": an external source's id must match ${SOURCE_ID_PATTERN}`);
    }
    const toggle = effectiveToggle(source);
    if (toggle) this.checkFeatureName(source.id, toggle.feature);
    this.options.set(source.id, Object.freeze({ ...(opts.options ?? {}) }));
    const id = source.id;
    const entry: SourceEntry = { source, ctx: this.makeContext(id, () => this.options.get(id) ?? EMPTY_OPTIONS), toggle };
    this.entries.set(source.id, entry);
    const init = source.init?.(entry.ctx);
    if (init instanceof Promise) {
      init.catch((e) => {
        entry.initError = errorMessage(e);
        entry.ctx.log(`init failed: ${entry.initError}`);
      });
    }
    return entry;
  }

  /**
   * Re-initialize a registered source in place with new settings (a Config
   * page Save; docs/DESIGN.md "Plugin settings: configSchema and preview"):
   * swap its frozen `ctx.options()` — the same ctx object, so a source that
   * kept it from its first `init` sees the change — then call `init` again,
   * awaited and bounded by `timeoutMs`. A throw, rejection, or timeout is
   * recorded as the entry's `initError` and returned, never thrown; the new
   * settings stay in place. Not a teardown/re-register: the source object,
   * its timers, and its kv are the same (see `WorkSource.init`).
   */
  async reinit(id: string, options: Record<string, unknown>, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: `No work source "${id}"` };
    this.options.set(id, Object.freeze({ ...options }));
    delete entry.initError;
    if (!entry.source.init) return { ok: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`init timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      });
      // Promise.resolve().then: an init that throws synchronously is a rejection too.
      await Promise.race([Promise.resolve().then(() => entry.source.init!(entry.ctx)), timeout]);
      return { ok: true };
    } catch (e) {
      entry.initError = errorMessage(e);
      entry.ctx.log(`re-init failed: ${entry.initError}`);
      return { ok: false, error: entry.initError };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Refuse a feature name another source already uses, or a built-in's
   * (stories/tasks/schedules) claimed by anything but that built-in: two
   * sources on one `features.<name>` flag would switch each other off. Throws,
   * like a duplicate id — the plugin loader logs it and records the package's error.
   */
  private checkFeatureName(sourceId: string, feature: string): void {
    if (typeof feature !== "string" || !feature) throw new Error(`Work source "${sourceId}": toggle.feature must be a non-empty string`);
    const owner = BUILTIN_FEATURE_OWNERS[feature];
    if (owner !== undefined && owner !== sourceId) {
      throw new Error(`Work source "${sourceId}": feature "${feature}" is reserved for the built-in "${owner}" source (pick another toggle.feature)`);
    }
    const taken = this.all().find((e) => e.toggle?.feature === feature);
    if (taken) throw new Error(`Work source "${sourceId}": feature "${feature}" is already used by source "${taken.source.id}"`);
  }

  /**
   * Remove a source (no teardown hook: the daemon owns the timers). A test seam
   * for swapping a built-in for a fixture source; false if none was registered.
   */
  unregister(id: string): boolean {
    this.options.delete(id);
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

  /**
   * Run one source's `tick` (its timer calls this). A throw is logged, not
   * propagated. Skipped for an external source whose toggle is off.
   */
  tick(id: string, now: Date = new Date()): void {
    const entry = this.entries.get(id);
    if (!entry?.source.tick) return;
    // A switched-off external source is disconnected: no tick, so nothing enqueues.
    if (typeof entry.source.sync === "function" && this.isSwitchedOff(entry)) return;
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

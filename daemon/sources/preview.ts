/**
 * daemon/sources/preview.ts — "What would this source pull with these
 * settings?", without pulling it: the Config page's **Preview**.
 * See docs/DESIGN.md "Plugin settings: configSchema and preview".
 *
 * `previewSource` validates a draft settings block against the source's
 * `configSchema`, then calls the source's `preview` — or, for an external
 * source without one, its `sync` — on a **restricted context**
 * (`previewContext`): same reads as the real one, `options()` answering with
 * the draft, and every write neutralized:
 *   - `upsertDef`, `enqueue`, `enqueueRevision` do nothing and return null,
 *     logged and reported back as a warning (a sync that mirrors through ctx
 *     still previews its returned items);
 *   - `kv.set` / `kv.delete` go to a scratch overlay discarded afterwards, so
 *     a cursor the source moves while previewing isn't moved for real.
 * The call is bounded by the source's `syncTimeoutMs` (default 30s); a throw,
 * a timeout, or a malformed result is an error outcome, never a throw. Invalid
 * items are dropped with a warning, so the person sees what the mirror would
 * refuse. A preview runs whether or not the source is switched on — it's how
 * you check settings before switching it on.
 */

import type { SourceEntry } from "./registry.ts";
import { type ConfigFieldError, checkConfigSchema, validateSourceConfig, withSourceConfigBlock } from "./config-schema.ts";
import { invalidExternalDef } from "./mirror.ts";
import { DEFAULT_SYNC_TIMEOUT_MS } from "./sync.ts";
import type { ExternalDef, SourceContext, SourceKv, SourcePreview } from "./types.ts";
import { withTimeout } from "../plugins/loader.ts";

/** The result of `previewSource`. `via` says which hook produced it. */
export type PreviewOutcome =
  | { ok: true; via: "preview" | "sync"; preview: SourcePreview }
  /** `fieldErrors`: the draft failed the schema (nothing was called). */
  | { ok: false; error: string; fieldErrors?: ConfigFieldError[] };

/**
 * A copy of `base` that can't change anything: `options()` returns `options`
 * (frozen), reads pass through, the queue/mirror writers are no-ops that
 * `warn`, and kv writes land in a throwaway overlay. See the file header.
 */
export function previewContext(
  base: SourceContext,
  options: Readonly<Record<string, unknown>>,
  warn: (message: string) => void,
): SourceContext {
  const frozen = Object.freeze({ ...options });
  const refused = (what: string) => {
    const message = `${what} was ignored: a preview has no side effects`;
    base.log(`[preview] ${message}`);
    warn(message);
    return null;
  };
  // Scratch kv: writes shadow the real store for this preview only; undefined = deleted.
  const overlay = new Map<string, string | undefined>();
  const kv: SourceKv = {
    get: (key) => (overlay.has(key) ? overlay.get(key) : base.kv.get(key)),
    set: (key, value) => void overlay.set(key, value),
    delete: (key) => void overlay.set(key, undefined),
  };
  return Object.freeze({
    sourceId: base.sourceId,
    teamDir: base.teamDir,
    config: () => base.config(),
    options: () => frozen,
    log: (message: string) => base.log(`[preview] ${message}`),
    listWorkDefs: () => base.listWorkDefs(),
    hasActiveItem: (defId: string) => base.hasActiveItem(defId),
    enqueue: () => refused("ctx.enqueue"),
    enqueueRevision: () => refused("ctx.enqueueRevision"),
    upsertDef: () => refused("ctx.upsertDef"),
    kv,
    readiness: { canEnqueueNow: () => base.readiness.canEnqueueNow() },
  });
}

/**
 * Preview `entry`'s source with `draftBlock` as its settings block (the part
 * `configSchema` describes; placed into the current package config per
 * `configScope`). Never rejects. Refuses (no call) when the draft isn't an
 * object, fails the schema, or the source has neither `preview` nor `sync`.
 */
export async function previewSource(entry: SourceEntry, draftBlock: unknown, opts: { timeoutMs?: number } = {}): Promise<PreviewOutcome> {
  const { source, ctx } = entry;
  if (typeof source.preview !== "function" && typeof source.sync !== "function") {
    return { ok: false, error: `source "${source.id}" has nothing to preview (no preview or sync)` };
  }
  if (typeof draftBlock !== "object" || draftBlock === null || Array.isArray(draftBlock)) {
    return { ok: false, error: "the settings must be an object" };
  }
  const draft = draftBlock as Record<string, unknown>;
  if (source.configSchema && checkConfigSchema(source.configSchema).length === 0) {
    const fieldErrors = validateSourceConfig(source.configSchema, draft);
    if (fieldErrors.length) return { ok: false, error: "the settings are invalid", fieldErrors };
  }

  const options = Object.freeze(withSourceConfigBlock(source, ctx.options(), draft));
  const warnings: string[] = [];
  const restricted = previewContext(ctx, options, (m) => warnings.push(m));
  const timeoutMs = opts.timeoutMs ?? (source.syncTimeoutMs && source.syncTimeoutMs > 0 ? source.syncTimeoutMs : DEFAULT_SYNC_TIMEOUT_MS);
  const via = typeof source.preview === "function" ? "preview" : "sync";
  try {
    // Promise.resolve().then: a hook that throws synchronously is a rejection too.
    const result = await withTimeout(
      Promise.resolve().then((): Promise<unknown> => (via === "preview" ? source.preview!(restricted, options) : source.sync!(restricted))),
      timeoutMs,
      via,
    );
    const shaped = shapePreview(result, via);
    if ("error" in shaped) return { ok: false, error: shaped.error };
    const items = keepValidItems(shaped.items, warnings);
    warnings.push(...shaped.warnings);
    return { ok: true, via, preview: { items, ...(warnings.length ? { warnings } : {}), ...(shaped.note ? { note: shaped.note } : {}) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Normalize a hook's result: `sync` returns an array, `preview` a `SourcePreview`. */
function shapePreview(result: unknown, via: "preview" | "sync"): { items: unknown[]; warnings: string[]; note?: string } | { error: string } {
  if (via === "sync") return Array.isArray(result) ? { items: result, warnings: [] } : { error: "sync did not return an array" };
  if (typeof result !== "object" || result === null || !Array.isArray((result as SourcePreview).items)) {
    return { error: "preview did not return { items: [...] }" };
  }
  const r = result as SourcePreview;
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [];
  return { items: r.items, warnings, ...(typeof r.note === "string" && r.note ? { note: r.note } : {}) };
}

/** The items the mirror would accept; each dropped one (invalid, or a repeated externalId) becomes a warning. */
function keepValidItems(items: unknown[], warnings: string[]): ExternalDef[] {
  const out: ExternalDef[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const why = invalidExternalDef(item);
    if (why) {
      warnings.push(`item ${i + 1} would be skipped: ${why}`);
      return;
    }
    const def = item as ExternalDef;
    if (seen.has(def.externalId)) {
      warnings.push(`item ${i + 1} would be skipped: externalId "${def.externalId}" is repeated`);
      return;
    }
    seen.add(def.externalId);
    out.push(def);
  });
  return out;
}

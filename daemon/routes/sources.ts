/**
 * daemon/routes/sources.ts — Manage each Work Source's settings live: the
 * Config page's **Sources** tab. See docs/DESIGN.md "Plugin settings:
 * configSchema and preview" and docs/ARCHITECTURE.md "Plugin packages".
 *
 *   GET  /api/sources              — every registered source: id, label, kind
 *                                    (built-in / plugin / external), package, mode,
 *                                    toggle, configSchema, current settings (secrets
 *                                    redacted; env-var refs by name + whether set),
 *                                    init error, sync health, active mirror count
 *   POST /api/sources/:id/preview  — `{ options }`: validate (400 + fieldErrors),
 *                                    then what a sync with them would report —
 *                                    nothing mirrored, enqueued, or persisted.
 *                                    One at a time per source, with a short cooldown
 *                                    (429 + Retry-After), so mashing Preview can't
 *                                    stampede the external system
 *   PUT  /api/sources/:id/config   — `{ options }`: validate, write the block into
 *                                    config.json `packages[]` entry's `config` (per
 *                                    the source's `configScope`), then re-init every
 *                                    source of that package in place — no restart
 *
 * The same admin surface as `PUT /api/config`: behind the daemon's API token
 * when one is set (daemon/auth.ts), and not feature-gated — a switched-off
 * source can still be configured and previewed before it's switched on.
 *
 * **Where a Save goes.** Always the team's own config.json — the file the
 * daemon read at startup. The daemon reads nothing else: a demo team's
 * `plugins.local.json` overlay (mpt-demo-team) is merged into config.json by
 * that repo's `setup-demo.sh`, so a Save made here lasts until the next demo
 * reset; copy a keeper back into `plugins.local.json`. `packages` is re-read
 * from disk before the write, so an entry `mpt plugins add` wrote while the
 * daemon ran isn't dropped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "hono";
import type { RouteContext } from "./types.ts";
import type {
  PluginLoadStatus, SourceConfigResponse, SourcePreviewResponse, SourcesResponse, SourceView,
} from "../../shared/protocol.ts";
import type { PackageEntry, TeamConfig } from "../../shared/types.ts";
import type { Store } from "../store.ts";
import { type SourceEntry, sourceIdForWorkDef, TASK_SOURCE_ID } from "../sources/registry.ts";
import { STORY_SOURCE_ID } from "../sources/story.ts";
import { SCHEDULE_SOURCE_ID } from "../sources/schedule.ts";
import { THOUGHT_SOURCE_ID } from "../sources/thought.ts";
import { isSourceSwitchedOff } from "../sources/toggle.ts";
import {
  type ConfigFieldError, checkConfigSchema, configScopeOf, sourceConfigBlock, sourceConfigWarnings, validateSourceConfig, withSourceConfigBlock,
} from "../sources/config-schema.ts";
import { previewSource } from "../sources/preview.ts";
import { restoreRedacted, setPackageEntryConfig, viewSettings } from "../sources/settings.ts";
import { parsePackageEntries } from "../plugins/spec.ts";

/** The sources the Store registers itself (daemon/store.ts constructor). */
const BUILT_IN_SOURCE_IDS: ReadonlySet<string> = new Set([TASK_SOURCE_ID, STORY_SOURCE_ID, SCHEDULE_SOURCE_ID, THOUGHT_SOURCE_ID]);

/** After a preview finishes, the next one for the same source waits this long (429 until then). */
export const PREVIEW_COOLDOWN_MS = 1_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The plugin package a source came from (its load status), if any. */
function packageOf(store: Store, sourceId: string): PluginLoadStatus | undefined {
  return store.getPluginStatuses().find((p) => p.identity !== null && p.sources.includes(sourceId));
}

/** One source as `GET /api/sources` shows it. */
export function sourceView(store: Store, config: TeamConfig, entry: SourceEntry): SourceView {
  const { source, ctx, toggle } = entry;
  const syncs = typeof source.sync === "function";
  const pkg = packageOf(store, source.id);
  const kind: SourceView["kind"] = pkg ? "plugin" : BUILT_IN_SOURCE_IDS.has(source.id) ? "built-in" : "external";
  const schemaUsable = source.configSchema !== undefined && checkConfigSchema(source.configSchema).length === 0;
  const settings = viewSettings(schemaUsable ? source.configSchema : undefined, sourceConfigBlock(source, ctx.options()));
  return {
    id: source.id,
    label: source.label ?? source.id,
    kind,
    syncs,
    ...(pkg ? { package: { spec: pkg.spec, identity: pkg.identity! } } : {}),
    ...(syncs ? { mode: source.mode === "triage" ? "triage" : "work" } : {}),
    toggle: toggle ? { feature: toggle.feature, enabled: !isSourceSwitchedOff(config, toggle) } : null,
    ...(source.configSchema !== undefined ? { configSchema: source.configSchema as unknown as Record<string, unknown> } : {}),
    configScope: configScopeOf(source),
    ...settings,
    configurable: kind === "plugin",
    previewable: typeof source.preview === "function" || syncs,
    ...(entry.initError ? { initError: entry.initError } : {}),
    sync: syncs ? store.getSyncStatus(source.id) : null,
    activeMirrors: syncs
      ? store.getWorkDefs("active").filter((d) => d.parent?.kind === "external" && sourceIdForWorkDef(d) === source.id).length
      : null,
  };
}

/** A settings block's problems against the source's schema (none without a usable schema). */
function schemaErrors({ source }: SourceEntry, block: Record<string, unknown>): ConfigFieldError[] {
  if (!source.configSchema || checkConfigSchema(source.configSchema).length) return [];
  return validateSourceConfig(source.configSchema, block);
}

/** The team's `packages` as config.json has them now (falls back to the in-memory copy when unreadable). */
function packagesOnDisk(teamDir: string, config: TeamConfig): PackageEntry[] | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as unknown;
    if (isPlainObject(raw) && Array.isArray(raw.packages)) return raw.packages as PackageEntry[];
  } catch {
    // No file yet, or bad JSON: the in-memory config is the best we have.
  }
  return config.packages;
}

export function registerSourceRoutes(ctx: RouteContext): void {
  const { app, store, config, teamDir } = ctx;

  // Per-source preview gate: one in flight, then a cooldown (see the header).
  const previewing = new Set<string>();
  const previewDoneAt = new Map<string, number>();

  const find = (id: string) => store.listWorkSources().find((e) => e.source.id === id);
  const notFound = (c: Context, id: string) => c.json({ success: false, error: `No work source "${id}"` }, 404);
  /** The `options` of a `{ options }` body, or null when it isn't an object. */
  const readOptions = async (c: Context): Promise<Record<string, unknown> | null> => {
    const body = await c.req.json().catch(() => null) as unknown;
    return isPlainObject(body) && isPlainObject(body.options) ? body.options : null;
  };

  app.get("/api/sources", (c) => c.json({ sources: store.listWorkSources().map((e) => sourceView(store, config, e)) } satisfies SourcesResponse));

  app.post("/api/sources/:id/preview", async (c) => {
    const id = c.req.param("id");
    const entry = find(id);
    if (!entry) return notFound(c, id);
    if (typeof entry.source.preview !== "function" && typeof entry.source.sync !== "function") {
      return c.json({ success: false, error: `Source "${id}" has nothing to preview (no preview or sync)` } satisfies SourcePreviewResponse, 400);
    }
    const draft = await readOptions(c);
    if (!draft) return c.json({ success: false, error: 'Body must be { "options": { ... } }' } satisfies SourcePreviewResponse, 400);
    const block = restoreRedacted(draft, sourceConfigBlock(entry.source, entry.ctx.options()));
    // Invalid settings never reach the source, so they don't count against the gate below.
    const fieldErrors = schemaErrors(entry, block);
    if (fieldErrors.length) return c.json({ success: false, error: "the settings are invalid", fieldErrors } satisfies SourcePreviewResponse, 400);

    if (previewing.has(id)) {
      c.header("Retry-After", "1");
      return c.json({ success: false, error: `A preview of "${id}" is already running` } satisfies SourcePreviewResponse, 429);
    }
    const wait = (previewDoneAt.get(id) ?? 0) + PREVIEW_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ success: false, error: `Previewed "${id}" a moment ago; try again in ${Math.ceil(wait / 1000)}s` } satisfies SourcePreviewResponse, 429);
    }

    previewing.add(id);
    try {
      const outcome = await previewSource(entry, block);
      if (!outcome.ok) {
        return outcome.fieldErrors
          ? c.json({ success: false, error: outcome.error, fieldErrors: outcome.fieldErrors } satisfies SourcePreviewResponse, 400)
          : c.json({ success: false, error: outcome.error } satisfies SourcePreviewResponse, 502);
      }
      return c.json({ success: true, via: outcome.via, ...outcome.preview } satisfies SourcePreviewResponse);
    } finally {
      previewing.delete(id);
      previewDoneAt.set(id, Date.now());
    }
  });

  app.put("/api/sources/:id/config", async (c) => {
    const id = c.req.param("id");
    const entry = find(id);
    if (!entry) return notFound(c, id);
    const pkg = packageOf(store, id);
    if (!pkg?.identity) {
      return c.json({
        success: false, error: `Source "${id}" isn't from a plugin package, so it has no config.json settings to save`,
      } satisfies SourceConfigResponse, 409);
    }
    const draft = await readOptions(c);
    if (!draft) return c.json({ success: false, error: 'Body must be { "options": { ... } }' } satisfies SourceConfigResponse, 400);

    const { source } = entry;
    const block = restoreRedacted(draft, sourceConfigBlock(source, entry.ctx.options()));
    const fieldErrors = schemaErrors(entry, block);
    if (fieldErrors.length) return c.json({ success: false, error: "the settings are invalid", fieldErrors } satisfies SourceConfigResponse, 400);

    // Merge into the entry's config as it is on disk now (another source's block
    // in a "source"-scoped package; a hand edit), else as the daemon loaded it.
    const onDisk = packagesOnDisk(teamDir, config);
    const diskEntry = parsePackageEntries(onDisk, teamDir).packages.find((p) => p.spec.identity === pkg.identity);
    const entryConfig = withSourceConfigBlock(source, diskEntry?.config ?? entry.ctx.options(), block);
    const updated = setPackageEntryConfig(onDisk, pkg.identity, entryConfig, teamDir);
    if ("error" in updated) return c.json({ success: false, error: updated.error } satisfies SourceConfigResponse, 409);
    config.packages = updated.packages;
    // Store is the single config writer (serializeConfig keeps `packages`).
    store.saveConfig();

    // Every source of the package reads this config as its ctx.options(): re-init them all.
    const reinit: NonNullable<SourceConfigResponse["reinit"]> = [];
    for (const sid of pkg.sources) {
      const sibling = find(sid);
      if (!sibling) continue;
      const r = await store.reinitWorkSource(sid, entryConfig);
      reinit.push(r.ok ? { id: sid, ok: true } : { id: sid, ok: false, error: r.error });
      store.replaceSourceConfigWarnings(sid, sourceConfigWarnings(sibling.source, entryConfig));
    }
    const mine = reinit.find((r) => r.id === id);
    return c.json({
      success: true,
      ...(mine && !mine.ok ? { error: `saved, but re-initializing "${id}" failed: ${mine.error}` } : {}),
      reinit,
      source: sourceView(store, config, entry),
    } satisfies SourceConfigResponse);
  });
}

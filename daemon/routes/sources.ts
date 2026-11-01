/**
 * daemon/routes/sources.ts — Manage each Work Source's settings live: the
 * Config page's **Sources** tab. See docs/DESIGN.md "Plugin settings:
 * configSchema and preview" and docs/ARCHITECTURE.md "Plugin packages".
 *
 *   GET  /api/sources              — every registered source: id, label, kind
 *                                    (built-in / plugin / external), package, mode,
 *                                    toggle, configSchema, current settings (secrets
 *                                    redacted; env-var refs by name + whether set),
 *                                    init error (or persona problem), personas (the
 *                                    team's setting + the source's declaration),
 *                                    sync health, active mirror count
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
 *   PUT  /api/sources/:id/persona  — `{ persona?, triagePersona? }`: the team's
 *                                    persona settings for the source, into config.json
 *                                    `sourcePersonas.<id>` (docs/DESIGN.md "Work Source
 *                                    personas"). Validated against the library; never
 *                                    re-inits the source (it isn't the plugin's setting)
 *                                    — a changed triage persona just syncs it now
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

import type { Context } from "hono";
import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import type {
  PluginLoadStatus, SourceConfigResponse, SourcePersonaRequest, SourcePersonaResponse, SourcePreviewResponse, SourcesResponse, SourceView,
} from "../../shared/protocol.ts";
import type { PackageEntry, TeamConfig } from "../../shared/types.ts";
import { readTeamConfigFile } from "../../shared/team-config.ts";
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
import { isPlainObject } from "../../shared/util.ts";

/** The sources the Store registers itself (daemon/store.ts constructor). */
const BUILT_IN_SOURCE_IDS: ReadonlySet<string> = new Set([TASK_SOURCE_ID, STORY_SOURCE_ID, SCHEDULE_SOURCE_ID, THOUGHT_SOURCE_ID]);

/** After a preview finishes, the next one for the same source waits this long (429 until then). */
export const PREVIEW_COOLDOWN_MS = 1_000;

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
  const personaSetting = config.sourcePersonas?.[source.id];
  const personaError = store.sourcePersonaStatus(source.id);
  const initError = entry.initError ?? personaError;
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
    ...(initError ? { initError } : {}),
    ...(personaError ? { personaError } : {}),
    persona: personaSetting?.persona ?? null,
    defaultPersona: source.defaultPersona ?? null,
    triagePersona: personaSetting?.triagePersona ?? null,
    defaultTriagePersona: source.triagePersona ?? null,
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
    const raw = readTeamConfigFile(teamDir);
    if (raw && Array.isArray(raw.packages)) return raw.packages as PackageEntry[];
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
  const notFound = (c: Context, id: string) => fail(c, 404, `No work source "${id}"`);
  /** The `options` of a `{ options }` body, or null when it isn't an object. */
  const readOptions = async (c: Context): Promise<Record<string, unknown> | null> => {
    const body = await readBody(c) as unknown;
    return isPlainObject(body) && isPlainObject(body.options) ? body.options : null;
  };

  app.get("/api/sources", (c) => c.json({ sources: store.listWorkSources().map((e) => sourceView(store, config, e)) } satisfies SourcesResponse));

  app.post("/api/sources/:id/preview", async (c) => {
    const id = c.req.param("id");
    const entry = find(id);
    if (!entry) return notFound(c, id);
    if (typeof entry.source.preview !== "function" && typeof entry.source.sync !== "function") {
      return fail(c, 400, `Source "${id}" has nothing to preview (no preview or sync)`);
    }
    const draft = await readOptions(c);
    if (!draft) return fail(c, 400, 'Body must be { "options": { ... } }');
    const block = restoreRedacted(draft, sourceConfigBlock(entry.source, entry.ctx.options()));
    // Invalid settings never reach the source, so they don't count against the gate below.
    const fieldErrors = schemaErrors(entry, block);
    if (fieldErrors.length) return fail(c, 400, "the settings are invalid", { fieldErrors });

    if (previewing.has(id)) {
      c.header("Retry-After", "1");
      return fail(c, 429, `A preview of "${id}" is already running`);
    }
    const wait = (previewDoneAt.get(id) ?? 0) + PREVIEW_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return fail(c, 429, `Previewed "${id}" a moment ago; try again in ${Math.ceil(wait / 1000)}s`);
    }

    previewing.add(id);
    try {
      const outcome = await previewSource(entry, block);
      if (!outcome.ok) {
        return outcome.fieldErrors
          ? fail(c, 400, outcome.error, { fieldErrors: outcome.fieldErrors })
          : fail(c, 502, outcome.error);
      }
      return c.json({ success: true, via: outcome.via, ...outcome.preview } satisfies SourcePreviewResponse);
    } finally {
      previewing.delete(id);
      previewDoneAt.set(id, Date.now());
    }
  });

  app.put("/api/sources/:id/persona", async (c) => {
    const id = c.req.param("id");
    const entry = find(id);
    if (!entry) return notFound(c, id);
    const body = await readBody(c) as unknown;
    if (!isPlainObject(body) || (body.persona === undefined && body.triagePersona === undefined)) {
      return fail(c, 400, 'Body must be { "persona"?: id | null, "triagePersona"?: id | null }');
    }
    const update = body as SourcePersonaRequest;
    const res = store.setSourcePersona(id, { persona: update.persona, triagePersona: update.triagePersona });
    if (!res.ok) return fail(c, res.status, res.error);
    return c.json({ success: true, source: sourceView(store, config, entry) } satisfies SourcePersonaResponse);
  });

  app.put("/api/sources/:id/config", async (c) => {
    const id = c.req.param("id");
    const entry = find(id);
    if (!entry) return notFound(c, id);
    const pkg = packageOf(store, id);
    if (!pkg?.identity) {
      return fail(c, 409, `Source "${id}" isn't from a plugin package, so it has no config.json settings to save`);
    }
    const draft = await readOptions(c);
    if (!draft) return fail(c, 400, 'Body must be { "options": { ... } }');

    const { source } = entry;
    const block = restoreRedacted(draft, sourceConfigBlock(source, entry.ctx.options()));
    const fieldErrors = schemaErrors(entry, block);
    if (fieldErrors.length) return fail(c, 400, "the settings are invalid", { fieldErrors });

    // Merge into the entry's config as it is on disk now (another source's block
    // in a "source"-scoped package; a hand edit), else as the daemon loaded it.
    const onDisk = packagesOnDisk(teamDir, config);
    const diskEntry = parsePackageEntries(onDisk, teamDir).packages.find((p) => p.spec.identity === pkg.identity);
    const entryConfig = withSourceConfigBlock(source, diskEntry?.config ?? entry.ctx.options(), block);
    const updated = setPackageEntryConfig(onDisk, pkg.identity, entryConfig, teamDir);
    if ("error" in updated) return fail(c, 409, updated.error);
    config.packages = updated.packages;
    // Store is the single config writer (saveTeamConfig keeps `packages`).
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

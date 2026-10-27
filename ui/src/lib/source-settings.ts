/**
 * lib/source-settings.ts — The Config page's **Sources** tab, kept pure (no
 * React) so its rules are unit-tested (tests/source-settings-ui.test.ts): which
 * sources it lists, each one's status pill, the form it generates from a
 * source's `configSchema`, how form edits change the draft settings block,
 * the JSON-editor fallback, server field errors by field, the dirty check, and
 * the body for switching a source on or off right from the tab.
 * See docs/DESIGN.md "Plugin settings: configSchema and preview" and GUIDE.md
 * "Setting up a plugin from the UI".
 *
 * The wire types are hand-mirrored from shared/protocol.ts (`SourceView`,
 * `SourcePreviewResponse`, `SourceConfigResponse`, `REDACTED_SETTING`) and the
 * schema subset from daemon/sources/types.ts (`SourceConfigSchema`), as
 * lib/triage.ts does. The daemon is the authority on validity — the form
 * only shapes the draft; `PUT`/`preview` answer with field-level errors.
 */

/** What `GET /api/sources` shows in place of a secret (shared/protocol.ts `REDACTED_SETTING`). */
export const REDACTED_SETTING = "__mpt_redacted__";

/** One field-level settings problem (shared/protocol.ts `SourceFieldError`). */
export interface SourceFieldError {
  path: string;
  message: string;
}

/** One env-var reference in a source's saved settings (shared/protocol.ts `SourceEnvVarRef`). */
export interface SourceEnvVarRef {
  path: string;
  name: string;
  set: boolean;
}

/** One registered Work Source (shared/protocol.ts `SourceView`). */
export interface SourceView {
  id: string;
  label: string;
  kind: "built-in" | "plugin" | "external";
  syncs: boolean;
  package?: { spec: string; identity: string };
  mode?: "work" | "triage";
  toggle: { feature: string; enabled: boolean } | null;
  configSchema?: Record<string, unknown>;
  configScope: "package" | "source";
  options: Record<string, unknown>;
  redacted: string[];
  envVars: SourceEnvVarRef[];
  configurable: boolean;
  previewable: boolean;
  initError?: string;
  sync: {
    running: boolean;
    failures: number;
    backoffUntil: number | null;
    last: { at: number; ok: boolean; error?: string; mirrored: number; enqueued: number; archived: number; held: number } | null;
  } | null;
  activeMirrors: number | null;
}

/** One previewed item (shared/protocol.ts `SourcePreviewResponse.items`). */
export interface PreviewItem {
  externalId: string;
  revision: string;
  title: string;
  goal: string;
  url?: string;
  directory?: string;
  mode?: "work" | "triage";
}

/** `POST /api/sources/:id/preview` (shared/protocol.ts `SourcePreviewResponse`). */
export interface SourcePreviewResponse {
  success: boolean;
  error?: string;
  fieldErrors?: SourceFieldError[];
  via?: "preview" | "sync";
  items?: PreviewItem[];
  warnings?: string[];
  note?: string;
}

/** `PUT /api/sources/:id/config` (shared/protocol.ts `SourceConfigResponse`). */
export interface SourceConfigResponse {
  success: boolean;
  error?: string;
  fieldErrors?: SourceFieldError[];
  reinit?: Array<{ id: string; ok: boolean; error?: string }>;
  source?: SourceView;
}

// ─── Routes ─────────────────────────────────────────────────────────

/** The Sources tab's route. */
export const SOURCES_TAB_PATH = "/config/sources";

/** A source's settings on the Sources tab (`/config/sources/:id`) — ExternalSourcePage's **Configure**. */
export function sourceSettingsPath(sourceId: string): string {
  return `${SOURCES_TAB_PATH}/${encodeURIComponent(sourceId)}`;
}

/** The source a `/config/sources/:id` route selects, or null (the bare tab, another route). */
export function sourceIdFromConfigPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "config" || segments[1] !== "sources" || segments.length !== 3) return null;
  try {
    return decodeURIComponent(segments[2]!);
  } catch {
    return null;
  }
}

// ─── The list ───────────────────────────────────────────────────────

/**
 * The sources the tab lists: every plugin and external source (built-in
 * kinds — stories, tasks, schedules, notes — have their own Config sections),
 * in the server's order.
 */
export function managedSources(sources: readonly SourceView[] | null | undefined): SourceView[] {
  return (sources ?? []).filter((s) => s.kind !== "built-in");
}

/** Is the source switched on? (No toggle = always on.) */
export function isSourceEnabled(source: Pick<SourceView, "toggle">): boolean {
  return source.toggle === null || source.toggle.enabled;
}

/** "just now", "5m ago", "3h ago", "2d ago" — compact, for a status pill. */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A source's status pill: what to say, its tone, and the detail on hover. */
export interface SourceStatus {
  label: string;
  tone: "ok" | "bad" | "warn" | "neutral";
  detail?: string;
}

/**
 * The pill for a source: off; init failed (its settings may be wrong); syncing;
 * backing off after failures; last sync failed / ok (with when); not synced
 * yet. A source that doesn't sync shows "On".
 */
export function sourceStatus(source: SourceView, now: number): SourceStatus {
  if (!isSourceEnabled(source)) return { label: "Off", tone: "neutral", detail: "Switched off: not synced, nothing new runs" };
  if (source.initError) return { label: "Init failed", tone: "bad", detail: source.initError };
  const sync = source.sync;
  if (!sync) return { label: "On", tone: "ok" };
  if (sync.running) return { label: "Syncing…", tone: "neutral" };
  const last = sync.last;
  if (sync.backoffUntil !== null && sync.backoffUntil > now) {
    return { label: `Backing off (${sync.failures} failed)`, tone: "bad", detail: last?.error };
  }
  if (!last) return { label: "Not synced yet", tone: "neutral" };
  const when = relativeTime(last.at, now);
  if (!last.ok) return { label: `Sync failed ${when}`, tone: "bad", detail: last.error };
  return {
    label: `Synced ${when}`,
    tone: "ok",
    detail: `${last.mirrored} mirrored, ${last.enqueued} queued, ${last.archived} archived${last.held ? `, ${last.held} held` : ""}`,
  };
}

/** "3 mirrored items" / "1 mirrored item"; null for a source that doesn't mirror. */
export function mirrorCountLabel(source: Pick<SourceView, "activeMirrors">): string | null {
  if (source.activeMirrors === null) return null;
  return `${source.activeMirrors} mirrored item${source.activeMirrors === 1 ? "" : "s"}`;
}

/** "3 items" — what "Turn off and archive N items" archives. */
export function itemsLabel(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

/**
 * The `PUT /api/config` body that switches one source's feature, built from
 * the daemon's *current* config (fetched just before) rather than the page's
 * draft, so unsaved edits on other tabs aren't saved by a toggle click. Drops
 * the read-only fields; `features` names just this one (the daemon merges).
 */
export function toggleConfigBody(current: Record<string, unknown>, feature: string, on: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { ...current };
  delete body.featureUsage;
  delete body.featureSources;
  delete body.defaultNouns;
  body.features = { [feature]: on };
  return body;
}

// ─── The form ───────────────────────────────────────────────────────

/** What a field renders as. */
export type FormFieldKind = "text" | "env-var" | "number" | "boolean" | "select" | "multi-select" | "string-list" | "group";

/** One field of the generated form. */
export interface FormField {
  /** Path in the settings block: `["key"]` or `["group", "key"]`. */
  path: string[];
  kind: FormFieldKind;
  title: string;
  description?: string;
  placeholder?: string;
  default?: unknown;
  required: boolean;
  /** `select` / `multi-select` choices. */
  options?: Array<string | number>;
  /** Numbers: `integer` refuses fractions (the input's step). */
  integer?: boolean;
  /** `group` only: its fields (leaves). */
  fields?: FormField[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hints(raw: Record<string, unknown>, key: string): Pick<FormField, "title" | "description" | "placeholder"> {
  return {
    title: typeof raw.title === "string" && raw.title ? raw.title : key,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
  };
}

/** One schema property → its field, or null when outside the subset. */
function fieldFrom(raw: unknown, key: string, path: string[], required: boolean, depth: number): FormField | null {
  if (!isPlainObject(raw)) return null;
  const base = { path, required, ...hints(raw, key), ...(raw.default !== undefined ? { default: raw.default } : {}) };
  const enumOf = Array.isArray(raw.enum) ? raw.enum as Array<string | number> : undefined;
  switch (raw.type) {
    case "string":
      if (enumOf) return { ...base, kind: "select", options: enumOf };
      return { ...base, kind: raw.format === "env-var" ? "env-var" : "text" };
    case "number":
    case "integer":
      if (enumOf) return { ...base, kind: "select", options: enumOf };
      return { ...base, kind: "number", integer: raw.type === "integer" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "array": {
      const items = isPlainObject(raw.items) ? raw.items : {};
      if (items.type !== "string") return null;
      if (Array.isArray(items.enum)) return { ...base, kind: "multi-select", options: items.enum as string[] };
      return { ...base, kind: "string-list" };
    }
    case "object": {
      if (depth > 0 || !isPlainObject(raw.properties)) return null;
      const req = Array.isArray(raw.required) ? raw.required as string[] : [];
      const fields: FormField[] = [];
      for (const [k, v] of Object.entries(raw.properties)) {
        const f = fieldFrom(v, k, [...path, k], req.includes(k), depth + 1);
        if (!f) return null;
        fields.push(f);
      }
      return { ...base, kind: "group", fields };
    }
    default:
      return null;
  }
}

/**
 * The form for a source's `configSchema`, or null when there's no schema or
 * it strays outside the supported subset (the tab falls back to the JSON
 * editor, as for a source without one).
 */
export function formFields(schema: Record<string, unknown> | undefined): FormField[] | null {
  if (!schema || schema.type !== "object" || !isPlainObject(schema.properties)) return null;
  const req = Array.isArray(schema.required) ? schema.required as string[] : [];
  const fields: FormField[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    const f = fieldFrom(raw, key, [key], req.includes(key), 0);
    if (!f) return null;
    fields.push(f);
  }
  return fields;
}

/** Keys in the settings the schema doesn't describe — kept as they are, and listed under the form. */
export function extraKeys(fields: readonly FormField[], options: Readonly<Record<string, unknown>>): string[] {
  const known = new Set(fields.map((f) => f.path[0]));
  return Object.keys(options).filter((k) => !known.has(k));
}

/** The value at `path` in a settings block. */
export function valueAt(block: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let at: unknown = block;
  for (const key of path) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * A copy of the block with `value` at `path`. `undefined` removes the key (an
 * emptied input means "unset — use the default", not `""`), and a group left
 * empty goes too, so clearing fields doesn't leave `{}` behind in config.json.
 */
export function withValueAt(block: Readonly<Record<string, unknown>>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return { ...block };
  const out: Record<string, unknown> = { ...block };
  if (rest.length === 0) {
    if (value === undefined) delete out[key];
    else out[key] = value;
    return out;
  }
  const inner = withValueAt(isPlainObject(block[key]) ? block[key] as Record<string, unknown> : {}, rest, value);
  if (Object.keys(inner).length === 0) delete out[key];
  else out[key] = inner;
  return out;
}

/** A text input's value → the setting: trimmed-empty is unset. */
export function textValue(input: string): string | undefined {
  return input === "" ? undefined : input;
}

/** A number input's value → the setting: empty or not a number is unset. */
export function numberValue(input: string): number | undefined {
  if (input.trim() === "") return undefined;
  const n = Number(input);
  return Number.isFinite(n) ? n : undefined;
}

/** A string-list textarea (one per line; commas also split) → the setting: empty is unset. */
export function stringListValue(input: string): string[] | undefined {
  const items = input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** A string-list setting → the textarea's text. */
export function stringListText(value: unknown): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : "";
}

/** A select's value (an option's index, or "" for unset) → the setting. */
export function selectValue(field: Pick<FormField, "options">, input: string): string | number | undefined {
  if (input === "") return undefined;
  return field.options?.[Number(input)];
}

/** The `<select>` value for a setting: the matching option's index, or "" when unset/unknown. */
export function selectInput(field: Pick<FormField, "options">, value: unknown): string {
  const i = field.options?.findIndex((o) => o === value) ?? -1;
  return i === -1 ? "" : String(i);
}

/** Is a setting the `REDACTED_SETTING` placeholder (a stored secret the browser never sees)? */
export function isRedacted(value: unknown): boolean {
  return value === REDACTED_SETTING;
}

/**
 * For an env-var field: is the variable it names set in the daemon's
 * environment? Known only for the saved name (GET /api/sources checked it);
 * a changed, unsaved name is `"unknown"` until saved.
 */
export function envVarState(source: Pick<SourceView, "envVars">, path: readonly string[], name: unknown): "set" | "not-set" | "unknown" | "none" {
  if (typeof name !== "string" || name === "" || isRedacted(name)) return "none";
  const ref = source.envVars.find((e) => e.path === path.join("."));
  if (!ref || ref.name !== name) return "unknown";
  return ref.set ? "set" : "not-set";
}

/** The default to show for a field when it's unset ("Default: 10"), or null. */
export function defaultHint(field: Pick<FormField, "default">): string | null {
  const d = field.default;
  if (d === undefined) return null;
  if (Array.isArray(d)) return d.length ? `Default: ${d.join(", ")}` : null;
  if (typeof d === "boolean") return `Default: ${d ? "on" : "off"}`;
  return `Default: ${String(d)}`;
}

// ─── Errors, dirty state, JSON fallback ─────────────────────────────

/**
 * Server field errors grouped by the form field they belong to: `"group.key"`
 * and `"list[2]"` (an item) land on `group.key` / `list`; `""` (the block
 * itself) stays under `""`.
 */
export function fieldErrorsByPath(errors: readonly SourceFieldError[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors ?? []) {
    const key = e.path.replace(/\[\d+\]$/, "");
    (out[key] ??= []).push(e.path === key ? e.message : `${e.path}: ${e.message}`);
  }
  return out;
}

/** Field errors that no form field shows (the block's own, or keys outside the schema). */
export function unplacedErrors(byPath: Readonly<Record<string, string[]>>, fields: readonly FormField[] | null): string[] {
  const placed = new Set<string>();
  for (const f of fields ?? []) {
    placed.add(f.path.join("."));
    for (const g of f.fields ?? []) placed.add(g.path.join("."));
  }
  return Object.entries(byPath).flatMap(([path, msgs]) => placed.has(path) ? [] : msgs.map((m) => path && !m.startsWith(path) ? `${path}: ${m}` : m));
}

/** JSON with object keys sorted, so key order doesn't count as a change. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

/** Does the draft differ from the saved settings? (The navigate-away guard and the Save button.) */
export function settingsDirty(draft: Readonly<Record<string, unknown>>, saved: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(stable(draft)) !== JSON.stringify(stable(saved));
}

/** The JSON editor's text for a settings block. */
export function settingsJson(options: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(options, null, 2);
}

/** The JSON editor's text → a settings block, or why it isn't one (syntax, or not an object). */
export function parseSettingsJson(text: string): { ok: true; options: Record<string, unknown> } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, options: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "Settings must be a JSON object ({ … })" };
  return { ok: true, options: parsed };
}

// ─── Preview & Save results ─────────────────────────────────────────

/** A previewed item's mode: its own, else the source's, else work. */
export function previewItemMode(item: Pick<PreviewItem, "mode">, source: Pick<SourceView, "mode">): "work" | "triage" {
  return item.mode ?? source.mode ?? "work";
}

/** The headline over a preview's table ("3 items would be pulled"). */
export function previewSummary(items: readonly unknown[]): string {
  return items.length === 0 ? "Nothing would be pulled" : `${itemsLabel(items.length)} would be pulled`;
}

/**
 * What a Save says: saved and re-initialized, or saved but a re-init failed
 * (the settings stay saved; the source is marked errored).
 */
export function saveOutcome(res: SourceConfigResponse): { ok: boolean; message: string } {
  if (!res.success) return { ok: false, message: res.error || "Save failed" };
  const failed = (res.reinit ?? []).filter((r) => !r.ok);
  if (failed.length) {
    return { ok: false, message: `Saved, but re-initializing failed: ${failed.map((r) => `${r.id}: ${r.error ?? "error"}`).join("; ")}` };
  }
  const ids = (res.reinit ?? []).map((r) => r.id);
  return { ok: true, message: ids.length > 1 ? `Saved — re-initialized ${ids.join(", ")}` : "Saved — re-initialized, no restart needed" };
}

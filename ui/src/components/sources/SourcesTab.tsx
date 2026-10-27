/**
 * SourcesTab — Config → **Sources** (`/config/sources`, a source's settings at
 * `/config/sources/:id`): set up and manage Work Source plugins entirely from
 * the UI. See GUIDE.md "Setting up a plugin from the UI" and docs/DESIGN.md
 * "Plugin settings: configSchema and preview".
 *
 * - **The list** (`GET /api/sources`, polled): every plugin and external
 *   source — label, package, status pill (on/off, init error, last sync ok or
 *   failed and when, backoff), mirrored-item count — with its **on/off
 *   switch**, a link to its Work tab, and any package that failed to load
 *   (`GET /api/work-sources` `plugins`). The switch applies at once (`PUT
 *   /api/config` with just that feature, built from the daemon's current
 *   config, so other tabs' unsaved edits aren't saved with it). Switching off
 *   a source that still holds mirrors opens the **Turn off and archive N
 *   items** confirm (DisconnectSourceDialog) — this is the one place external
 *   sources are switched; Config → General → Work items links here.
 * - **The settings form** for the selected source, generated from its
 *   `configSchema` (lib/source-settings.ts `formFields`): text, number,
 *   checkbox, select, multi-select and string-list inputs with titles,
 *   descriptions, placeholders, defaults, required markers, and the server's
 *   inline field errors. A `format: "env-var"` field takes a variable *name*
 *   and shows whether the daemon's environment has it — never a value. No
 *   schema (or one outside the subset) → a JSON editor that checks syntax.
 * - **Preview** (`POST /api/sources/:id/preview`) with the *unsaved* draft:
 *   the items a sync would pull, warnings, errors — nothing is created.
 * - **Save** (`PUT /api/sources/:id/config`): writes config.json and
 *   re-initializes the source without a restart; shows the re-init result and
 *   refreshes the status. Leaving with unsaved edits asks first
 *   (useUnsavedChangesGuard).
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiPost, apiPut, useApi } from "@/hooks/useApi";
import { notifyFeaturesChanged } from "@/hooks/useFeatures";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  defaultHint, envVarState, extraKeys, fieldErrorsByPath, formFields, isRedacted, isSourceEnabled, itemsLabel,
  mirrorCountLabel, managedSources, numberValue, parseSettingsJson, previewItemMode, previewSummary, saveOutcome,
  selectInput, selectValue, settingsDirty, settingsJson, sourceSettingsPath, sourceStatus, stringListText,
  stringListValue, textValue, toggleConfigBody, unplacedErrors, valueAt, withValueAt,
  type FormField, type SourceConfigResponse, type SourcePreviewResponse, type SourceStatus, type SourceView,
} from "@/lib/source-settings";
import { externalSourcePath } from "@/lib/work-items";
import { DisconnectSourceDialog, type DisconnectTarget } from "@/components/sources/DisconnectSourceDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Eye, ExternalLink, Plug, RotateCcw, Save } from "lucide-react";

/** One `packages` entry's load status (shared/protocol.ts `PluginLoadStatus`), for failed packages. */
interface PluginLoadStatus {
  identity: string | null;
  spec: string;
  state: "loaded" | "error";
  error?: string;
  sources: string[];
}

const TONE_CLASS: Record<SourceStatus["tone"], string> = {
  ok: "border-emerald-500/60 text-emerald-600",
  bad: "border-red-500/60 text-red-600",
  warn: "border-amber-500/60 text-amber-600",
  neutral: "text-muted-foreground",
};

/** The status pills' clock: re-rendered every 30s so "Synced 2m ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function SourcesTab({ selectedId, onFeatureApplied }: {
  /** The source whose settings show (`/config/sources/:id`), or null. */
  selectedId: string | null;
  /** A source's toggle was saved by the daemon: keep the page's config draft in step. */
  onFeatureApplied: (feature: string, on: boolean) => void;
}) {
  const { data, error, refetch } = useApi<{ sources: SourceView[] }>("/api/sources", [], { pollInterval: 10_000 });
  const { data: workSources } = useApi<{ plugins?: PluginLoadStatus[] }>("/api/work-sources");
  const now = useNow();
  const sources = managedSources(data?.sources);
  // Packages that loaded no source at all; a partly failed one shows on its sources' status.
  const failed = (workSources?.plugins ?? []).filter((p) => p.state === "error" && p.sources.length === 0);
  const selected = sources.find((s) => s.id === selectedId) ?? null;

  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<{ id: string; message: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<DisconnectTarget | null>(null);

  const applied = (feature: string, on: boolean) => {
    onFeatureApplied(feature, on);
    notifyFeaturesChanged();
    refetch();
  };

  const toggle = async (source: SourceView, on: boolean) => {
    if (!source.toggle) return;
    setToggleError(null);
    // With mirrors still active the daemon refuses a plain switch-off (409): offer the disconnect.
    if (!on && (source.activeMirrors ?? 0) > 0) {
      setDisconnecting({ sourceId: source.id, feature: source.toggle.feature, label: source.label, description: itemsLabel(source.activeMirrors ?? 0) });
      return;
    }
    setToggling(source.id);
    try {
      const current = await fetch("/api/config").then((r) => r.json() as Promise<Record<string, unknown>>);
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", toggleConfigBody(current, source.toggle.feature, on));
      if (res.success) applied(source.toggle.feature, on);
      else setToggleError({ id: source.id, message: res.error || "Couldn't switch it" });
    } catch (e) {
      setToggleError({ id: source.id, message: "Network error: " + (e as Error).message });
    }
    setToggling(null);
  };

  if (!data) {
    return <p className="text-sm text-muted-foreground">{error ? `Cannot load sources (${error}).` : "Loading..."}</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Work Source plugins bring work in from a tracker, a folder, or an API. Switch each one on or off (applies at
        once), and pick one to edit its settings: <strong>Preview</strong> shows what it would pull without creating
        anything, and <strong>Save</strong> applies the settings without a restart.
      </p>

      {sources.length === 0 && failed.length === 0 && <NoPluginsCard />}

      <div className="grid gap-2">
        {sources.map((s) => {
          const status = sourceStatus(s, now);
          const mirrors = mirrorCountLabel(s);
          const on = isSourceEnabled(s);
          return (
            <Card key={s.id} className={s.id === selectedId ? "border-primary" : "hover:border-primary/50 transition-colors"}>
              <CardContent className="p-3 space-y-1">
                <div className="flex items-center gap-3">
                  {s.toggle ? (
                    <input
                      type="checkbox"
                      id={`source-toggle-${s.id}`}
                      aria-label={`${s.label} on`}
                      title={on ? `Switch ${s.label} off` : `Switch ${s.label} on`}
                      checked={on}
                      disabled={toggling === s.id}
                      onChange={(e) => toggle(s, e.target.checked)}
                    />
                  ) : (
                    <span className="w-[13px]" title="Always on (no toggle)" />
                  )}
                  <Link to={sourceSettingsPath(s.id)} className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {s.label}
                      {s.mode === "triage" && <Badge variant="outline" className="ml-2 text-[10px]">Triage</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {s.package?.spec ?? (s.kind === "external" ? "built into the daemon" : s.id)}
                    </p>
                  </Link>
                  {mirrors && <span className="text-xs text-muted-foreground whitespace-nowrap">{mirrors}</span>}
                  <Badge variant="outline" className={TONE_CLASS[status.tone]} title={status.detail}>{status.label}</Badge>
                  {s.syncs && on && (
                    <Button variant="ghost" size="sm" render={<Link to={externalSourcePath(s.id)} />} title={`${s.label}'s Work tab`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {toggleError?.id === s.id && <p className="pl-6 text-xs text-destructive">{toggleError.message}</p>}
              </CardContent>
            </Card>
          );
        })}
        {failed.map((p) => (
          <Card key={p.spec} className="border-red-500/40">
            <CardContent className="p-3 text-sm">
              <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-red-600" />{p.spec}</p>
              <p className="text-xs text-muted-foreground">Didn't load: {p.error ?? "unknown error"}. Fix it, then restart the daemon (<code>mpt plugins list</code> shows the same).</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedId && !selected && <p className="text-sm text-muted-foreground">No plugin source “{selectedId}” is registered.</p>}
      {selected && <SourceSettings key={selected.id} source={selected} onSaved={refetch} />}

      <DisconnectSourceDialog
        target={disconnecting}
        onClose={() => setDisconnecting(null)}
        onDisconnected={(t) => { setDisconnecting(null); applied(t.feature, false); }}
      />
    </div>
  );
}

/** The empty state: nothing installed yet, and how to add a plugin. */
function NoPluginsCard() {
  return (
    <Card>
      <CardContent className="p-6 space-y-2 text-sm">
        <h2 className="flex items-center gap-2 font-semibold"><Plug className="h-4 w-4" />No plugins installed</h2>
        <p className="text-muted-foreground">
          Add a Work Source plugin package from a terminal, then restart the daemon — it shows up here to switch
          on, configure, and preview:
        </p>
        <pre className="rounded bg-muted p-2 text-xs">mpt plugins add npm:mpt-acme-tracker{"\n"}mpt stop && mpt start --daemon</pre>
        <p className="text-muted-foreground">
          See <Link to="/help" className="text-primary underline">Help</Link> → <em>Writing a Work Source plugin</em> (step 5,
          “Add it, then restart”) for npm, git, and local packages.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── One source's settings ──────────────────────────────────────────

/** The selected source's settings form (or JSON editor), Preview, and Save. Keyed by source id. */
function SourceSettings({ source, onSaved }: { source: SourceView; onSaved: () => void }) {
  const fields = useMemo(() => formFields(source.configSchema), [source.configSchema]);
  const [saved, setSaved] = useState<Record<string, unknown>>(source.options);
  const [draft, setDraft] = useState<Record<string, unknown>>(source.options);
  const [jsonText, setJsonText] = useState(() => settingsJson(source.options));
  const parsedJson = fields ? null : parseSettingsJson(jsonText);
  // The block Preview and Save send: the form's draft, or the parsed JSON (null while it doesn't parse).
  const options = fields ? draft : parsedJson?.ok ? parsedJson.options : null;
  const dirty = fields ? settingsDirty(draft, saved) : jsonText !== settingsJson(saved);
  useUnsavedChangesGuard(dirty);

  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SourcePreviewResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const id = encodeURIComponent(source.id);

  const runPreview = async () => {
    if (!options) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await apiPost<SourcePreviewResponse>(`/api/sources/${id}/preview`, { options });
      setErrors(fieldErrorsByPath(res.fieldErrors));
      setPreview(res);
    } catch (e) {
      setPreview({ success: false, error: "Network error: " + (e as Error).message });
    }
    setPreviewing(false);
  };

  const save = async () => {
    if (!options) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await apiPut<SourceConfigResponse>(`/api/sources/${id}/config`, { options });
      setErrors(fieldErrorsByPath(res.fieldErrors));
      setResult(saveOutcome(res));
      if (res.success) {
        // The daemon's view of what it saved (secrets redacted again) is the new baseline.
        const next = res.source?.options ?? options;
        setSaved(next);
        setDraft(next);
        setJsonText(settingsJson(next));
        onSaved();
      }
    } catch (e) {
      setResult({ ok: false, message: "Network error: " + (e as Error).message });
    }
    setSaving(false);
  };

  const reset = () => {
    setDraft(saved);
    setJsonText(settingsJson(saved));
    setErrors({});
    setResult(null);
  };

  const set = (path: string[], value: unknown) => setDraft((d) => withValueAt(d, path, value));
  const extras = fields ? extraKeys(fields, draft) : [];
  const general = unplacedErrors(errors, fields);

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold mr-auto">{source.label} settings</h2>
          {source.syncs && (
            <Button variant="outline" size="sm" render={<Link to={externalSourcePath(source.id)} />}>
              <ExternalLink className="h-3.5 w-3.5 mr-1" />Open {source.label}'s Work tab
            </Button>
          )}
        </div>
        {source.initError && (
          <p className="text-xs text-destructive">Its last init failed: {source.initError}. Fix the settings and Save to retry.</p>
        )}
        {!source.configurable && (
          <p className="text-xs text-muted-foreground">
            This source is built into the daemon, not a plugin package, so its settings can't be saved here (Preview still works).
          </p>
        )}
        {source.package && (
          <p className="text-xs text-muted-foreground">
            Saved to <code>config.json</code> → <code>packages</code> → <code>{source.package.spec}</code>
            {source.configScope === "source" ? <> → <code>config.{source.id}</code></> : <> → <code>config</code></>}.
          </p>
        )}

        {fields ? (
          <div className="space-y-3">
            {fields.length === 0 && <p className="text-xs text-muted-foreground italic">This source has no settings.</p>}
            {fields.map((f) => (
              <FieldRow key={f.path.join(".")} field={f} draft={draft} source={source} errors={errors} set={set} />
            ))}
            {extras.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Also kept as they are (not in the form): {extras.map((k) => <code key={k} className="mr-1">{k}</code>)}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {source.configSchema
                ? "Its settings schema isn't one the form understands, so edit the settings as JSON."
                : "This source doesn't describe its settings (no configSchema), so edit them as JSON."}
              {source.redacted.length > 0 && <> Values shown as <code>__mpt_redacted__</code> are hidden secrets; leave them to keep them.</>}
            </p>
            <Textarea
              id={`source-${source.id}-json`}
              rows={10}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="font-mono text-xs"
              aria-invalid={parsedJson?.ok === false}
            />
            {parsedJson && !parsedJson.ok && <p className="text-xs text-destructive">{parsedJson.error}</p>}
          </div>
        )}

        {general.length > 0 && (
          <ul className="text-xs text-destructive list-disc pl-4">{general.map((m) => <li key={m}>{m}</li>)}</ul>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={runPreview} disabled={!options || previewing || !source.previewable} className="gap-1"
            title={source.previewable ? "What it would pull with these (unsaved) settings — nothing is created" : "This source has nothing to preview"}>
            <Eye className="h-3.5 w-3.5" />{previewing ? "Previewing..." : "Preview"}
          </Button>
          <Button size="sm" onClick={save} disabled={!options || saving || (!dirty && !source.initError) || !source.configurable} className="gap-1">
            <Save className="h-3.5 w-3.5" />{saving ? "Saving..." : "Save"}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={reset} className="gap-1"><RotateCcw className="h-3.5 w-3.5" />Discard changes</Button>
          )}
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
          {result && <span className={`text-xs ${result.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>{result.message}</span>}
        </div>

        {(previewing || preview) && <PreviewResult source={source} loading={previewing} preview={preview} />}
      </CardContent>
    </Card>
  );
}

/** One schema field (or a group of them) with its label, hints, and errors. */
function FieldRow({ field, draft, source, errors, set }: {
  field: FormField;
  draft: Record<string, unknown>;
  source: SourceView;
  errors: Record<string, string[]>;
  set: (path: string[], value: unknown) => void;
}) {
  const key = field.path.join(".");
  const inputId = `source-${source.id}-${field.path.join("-")}`;
  const mine = errors[key] ?? [];
  const hint = defaultHint(field);

  if (field.kind === "group") {
    return (
      <fieldset className="space-y-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">{field.title}{field.required && <RequiredMark />}</legend>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        {field.fields?.map((f) => <FieldRow key={f.path.join(".")} field={f} draft={draft} source={source} errors={errors} set={set} />)}
        {mine.map((m) => <p key={m} className="text-xs text-destructive">{m}</p>)}
      </fieldset>
    );
  }

  const value = valueAt(draft, field.path);
  const invalid = mine.length > 0;
  let input;
  switch (field.kind) {
    case "boolean":
      input = (
        <label className="flex items-center gap-2 text-sm">
          <input id={inputId} type="checkbox" checked={typeof value === "boolean" ? value : field.default === true}
            onChange={(e) => set(field.path, e.target.checked)} />
          {field.title}{field.required && <RequiredMark />}
        </label>
      );
      break;
    case "select":
      input = (
        <select id={inputId} value={selectInput(field, value)} aria-invalid={invalid}
          onChange={(e) => set(field.path, selectValue(field, e.target.value))}
          className="h-9 max-w-[320px] rounded-md border border-border bg-background px-2 text-sm">
          <option value="">{field.default !== undefined ? `(default: ${String(field.default)})` : "(not set)"}</option>
          {field.options?.map((o, i) => <option key={String(o)} value={String(i)}>{String(o)}</option>)}
        </select>
      );
      break;
    case "multi-select": {
      const chosen = Array.isArray(value) ? value : [];
      input = (
        <div id={inputId} className="flex flex-wrap gap-3 text-sm">
          {field.options?.map((o) => (
            <label key={String(o)} className="flex items-center gap-1.5">
              <input type="checkbox" checked={chosen.includes(o)}
                onChange={(e) => {
                  const next = e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o);
                  set(field.path, next.length ? next : undefined);
                }} />
              {String(o)}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "string-list":
      input = (
        <Textarea id={inputId} rows={3} value={stringListText(value)} aria-invalid={invalid}
          placeholder={field.placeholder ?? "One per line"}
          onChange={(e) => set(field.path, stringListValue(e.target.value))}
          className="max-w-[420px] font-mono text-xs" />
      );
      break;
    case "number":
      input = (
        <Input id={inputId} type="number" step={field.integer ? 1 : "any"} value={typeof value === "number" ? value : ""} aria-invalid={invalid}
          placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          onChange={(e) => set(field.path, numberValue(e.target.value))}
          className="max-w-[160px]" />
      );
      break;
    case "env-var":
      input = <EnvVarInput id={inputId} field={field} value={value} source={source} invalid={invalid} onChange={(v) => set(field.path, v)} />;
      break;
    default:
      input = (
        <Input id={inputId} value={isRedacted(value) ? "" : typeof value === "string" ? value : ""} aria-invalid={invalid}
          placeholder={isRedacted(value) ? "•••••• stored (hidden) — type to replace" : field.placeholder ?? (typeof field.default === "string" ? field.default : undefined)}
          onChange={(e) => set(field.path, textValue(e.target.value))}
          className="max-w-[420px]" />
      );
  }

  return (
    <div className="space-y-1">
      {field.kind !== "boolean" && (
        <label htmlFor={inputId} className="block text-sm font-medium">{field.title}{field.required && <RequiredMark />}</label>
      )}
      {input}
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {hint && value === undefined && field.kind !== "select" && <p className="text-xs text-muted-foreground">{hint}</p>}
      {mine.map((m) => <p key={m} className="text-xs text-destructive">{m}</p>)}
    </div>
  );
}

function RequiredMark() {
  return <span className="ml-0.5 text-destructive" title="Required">*</span>;
}

/**
 * A `format: "env-var"` field: the variable's *name* (never its value), and
 * whether the daemon's environment has it — known for the saved name; a
 * changed one is checked once saved. A stored non-name (a pasted secret) is
 * hidden and must be replaced by a name.
 */
function EnvVarInput({ id, field, value, source, invalid, onChange }: {
  id: string;
  field: FormField;
  value: unknown;
  source: SourceView;
  invalid: boolean;
  onChange: (v: string | undefined) => void;
}) {
  const hidden = isRedacted(value);
  const state = envVarState(source, field.path, value);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input id={id} value={hidden ? "" : typeof value === "string" ? value : ""} aria-invalid={invalid || hidden}
          placeholder={hidden ? "A secret value is stored here — enter a variable name instead" : field.placeholder ?? (typeof field.default === "string" ? field.default : "ENV_VAR_NAME")}
          onChange={(e) => onChange(textValue(e.target.value.trim()))}
          className="max-w-[280px] font-mono text-xs" autoComplete="off" spellCheck={false} />
        {state === "set" && <Badge variant="outline" className={TONE_CLASS.ok}>set</Badge>}
        {state === "not-set" && <Badge variant="outline" className={TONE_CLASS.bad} title="The daemon's environment doesn't have it — set it where the daemon runs, then restart">not set</Badge>}
        {state === "unknown" && <Badge variant="outline" className={TONE_CLASS.neutral} title="Checked once saved">checked on save</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        Environment variable <em>name</em> — the daemon reads the secret from its environment; it's never stored or shown here.
      </p>
      {hidden && <p className="text-xs text-amber-600">config.json has a value here that isn't a variable name (a pasted secret?). Replace it with the variable's name.</p>}
    </div>
  );
}

/** Preview's answer: the items a sync would pull, warnings, or the error — and that nothing was created. */
function PreviewResult({ source, loading, preview }: { source: SourceView; loading: boolean; preview: SourcePreviewResponse | null }) {
  if (loading) return <p className="text-sm text-muted-foreground">Asking {source.label} what it would pull…</p>;
  if (!preview) return null;
  if (!preview.success) {
    return (
      <div className="rounded-md border border-red-500/40 p-3 text-sm">
        <p className="font-medium text-destructive">Preview failed</p>
        <p className="text-xs text-muted-foreground">{preview.fieldErrors?.length ? "Fix the highlighted settings and try again." : preview.error}</p>
      </div>
    );
  }
  const items = preview.items ?? [];
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="font-medium text-sm">{previewSummary(items)}</p>
        <p className="text-xs text-muted-foreground">
          Preview only — nothing was mirrored, queued, or saved{preview.via === "sync" ? " (ran its sync with these settings, side effects disabled)" : ""}.
        </p>
      </div>
      {preview.note && <p className="text-xs text-muted-foreground">{preview.note}</p>}
      {preview.warnings && preview.warnings.length > 0 && (
        <ul className="text-xs text-amber-600 list-disc pl-4">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-1 pr-3 font-medium">Title</th><th className="py-1 pr-3 font-medium">External ID</th><th className="py-1 pr-3 font-medium">Mode</th><th className="py-1 font-medium">Directory</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.externalId} className="border-t border-border align-top">
                  <td className="py-1 pr-3">
                    {item.url
                      ? <a href={item.url} target="_blank" rel="noreferrer" className="text-primary underline">{item.title}</a>
                      : item.title}
                  </td>
                  <td className="py-1 pr-3 font-mono">{item.externalId}</td>
                  <td className="py-1 pr-3">{previewItemMode(item, source) === "triage" ? "Triage" : "Work"}</td>
                  <td className="py-1 font-mono break-all">{item.directory ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * ConfigPage — Team configuration, as route-driven tabs (lib/config-tabs.ts;
 * the shared RouteTabs control, so each tab is deep-linkable and consistent
 * with the Board and Root page tabs):
 *
 * - **General** (`/config`) — the Work items feature toggles (the built-in
 *   kinds, listed from the server; external sources are switched on the
 *   Sources tab, linked from here), server, scheduling, autosave, and favorite
 *   directories (which save immediately via /api/directories/favorites).
 * - **Teammates** (`/config/teammates`) — name nouns, one-teammate-per-directory,
 *   experimental harnesses.
 * - **Sources** (`/config/sources`, a source's settings at
 *   `/config/sources/:id`) — Work Source plugins: on/off (incl. "Turn off and
 *   archive"), a settings form from each one's `configSchema`, Preview, and
 *   its own Save (components/sources/SourcesTab.tsx).
 * - **Workflows** (`/config/workflows`, detail `/config/workflows/:name`) — the
 *   WorkflowsPage / WorkflowDetailPage, embedded. Hidden (and refused with the
 *   "turned off" notice) while Stories are off: workflows only apply to stories.
 * - **Personas** (`/config/personas`, one persona at `/config/personas/:id`) —
 *   the persona library (PersonasPage, embedded; its own saves).
 * - **Triage** (`/config/triage`) — auto-triage settings and the persona note
 *   triage runs with (`triage.persona`), both saved with the page.
 * - **Theme** (`/config/theme`) — a client-side preference (localStorage,
 *   applied immediately) rather than daemon config.
 *
 * Every tab renders inside TabbedPageLayout, so the title and tab bar sit in
 * the same spot on each; narrow tabs cap the body at max-w-3xl, Sources,
 * Workflows and Personas at max-w-5xl (left-aligned, never centered).
 *
 * The global Save button only shows on the tabs that edit the config.json draft
 * (General, Teammates, Triage); Sources, Workflows and Personas keep their own save flows.
 * General's Assistant card also picks the assistant's persona, which applies at
 * once (`PUT /api/assistant/persona` ends the current chat), like the chips in
 * the chat itself.
 * The draft lives above the tabs and survives switching them (the `/config*`
 * routes share this element), so edits on several tabs save together.
 */

import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
import { notifyFeaturesChanged, useFeatures } from "@/hooks/useFeatures";
import { featuresChanged, featureToggleRows, type FeatureSourceInfo, type Features } from "@/lib/features";
import { configTabFromPath, tabSavesConfig, visibleConfigTabs } from "@/lib/config-tabs";
import { sourceIdFromConfigPath, SOURCES_TAB_PATH } from "@/lib/source-settings";
import { SourcesTab } from "@/components/sources/SourcesTab";
import { DirectoryInput } from "@/components/ui/directory-input";
import { FAVORITES_CHANGED_EVENT, notifyFavoritesChanged } from "@/lib/directories";
import { RouteTabs, SegmentedTabs } from "@/components/RouteTabs";
import { FeatureOffNotice } from "@/components/FeatureGate";
import { TabbedPageLayout } from "@/components/TabbedPageLayout";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { WorkflowDetailPage } from "@/pages/WorkflowDetailPage";
import { PersonasPage } from "@/pages/PersonasPage";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { personaIdFromConfigPath, PERSONAS_TAB_PATH } from "@/lib/personas";
import { PALETTES, getStoredPalette, applyPalette } from "@/lib/theme";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings, Plus, X, Save, Star } from "lucide-react";

interface TeammateConfig {
  nouns?: string[];
}

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, { states: string[] }>;
  autosave: { flushIntervalMinutes: number; commitIntervalHours: number; autoCommit: boolean };
  maxTeammates?: number;
  /** Unset = default (half of maxTeammates); `null` clears an explicit value on save. */
  minTeammates?: number | null;
  teammates?: TeammateConfig;
  defaultNouns?: string[];
  readinessProbe?: string;
  /** Auto triage (docs/DESIGN.md "Auto Triage"). Unset = on, hourly, 10 min quiet. */
  triage?: { enabled?: boolean; intervalMinutes?: number; quietMinutes?: number; persona?: string | null };
  /** Opt-ins for unfinished features. `harnesses` allows non-Pi (ACP) teammates. */
  experimental?: { harnesses?: boolean };
  /** Harness spawned when a spawn names none. Unset (or "pi") = Pi. */
  defaultHarness?: string;
  /** Custom harness templates from config.json (read-only here; adds to the picker). */
  harnesses?: Record<string, { teammate: string; leader?: string }>;
  /** How the user talks to the assistant. Unset (or unknown) chatMode = "chat". */
  assistant?: { chatMode?: "chat" | "terminal"; persona?: string };
  /** One teammate per directory (exclusive directory leases). Unset = on. */
  exclusiveDirectories?: boolean;
  /** Which work-item kinds are on, defaults applied (docs/DESIGN.md "Feature Toggles"). */
  features?: Features;
  /** Read-only: each kind's active items, which block switching it off. */
  featureUsage?: Record<string, { count: number; description: string }>;
  /** Read-only: each toggle's source, label, and whether it's external (in display order). */
  featureSources?: FeatureSourceInfo[];
}

export function ConfigPage() {
  const { pathname } = useLocation();
  const activeTab = configTabFromPath(pathname);
  const features = useFeatures();
  const tabs = visibleConfigTabs(features);

  // The config.json draft lives here, above the tabs, so an edit on one tab
  // (General, Teammates, Triage) is still in the draft after visiting another.
  const { data, loading, refetch } = useApi<ConfigData>("/api/config");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  // A refused feature toggle (409 "Can't turn off …") is also shown in its section.
  const [featureError, setFeatureError] = useState<string | null>(null);

  // Seed the editable draft from the fetched config. Adjusting state during
  // render (guarded by a "last seeded" marker) is React's recommended pattern
  // for deriving state from external data — no effect, no cascading render.
  const [seededFrom, setSeededFrom] = useState<ConfigData | null>(null);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setConfig(structuredClone(data));
  }

  const showToast = (msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setFeatureError(null);
    try {
      // The PUT re-saves every workflow it carries, and the draft's copy may be
      // stale: the Workflows tab edits them through its own saves while this
      // draft lives on. So send the daemon's current workflows, not the draft's.
      const current = await fetch("/api/config").then((r) => r.json() as Promise<ConfigData>);
      const res = await apiPut<{ success: boolean; error?: string }>(
        "/api/config",
        { ...configBody(config, data), workflows: current.workflows },
      );
      if (res.success) {
        showToast("✓ Configuration saved");
        refetch();
        notifyFeaturesChanged();
      } else {
        showToast(res.error || "Save failed", true);
        if (res.error && /turn off|feature/i.test(res.error)) setFeatureError(res.error);
      }
    } catch (e) {
      showToast("Network error: " + (e as Error).message, true);
    }
    setSaving(false);
  };

  // Workflows, Personas and Sources bring their own data and layout, and are
  // wider (pipelines, two-column cards) than the config forms.
  const wide = activeTab === "workflows" || activeTab === "personas" || activeTab === "sources";

  let content;
  if (activeTab === "workflows") {
    // Workflows only apply to stories (docs/DESIGN.md "Feature Toggles").
    if (!features) content = null;
    else if (!features.stories) content = <FeatureOffNotice feature="stories" embedded />;
    // Second segment is the tab; a third is the workflow's name.
    // Keyed by the name, so switching workflows never shows the last one's data.
    else {
      const workflowName = pathname.split("/").filter(Boolean)[2];
      content = workflowName ? <WorkflowDetailPage key={workflowName} /> : <WorkflowsPage />;
    }
  } else if (activeTab === "personas") {
    content = <PersonasPage personaId={personaIdFromConfigPath(pathname)} />;
  } else if (activeTab === "sources") {
    content = (
      <SourcesTab
        selectedId={sourceIdFromConfigPath(pathname)}
        // The daemon saved the toggle: mirror it into the draft (without
        // refetching, which would drop unsaved edits on the other tabs).
        onFeatureApplied={(feature, on) => setConfig((c) => c && { ...c, features: { ...c.features, [feature]: on } as Features })}
      />
    );
  } else if (activeTab === "theme") {
    content = <ThemeTab />;
  } else if (!config) {
    // `config` is the draft seeded from the first answer, so this shows only
    // before it; a refetch never blanks a loaded tab.
    content = <div className="text-muted-foreground">{loading ? "Loading..." : "Cannot load config."}</div>;
  } else if (activeTab === "teammates") {
    content = <TeammatesTab config={config} setConfig={setConfig} />;
  } else if (activeTab === "triage") {
    content = <TriageSettings config={config} setConfig={setConfig} />;
  } else {
    content = <GeneralTab config={config} setConfig={setConfig} saved={data} featureError={featureError} />;
  }

  return (
    // The shared frame pins the title + tab bar upper-left on every tab; only
    // the (left-aligned) body's max width varies.
    <TabbedPageLayout
      icon={<Settings className="h-5 w-5" />}
      title="Configuration"
      bodyClassName={wide ? "max-w-5xl" : "max-w-3xl"}
      tabs={
        // Route-driven; the Workflows tab stays lit on a workflow's detail.
        <RouteTabs
          tabs={tabs.map((t) => ({
            path: t.path,
            label: t.label,
            isActive: (p: string) => configTabFromPath(p) === t.tab,
          }))}
        />
      }
    >
      {content}

      {/* Save bar: only on tabs that edit the daemon config (lib/config-tabs.ts). */}
      {config && tabSavesConfig(activeTab) && (
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
          {toast && (
            <span className={`text-sm ${toast.error ? "text-destructive" : "text-green-600 dark:text-green-400"}`}>
              {toast.msg}
            </span>
          )}
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            <Save className="h-4 w-4" />
            {saving ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      )}
    </TabbedPageLayout>
  );
}

/**
 * The PUT body for a draft: drops the read-only `featureUsage` and
 * `featureSources`, and sends `features` only when a toggle changed — so
 * saving an unrelated field doesn't write a `features` block into an existing
 * team's config.json (absent = all on).
 */
function configBody(draft: ConfigData, saved: ConfigData | null): ConfigData {
  const body = { ...draft };
  delete body.featureUsage;
  delete body.featureSources;
  if (!featuresChanged(draft.features, saved?.features)) delete body.features;
  return body;
}

// --- General Tab ---

function GeneralTab({ config, setConfig, saved, featureError }: {
  config: ConfigData;
  setConfig: (c: ConfigData) => void;
  saved: ConfigData | null;
  featureError: string | null;
}) {
  const update = (field: string, value: unknown) => {
    setConfig({ ...config, [field]: value });
  };
  // Fetched on mount (not read from the draft) so a workflow just created on
  // the Workflows tab is offered here without reloading the page.
  const { data: workflowList } = useApi<Array<{ name: string }>>("/api/workflows");
  const workflowNames = workflowList?.map((w) => w.name) ?? Object.keys(config.workflows);

  return (
    <div className="space-y-4">
      <WorkItemFeatures config={config} setConfig={setConfig} saved={saved} error={featureError} />

      <AssistantChatModeSetting config={config} setConfig={setConfig} />

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Server</h2>
          <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
            <Label>Port</Label>
            <Input type="number" value={config.port} onChange={(e) => update("port", parseInt(e.target.value) || 9999)} className="max-w-[120px]" />
            <Label>Tmux Session</Label>
            <Input value={config.tmuxSession} onChange={(e) => update("tmuxSession", e.target.value)} className="max-w-[200px]" />
            <Label>Max Teammates</Label>
            <Input type="number" value={config.maxTeammates ?? 4} onChange={(e) => update("maxTeammates", parseInt(e.target.value) || 4)} className="max-w-[120px]" />
            {/* The declared pool size, applied at startup and reconciled
                continuously. Also editable live from the sidebar's team-size
                dialog. Blank = the default (half of Max Teammates), sent as
                `null` so saving clears an explicit value. */}
            <Label>Min Teammates</Label>
            <div className="space-y-1">
              <Input
                type="number"
                min={0}
                value={config.minTeammates ?? ""}
                placeholder={`${Math.floor((config.maxTeammates ?? 4) / 2)} (default)`}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  update("minTeammates", e.target.value === "" || Number.isNaN(n) ? null : Math.max(0, n));
                }}
                className="max-w-[160px]"
              />
              <p className="text-xs text-muted-foreground">
                Teammates the daemon keeps online (spawning replacements as needed). Blank = half of Max Teammates; 0 spawns none.
              </p>
            </div>
            <Label>Default Workflow</Label>
            <Select value={config.defaultWorkflow} onValueChange={(v) => update("defaultWorkflow", v)}>
              <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {workflowNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Scheduling</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label>Readiness Probe</Label>
            <Input
              value={config.readinessProbe || ""}
              onChange={(e) => update("readinessProbe", e.target.value || undefined)}
              placeholder="e.g. /path/to/check-creds.sh"
              className="max-w-[400px] font-mono text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Shell command run by the leader each heartbeat. Exit 0 = ready; non-zero = not ready (stdout = reason).
            Scheduled work is held while the host is not ready, then fires once on recovery.
          </p>
        </CardContent>
      </Card>

      {/* Favorites save immediately (own endpoint), not with the Save button. */}
      <FavoriteDirectories />

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Autosave</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label>Flush Interval (min)</Label>
            <Input
              type="number"
              value={config.autosave.flushIntervalMinutes}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, flushIntervalMinutes: parseInt(e.target.value) || 30 } })}
              className="max-w-[120px]"
            />
            <Label>Commit Interval (hrs)</Label>
            <Input
              type="number"
              value={config.autosave.commitIntervalHours}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, commitIntervalHours: parseInt(e.target.value) || 24 } })}
              className="max-w-[120px]"
            />
            <Label>Auto Commit</Label>
            <Select
              value={config.autosave.autoCommit ? "true" : "false"}
              onValueChange={(v) => setConfig({ ...config, autosave: { ...config.autosave, autoCommit: v === "true" } })}
            >
              <SelectTrigger className="max-w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Work items: feature toggles (docs/DESIGN.md "Feature Toggles") ---

/**
 * Switch the Stories, Tasks (incl. Templates), and Schedules kinds on or off,
 * saved with the page. The list comes from the server (`featureSources` from
 * GET /api/config). A kind that's on and still has active items can't be
 * switched off — the daemon would refuse (409) — so its checkbox is disabled
 * with what to archive or delete first (`featureUsage`). A refusal that slips
 * through shows as `error`.
 *
 * External Work Sources are switched on the **Sources** tab instead (applied at
 * once there, with its "Turn off and archive N items" disconnect), so there's
 * one control per source; this card links there. A non-external plugin toggle
 * (rare: an in-daemon source declaring `toggle`) stays here.
 */
function WorkItemFeatures({ config, setConfig, saved, error }: {
  config: ConfigData;
  setConfig: (c: ConfigData) => void;
  saved: ConfigData | null;
  error: string | null;
}) {
  const features: Features = { stories: true, tasks: true, schedules: true, ...config.features };
  const set = (name: string, on: boolean) => setConfig({ ...config, features: { ...features, [name]: on } });
  const all = featureToggleRows(config.featureSources);
  const rows = all.filter((r) => !r.external);
  const external = all.filter((r) => r.external);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Work items</h2>
        <p className="text-xs text-muted-foreground">
          The kinds of work your team uses. A kind that's off disappears from the nav and the quick-create menu,
          and its pages, API, CLI and assistant tools are refused. Thoughts, Personas and the Inbox are always on.
          Takes effect as soon as you save.
        </p>
        <div className="space-y-2">
          {rows.map((row) => {
            const name = row.feature;
            const on = features[name] !== false;
            const usage = config.featureUsage?.[name];
            // Only a kind that's on (as saved) and still in use is locked on.
            const locked = saved?.features?.[name] !== false && on && (usage?.count ?? 0) > 0;
            return (
              <div key={name} className="space-y-0.5">
                <label className={`flex items-center gap-2 text-sm ${locked ? "opacity-70" : ""}`}>
                  <input
                    id={`feature-${name}`}
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={(e) => set(name, e.target.checked)}
                  />
                  <span className="font-medium">{row.label}</span>
                  <span className="text-xs text-muted-foreground">{row.description}</span>
                </label>
                {locked && usage && (
                  <p className="pl-6 text-xs text-muted-foreground">
                    To turn {row.label} off, archive or delete {usage.description} first.
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {external.length > 0
            ? <>External sources ({external.map((r) => r.label).join(", ")}) are switched on and off, and set up, on the{" "}</>
            : <>Work Source plugins are switched on and off, and set up, on the{" "}</>}
          <Link to={SOURCES_TAB_PATH} className="text-primary underline">Sources</Link> tab.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// --- Auto triage (docs/DESIGN.md "Auto Triage") ---

/**
 * The Triage tab: the sweep's settings and the persona every note-triage run
 * follows (`triage.persona`; unset = `builtin:triage`), all saved with the
 * page's Save button. The persona itself is edited on Config → Personas (the
 * picker's "edit"/"view" link); this only picks which one. Triage-mode *Work
 * Sources* pick their own triage persona on Config → Sources — this one is for
 * your notes only.
 */
function TriageSettings({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const t = config.triage ?? {};
  const enabled = t.enabled !== false;
  const setTriage = (patch: Partial<NonNullable<ConfigData["triage"]>>) =>
    setConfig({ ...config, triage: { ...t, ...patch } });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 className="font-semibold">Auto Triage</h2>
        <p className="text-xs text-muted-foreground">
          A teammate reads each note whose text you've changed and comments with an analysis,
          leaning toward work worth creating. Finished runs land in your Inbox; a badge on the
          note opens its triage page.
        </p>
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
          <Label htmlFor="triage-enabled">Enabled</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              id="triage-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setTriage({ enabled: e.target.checked })}
            />
            Read changed notes and propose work
          </label>
          <Label>Sweep Interval (min)</Label>
          <div className="space-y-1">
            <Input
              type="number"
              min={1}
              value={t.intervalMinutes ?? 60}
              onChange={(e) => setTriage({ intervalMinutes: Math.max(1, parseInt(e.target.value) || 60) })}
              className="max-w-[120px]"
            />
            <p className="text-xs text-muted-foreground">Takes effect when the daemon restarts.</p>
          </div>
          <Label>Quiet Period (min)</Label>
          <div className="space-y-1">
            <Input
              type="number"
              min={0}
              value={t.quietMinutes ?? 10}
              onChange={(e) => setTriage({ quietMinutes: Math.max(0, parseInt(e.target.value) || 0) })}
              className="max-w-[120px]"
            />
            <p className="text-xs text-muted-foreground">
              How long a note is left alone after your last edit, so a half-written thought isn't read.
            </p>
          </div>
          <Label htmlFor="triage-persona">Persona</Label>
          <div className="space-y-1">
            <PersonaPicker
              id="triage-persona"
              kind="triage"
              value={t.persona ?? null}
              // null (not undefined) so the PUT carries the clear back to the built-in.
              onChange={(persona) => setTriage({ persona })}
              noneLabel="Built-in triage (default)"
              exclude={["builtin:triage"]}
            />
            <p className="text-xs text-muted-foreground">
              What every note-triage run is told, before the note itself. Write or customize one on{" "}
              <Link to={PERSONAS_TAB_PATH} className="text-primary underline">Personas</Link> (duplicate the built-in to start from it).
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Favorite directories (docs/DESIGN.md "Favorite Directories") ---

/**
 * The team's favorite directories, offered first by every directory picker.
 * Edits apply immediately through `/api/directories/favorites` rather than
 * riding the page's Save button, so a star clicked in some picker meanwhile is
 * never overwritten by this page's stale draft.
 */
function FavoriteDirectories() {
  const { data, refetch } = useApi<{ favorites: string[] }>("/api/directories");
  const favorites = data?.favorites ?? [];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Stars clicked in the picker below change the list too.
  useEffect(() => {
    const handler = () => { refetch(); };
    globalThis.addEventListener(FAVORITES_CHANGED_EVENT, handler);
    return () => globalThis.removeEventListener(FAVORITES_CHANGED_EVENT, handler);
  }, [refetch]);

  const add = async () => {
    if (!draft.trim()) return;
    const res = await apiPost<{ success: boolean; error?: string }>("/api/directories/favorites", { directory: draft.trim() });
    if (res.success) { setDraft(""); setError(null); notifyFavoritesChanged(); } else setError(res.error || "Could not add");
  };
  const remove = async (dir: string) => {
    await apiDelete(`/api/directories/favorites?directory=${encodeURIComponent(dir)}`);
    notifyFavoritesChanged();
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><Star className="h-4 w-4" /> Favorite Directories</h2>
        <p className="text-xs text-muted-foreground">
          Listed first in every directory picker (new story, task, template, Spawn…), ahead of recently
          used directories. You can also star a directory right in a picker. Paths are stored resolved
          (<code>~</code> expanded, symlinks followed). Changes save immediately.
        </p>
        {favorites.length === 0 && <p className="text-xs text-muted-foreground italic">No favorites yet.</p>}
        <ul className="space-y-1">
          {favorites.map((d) => (
            <li key={d} className="flex items-center justify-between gap-2 text-sm font-mono">
              <span className="truncate">{d}</span>
              <button onClick={() => remove(d)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${d}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 items-start">
          <div className="flex-1" onKeyDown={(e) => e.key === "Enter" && add()}>
            <DirectoryInput id="favorite-directory" value={draft} onChange={setDraft} placeholder="Add a directory..." />
          </div>
          <Button variant="outline" size="sm" onClick={add}><Plus className="h-3.5 w-3.5" /></Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// --- Teammates Tab ---

function TeammatesTab({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const [newNoun, setNewNoun] = useState("");
  const teammates = config.teammates || {};
  const nouns = teammates.nouns || [];

  const addNoun = () => {
    const val = newNoun.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "");
    if (!val || nouns.includes(val)) return;
    setConfig({ ...config, teammates: { ...teammates, nouns: [...nouns, val] } });
    setNewNoun("");
  };

  const removeNoun = (noun: string) => {
    const updated = nouns.filter((n) => n !== noun);
    setConfig({ ...config, teammates: { ...teammates, nouns: updated.length > 0 ? updated : undefined } });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Name Nouns</h2>
          <p className="text-xs text-muted-foreground">Custom nouns for auto-generated teammate names (adjective-noun). Leave empty for sci-fi character defaults.</p>
          <div className="flex gap-1 flex-wrap">
            {nouns.map((n) => (
              <Badge key={n} variant="secondary" className="gap-1">
                {n}
                <button onClick={() => removeNoun(n)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
              </Badge>
            ))}
            {nouns.length === 0 && (config.defaultNouns || []).map((n) => (
              <Badge key={n} variant="outline" className="text-muted-foreground">{n}</Badge>
            ))}
          </div>
          {nouns.length === 0 && <p className="text-xs text-muted-foreground italic">Showing built-in defaults. Add a noun to use a custom list instead.</p>}
          <div className="flex gap-2">
            <Input placeholder="Add a noun..." value={newNoun} onChange={(e) => setNewNoun(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNoun()} className="max-w-[200px]" />
            <Button variant="outline" size="sm" onClick={addNoun}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>

      <ExclusiveDirectories config={config} setConfig={setConfig} />

      <ExperimentalHarnesses config={config} setConfig={setConfig} />
    </div>
  );
}

// --- Assistant chat mode (docs/DESIGN.md "Assistant Chat Model") ---

/**
 * The `assistant.chatMode` picker: iMessage-style bubbles (default) or the same
 * terminal transcript and composer used to watch and pair with a teammate.
 * Applies live once saved — the leader picks up the matching system prompt on
 * its next run, with no restart and no new session.
 */
function AssistantChatModeSetting({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const mode = config.assistant?.chatMode === "terminal" ? "terminal" : "chat";
  const set = (chatMode: "chat" | "terminal") => setConfig({ ...config, assistant: { ...config.assistant, chatMode } });
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Assistant</h2>
        <p className="text-xs text-muted-foreground">
          How you talk to the assistant: a chat with message bubbles, or a terminal view of its session —
          the same view you get when you watch and pair with a teammate.
        </p>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="assistant-chat-mode" id="assistant-chat-mode-chat"
              checked={mode === "chat"} onChange={() => set("chat")} />
            Chat (bubbles)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="assistant-chat-mode" id="assistant-chat-mode-terminal"
              checked={mode === "terminal"} onChange={() => set("terminal")} />
            Terminal (like watching a teammate)
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save: the assistant's next reply follows the new style. The current
          conversation carries on — no restart or new chat needed.
        </p>
        <AssistantPersonaSetting />
      </CardContent>
    </Card>
  );
}

/**
 * Who the assistant is: its persona (`assistant.persona`; unset =
 * `builtin:assistant`). Unlike the rest of the card this applies at once —
 * `PUT /api/assistant/persona` ends the current chat (it stays in the session
 * history) and starts a new one, as picking a chip in the chat does.
 */
function AssistantPersonaSetting() {
  const { data, refetch } = useApi<{ personaId: string | null }>("/api/assistant/persona");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (personaId: string | null) => {
    if (busy || personaId === (data?.personaId ?? null)) return;
    if (!confirm("Switching the assistant's persona ends the current chat (it stays in the history) and starts a new one. Switch?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPut<{ success: boolean; error?: string }>("/api/assistant/persona", { personaId });
      if (!res.success) setError(res.error || "Couldn't switch it");
      await refetch();
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1 border-t border-border pt-3">
      <Label htmlFor="assistant-persona">Persona</Label>
      <PersonaPicker
        id="assistant-persona"
        kind="assistant"
        value={data?.personaId ?? null}
        onChange={pick}
        noneLabel="Built-in assistant (default)"
        exclude={["builtin:assistant"]}
        disabled={busy || !data}
      />
      <p className="text-xs text-muted-foreground">Applies at once: a new chat starts with the chosen persona.</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// --- Exclusive directories (docs/DESIGN.md "Work Matching: Directory Affinity") ---

/**
 * The `exclusiveDirectories` toggle: while a WorkItem with a directory is in
 * flight, overlapping work waits. Default on (unset reads as checked); applies
 * live once saved.
 */
function ExclusiveDirectories({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const enabled = config.exclusiveDirectories !== false;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Directories</h2>
        <p className="text-xs text-muted-foreground">
          While a piece of work runs in a directory, other work for that directory (or a folder inside
          it, or one containing it) waits in the queue, so two teammates never edit and commit in the
          same checkout at once. Work with no directory always runs in parallel.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            id="exclusive-directories"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setConfig({ ...config, exclusiveDirectories: e.target.checked })}
          />
          One teammate per directory
        </label>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save. A stuck <em>At risk</em> item keeps its directory until you
          force-fail it on the Queue page.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Experimental harnesses (docs/DESIGN.md "Harness Tiers, and Why Not MCP") ---

/** Built-in harnesses, Pi first; config.json may add custom ones (`harnesses.*`). */
const BUILT_IN_HARNESSES: Array<{ value: string; label: string }> = [
  { value: "pi", label: "Pi" },
  { value: "kiro", label: "Kiro (experimental)" },
  { value: "claude", label: "Claude Code (experimental)" },
];

/**
 * The `experimental.harnesses` opt-in and the default harness, saved with the rest
 * of the page. Turning the opt-in off resets the default to Pi in the draft, since
 * the daemon refuses to save (or spawn with) a non-Pi default without the opt-in.
 * Both apply live — the PUT updates the daemon's in-memory config.
 */
function ExperimentalHarnesses({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const enabled = !!config.experimental?.harnesses;
  const current = config.defaultHarness || "pi";
  const custom = Object.keys(config.harnesses ?? {})
    .filter((h) => !BUILT_IN_HARNESSES.some((b) => b.value === h) && config.harnesses?.[h]?.teammate)
    .map((h) => ({ value: h, label: `${h} (custom)` }));
  const options = [...BUILT_IN_HARNESSES, ...custom];

  const setEnabled = (on: boolean) =>
    setConfig({
      ...config,
      experimental: { ...config.experimental, harnesses: on },
      // "pi" (not undefined) so the PUT carries the reset; the daemon stores it as unset.
      ...(on ? {} : { defaultHarness: "pi" }),
    });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Experimental Harnesses</h2>
        <p className="text-xs text-muted-foreground">
          Lets you spawn Kiro and Claude Code teammates, run by <code>mpt agent</code> over the Agent
          Client Protocol. Each harness needs <code>mpt setup --harness &lt;h&gt;</code> (e.g.{" "}
          <code>mpt setup --harness kiro</code>) on this machine first. Teammates only — they can't lead yet.
        </p>
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
          <Label htmlFor="experimental-harnesses">Enabled</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              id="experimental-harnesses"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Allow non-Pi teammates (adds a Harness picker to the Spawn dialog)
          </label>
          <Label htmlFor="default-harness">Default Harness</Label>
          <div className="space-y-1">
            <select
              id="default-harness"
              value={current}
              disabled={!enabled}
              onChange={(e) => setConfig({ ...config, defaultHarness: e.target.value })}
              className="h-9 max-w-[260px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              Used for spawns that don't pick a harness — including the teammates the daemon keeps
              online. {enabled ? "" : "Pi while experimental harnesses are off."}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save — no daemon restart. Teammates already running keep their harness.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Theme Tab ---
//
// Client-side preference (localStorage + the data-theme attribute on <html>),
// applied immediately — not part of the daemon config, so no Save button.
// Light/dark mode stays on the NavBar toggle; this picks the palette.

function ThemeTab() {
  const [palette, setPalette] = useState(getStoredPalette);

  const select = (key: string | null) => {
    const value = key ?? "";
    setPalette(value);
    applyPalette(value);
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Palette</h2>
        <p className="text-xs text-muted-foreground">
          Colors for the whole UI, in both light and dark mode (use the sun/moon toggle in the
          top bar to switch modes). Applied immediately and remembered in this browser.
        </p>
        <SegmentedTabs
          tabs={PALETTES.map(p => ({ key: p.value, label: p.label }))}
          active={palette}
          onSelect={select}
        />
      </CardContent>
    </Card>
  );
}


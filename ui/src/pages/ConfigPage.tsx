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
 *
 * Each tab's cards live in components/config/ (GeneralTab, TeammatesTab,
 * TriageSettings, ThemeTab); the draft's shape and PUT body in
 * lib/config-draft.ts.
 */

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useApi, apiPut } from "@/hooks/useApi";
import { notifyFeaturesChanged, useFeatures } from "@/hooks/useFeatures";
import type { Features } from "@/lib/features";
import { configBody, type ConfigData } from "@/lib/config-draft";
import { configTabFromPath, tabSavesConfig, visibleConfigTabs } from "@/lib/config-tabs";
import { sourceIdFromConfigPath } from "@/lib/source-settings";
import { SourcesTab } from "@/components/sources/SourcesTab";
import { GeneralTab } from "@/components/config/GeneralTab";
import { TeammatesTab } from "@/components/config/TeammatesTab";
import { TriageSettings } from "@/components/config/TriageSettings";
import { ThemeTab } from "@/components/config/ThemeTab";
import { RouteTabs } from "@/components/RouteTabs";
import { FeatureOffNotice } from "@/components/FeatureGate";
import { TabbedPageLayout } from "@/components/TabbedPageLayout";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { WorkflowDetailPage } from "@/pages/WorkflowDetailPage";
import { PersonasPage } from "@/pages/PersonasPage";
import { personaIdFromConfigPath } from "@/lib/personas";
import { Button } from "@/components/ui/button";
import { Settings, Save } from "lucide-react";

/** The Configuration page: the tab bar, the config.json draft, and the shared Save bar. */
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
          label="Configuration sections"
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
            <span className={`text-sm ${toast.error ? "text-destructive" : "text-green-700 dark:text-green-400"}`}>
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

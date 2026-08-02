/**
 * ConfigPage — Edit daemon configuration with tabs for General, Teammates,
 * and Theme. Tabs are route-driven (`/config`, `/config/teammates`,
 * `/config/theme`) via the
 * shared RouteTabs control, so each tab is deep-linkable and consistent with
 * the Board and Root page tabs. The Theme tab is a client-side preference
 * (localStorage, applied immediately) rather than daemon config.
 */

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useApi, apiPut } from "@/hooks/useApi";
import { RouteTabs, SegmentedTabs } from "@/components/RouteTabs";
import { PALETTES, getStoredPalette, applyPalette } from "@/lib/theme";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings, Plus, X, Save } from "lucide-react";

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
  teammates?: TeammateConfig;
  defaultNouns?: string[];
}

type Tab = "general" | "teammates" | "theme";

const TABS = [
  { path: "/config", label: "General" },
  { path: "/config/teammates", label: "Teammates" },
  { path: "/config/theme", label: "Theme" },
];

/** Resolve the active tab from the current pathname (unknown → general). */
function tabFromPath(pathname: string): Tab {
  if (pathname === "/config/teammates") return "teammates";
  if (pathname === "/config/theme") return "theme";
  return "general";
}

export function ConfigPage() {
  const { data, loading, refetch } = useApi<ConfigData>("/api/config");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const activeTab = tabFromPath(useLocation().pathname);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  // Seed the editable draft from the fetched config. Adjusting state during
  // render (guarded by a "last seeded" marker) is React's recommended pattern
  // for deriving state from external data — no effect, no cascading render.
  const [seededFrom, setSeededFrom] = useState<ConfigData | null>(null);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setConfig(structuredClone(data));
  }

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!config) return <div className="container mx-auto p-6 text-muted-foreground">Cannot load config.</div>;

  const showToast = (msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", config);
      if (res.success) {
        showToast("✓ Configuration saved");
        refetch();
      } else {
        showToast(res.error || "Save failed", true);
      }
    } catch (e) {
      showToast("Network error: " + (e as Error).message, true);
    }
    setSaving(false);
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Configuration</h1>
      </div>

      {/* Tab bar (route-driven) */}
      <RouteTabs tabs={TABS} />

      {/* Tab content */}
      {activeTab === "general" && <GeneralTab config={config} setConfig={setConfig} />}
      {activeTab === "teammates" && <TeammatesTab config={config} setConfig={setConfig} />}
      {activeTab === "theme" && <ThemeTab />}

      {/* Save bar (theme is client-side and applies immediately — no save) */}
      {activeTab !== "theme" && (
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
    </div>
  );
}

// --- General Tab ---

function GeneralTab({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const update = (field: string, value: unknown) => {
    setConfig({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
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
            <Label>Default Workflow</Label>
            <Select value={config.defaultWorkflow} onValueChange={(v) => update("defaultWorkflow", v)}>
              <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(config.workflows).map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

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
    </div>
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


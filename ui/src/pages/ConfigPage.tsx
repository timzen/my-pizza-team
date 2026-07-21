/**
 * ConfigPage — Edit daemon configuration with tabs for General, Teammates,
 * Categories, and Workflows. Mirrors functionality from the legacy HTML config page.
 */

import { useState, useEffect } from "react";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
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

type Tab = "general" | "teammates" | "capabilities";

export function ConfigPage() {
  const { data, loading, refetch } = useApi<ConfigData>("/api/config");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (data) setConfig(structuredClone(data));
  }, [data]);

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

  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "teammates", label: "Teammates" },
    { id: "capabilities", label: "Capabilities" },
  ];

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Configuration</h1>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "general" && <GeneralTab config={config} setConfig={setConfig} />}
      {activeTab === "teammates" && <TeammatesTab config={config} setConfig={setConfig} />}
      {activeTab === "capabilities" && <CapabilitiesTab />}

      {/* Save bar */}
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

// --- Capabilities Tab ---
//
// Recently used capabilities (name -> known values) are auto-populated from
// story requirements and agent registrations, and edited here via the live
// /api/capabilities endpoints (applied immediately, not via the Save button).

function CapabilitiesTab() {
  const { data, refetch } = useApi<{ capabilities: Record<string, string[]> }>("/api/capabilities");
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const caps = data?.capabilities || {};
  const names = Object.keys(caps).sort();

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    await apiPost("/api/capabilities", { name, value: newValue.trim() || undefined });
    setNewName(""); setNewValue("");
    refetch();
  };

  const removeKey = async (name: string) => {
    await apiDelete(`/api/capabilities/${encodeURIComponent(name)}`);
    refetch();
  };

  const removeValue = async (name: string, value: string) => {
    await apiDelete(`/api/capabilities/${encodeURIComponent(name)}?value=${encodeURIComponent(value)}`);
    refetch();
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Recent Capabilities</h2>
        <p className="text-xs text-muted-foreground">
          Capability names and their known values, used to suggest story requirements and agent capabilities.
          Auto-updated from stories and agent registrations.
        </p>
        <div className="space-y-2">
          {names.map((name) => (
            <div key={name} className="flex items-start gap-2">
              <Badge variant="secondary" className="gap-1 shrink-0">
                {name}
                <button onClick={() => removeKey(name)} className="hover:text-destructive" title="Remove capability"><X className="h-3 w-3" /></button>
              </Badge>
              <div className="flex flex-wrap gap-1 flex-1">
                {caps[name]!.length === 0 && <span className="text-xs text-muted-foreground italic">presence-only</span>}
                {caps[name]!.map((v) => (
                  <Badge key={v} variant="outline" className="gap-1 font-mono text-xs">
                    {v}
                    <button onClick={() => removeValue(name, v)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          {names.length === 0 && <span className="text-xs text-muted-foreground italic">No capabilities recorded yet</span>}
        </div>
        <div className="flex gap-2 pt-1">
          <Input placeholder="name (e.g. python)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="max-w-[180px]" />
          <Input placeholder="value (optional)" value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="flex-1" />
          <Button variant="outline" size="sm" onClick={add}><Plus className="h-3.5 w-3.5" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}


/**
 * ConfigPage — Edit daemon configuration with tabs for General, Teammates,
 * Categories, and Workflows. Mirrors functionality from the legacy HTML config page.
 */

import { useState, useEffect } from "react";
import { useApi, apiPut } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings, Plus, X, Save } from "lucide-react";

interface WorkflowData {
  states: string[];
  transitions: Record<string, Record<string, string>>;
  categories?: string[];
}

interface TeammateConfig {
  nouns?: string[];
  favoriteDirectories?: string[];
}

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, WorkflowData>;
  autosave: { flushIntervalMinutes: number; commitIntervalHours: number; autoCommit: boolean };
  maxTeammates?: number;
  categories?: string[];
  teammates?: TeammateConfig;
}

type Tab = "general" | "teammates" | "categories" | "workflows";

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
    { id: "categories", label: "Categories" },
    { id: "workflows", label: "Workflows" },
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
      {activeTab === "categories" && <CategoriesTab config={config} setConfig={setConfig} />}
      {activeTab === "workflows" && <WorkflowsTab config={config} setConfig={setConfig} />}

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
  const [newDir, setNewDir] = useState("");
  const teammates = config.teammates || {};
  const nouns = teammates.nouns || [];
  const favDirs = teammates.favoriteDirectories || [];

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

  const addDir = () => {
    const val = newDir.trim();
    if (!val || favDirs.includes(val)) return;
    setConfig({ ...config, teammates: { ...teammates, favoriteDirectories: [...favDirs, val] } });
    setNewDir("");
  };

  const removeDir = (index: number) => {
    const updated = favDirs.filter((_, i) => i !== index);
    setConfig({ ...config, teammates: { ...teammates, favoriteDirectories: updated.length > 0 ? updated : undefined } });
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
            {nouns.length === 0 && <span className="text-xs text-muted-foreground italic">Using defaults</span>}
          </div>
          <div className="flex gap-2">
            <Input placeholder="Add a noun..." value={newNoun} onChange={(e) => setNewNoun(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNoun()} className="max-w-[200px]" />
            <Button variant="outline" size="sm" onClick={addNoun}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Favorite Directories</h2>
          <p className="text-xs text-muted-foreground">Quick-pick directories when spawning teammates.</p>
          <div className="space-y-2">
            {favDirs.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">{d}</code>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeDir(i)}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            {favDirs.length === 0 && <span className="text-xs text-muted-foreground italic">No favorites configured</span>}
          </div>
          <div className="flex gap-2">
            <Input placeholder="~/Workspace/my-project" value={newDir} onChange={(e) => setNewDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addDir()} className="flex-1" />
            <Button variant="outline" size="sm" onClick={addDir}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Categories Tab ---

function CategoriesTab({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const [newCat, setNewCat] = useState("");
  const categories = config.categories || [];

  const addCategory = () => {
    const val = newCat.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "");
    if (!val || categories.includes(val)) return;
    setConfig({ ...config, categories: [...categories, val] });
    setNewCat("");
  };

  const removeCategory = (cat: string) => {
    setConfig({ ...config, categories: categories.filter((c) => c !== cat) });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Memory Categories</h2>
        <p className="text-xs text-muted-foreground">Categories for organizing memories in the knowledge base. Memories can be tagged with one or more categories for targeted search.</p>
        <div className="flex gap-1 flex-wrap">
          {categories.map((c) => (
            <Badge key={c} variant="secondary" className="gap-1">
              {c}
              <button onClick={() => removeCategory(c)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
            </Badge>
          ))}
          {categories.length === 0 && <span className="text-xs text-muted-foreground italic">No categories configured</span>}
        </div>
        <div className="flex gap-2">
          <Input placeholder="e.g. architecture" value={newCat} onChange={(e) => setNewCat(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCategory()} className="max-w-[200px]" />
          <Button variant="outline" size="sm" onClick={addCategory}><Plus className="h-3.5 w-3.5" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Workflows Tab ---

function WorkflowsTab({ config, setConfig }: { config: ConfigData; setConfig: (c: ConfigData) => void }) {
  const [newWfName, setNewWfName] = useState("");

  const addWorkflow = () => {
    const name = newWfName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "");
    if (!name || config.workflows[name]) return;
    setConfig({
      ...config,
      workflows: { ...config.workflows, [name]: { states: ["todo", "done"], transitions: { todo: { done: "any" } } } },
    });
    setNewWfName("");
  };

  const deleteWorkflow = (name: string) => {
    if (name === config.defaultWorkflow) return;
    if (!confirm(`Delete workflow "${name}"?`)) return;
    const { [name]: _, ...rest } = config.workflows;
    setConfig({ ...config, workflows: rest });
  };

  const updateWorkflow = (name: string, wf: WorkflowData) => {
    setConfig({ ...config, workflows: { ...config.workflows, [name]: wf } });
  };

  return (
    <div className="space-y-4">
      {Object.entries(config.workflows).map(([name, wf]) => (
        <WorkflowCard
          key={name}
          name={name}
          workflow={wf}
          isDefault={name === config.defaultWorkflow}
          allCategories={config.categories || []}
          onUpdate={(wf) => updateWorkflow(name, wf)}
          onDelete={() => deleteWorkflow(name)}
        />
      ))}
      <div className="flex gap-2">
        <Input
          placeholder="New workflow name..."
          value={newWfName}
          onChange={(e) => setNewWfName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addWorkflow()}
          className="max-w-[200px]"
        />
        <Button variant="outline" size="sm" onClick={addWorkflow} className="gap-1">
          <Plus className="h-3.5 w-3.5" /> New Workflow
        </Button>
      </div>
    </div>
  );
}

function WorkflowCard({
  name,
  workflow,
  isDefault,
  allCategories,
  onUpdate,
  onDelete,
}: {
  name: string;
  workflow: WorkflowData;
  isDefault: boolean;
  allCategories: string[];
  onUpdate: (wf: WorkflowData) => void;
  onDelete: () => void;
}) {
  const [newState, setNewState] = useState("");
  const [transFrom, setTransFrom] = useState(workflow.states[0] || "");
  const [transTo, setTransTo] = useState(workflow.states[1] || workflow.states[0] || "");
  const [transPerm, setTransPerm] = useState("any");
  const [expanded, setExpanded] = useState(true);

  const addState = () => {
    const val = newState.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!val || workflow.states.includes(val)) return;
    onUpdate({ ...workflow, states: [...workflow.states, val] });
    setNewState("");
  };

  const removeState = (state: string) => {
    const states = workflow.states.filter((s) => s !== state);
    const transitions = { ...workflow.transitions };
    delete transitions[state];
    for (const from of Object.keys(transitions)) {
      const { [state]: _, ...rest } = transitions[from];
      if (Object.keys(rest).length > 0) transitions[from] = rest;
      else delete transitions[from];
    }
    onUpdate({ ...workflow, states, transitions });
  };

  const addTransition = () => {
    if (!transFrom || !transTo || transFrom === transTo) return;
    const transitions = { ...workflow.transitions };
    transitions[transFrom] = { ...(transitions[transFrom] || {}), [transTo]: transPerm };
    onUpdate({ ...workflow, transitions });
  };

  const removeTransition = (from: string, to: string) => {
    const transitions = { ...workflow.transitions };
    if (transitions[from]) {
      const { [to]: _, ...rest } = transitions[from];
      if (Object.keys(rest).length > 0) transitions[from] = rest;
      else delete transitions[from];
    }
    onUpdate({ ...workflow, transitions });
  };

  const updatePerm = (from: string, to: string, perm: string) => {
    const transitions = { ...workflow.transitions };
    transitions[from] = { ...(transitions[from] || {}), [to]: perm };
    onUpdate({ ...workflow, transitions });
  };

  const toggleCategory = (cat: string) => {
    const wfCats = new Set(workflow.categories || []);
    if (wfCats.has(cat)) wfCats.delete(cat);
    else wfCats.add(cat);
    onUpdate({ ...workflow, categories: wfCats.size > 0 ? [...wfCats] : undefined });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 font-semibold text-sm">
            <span>{expanded ? "▾" : "▸"}</span>
            {name}
            {isDefault && <Badge variant="secondary" className="text-xs">default</Badge>}
          </button>
          {!isDefault && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>Delete</Button>
          )}
        </div>

        {expanded && (
          <>
            {/* States */}
            <div>
              <h3 className="text-sm font-medium mb-2">States</h3>
              <div className="flex gap-1 flex-wrap mb-2">
                {workflow.states.map((s) => (
                  <Badge key={s} variant="outline" className="gap-1">
                    {s}
                    <button onClick={() => removeState(s)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input placeholder="New state..." value={newState} onChange={(e) => setNewState(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addState()} className="max-w-[160px]" />
                <Button variant="outline" size="sm" onClick={addState}><Plus className="h-3.5 w-3.5" /></Button>
              </div>
            </div>

            {/* Transitions */}
            <div>
              <h3 className="text-sm font-medium mb-2">Transitions</h3>
              <div className="space-y-1 mb-3">
                {Object.entries(workflow.transitions).flatMap(([from, targets]) =>
                  Object.entries(targets).map(([to, perm]) => (
                    <div key={`${from}-${to}`} className="flex items-center gap-2 text-xs">
                      <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{from}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{to}</span>
                      <Select value={perm} onValueChange={(v) => { if (v) updatePerm(from, to, v); }}>
                        <SelectTrigger className="h-7 w-[100px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">any</SelectItem>
                          <SelectItem value="teammate">teammate</SelectItem>
                          <SelectItem value="lead">lead</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeTransition(from, to)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
              <div className="flex items-center gap-2">
                <Select value={transFrom} onValueChange={(v) => { if (v) setTransFrom(v); }}>
                  <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue placeholder="From" /></SelectTrigger>
                  <SelectContent>{workflow.states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">→</span>
                <Select value={transTo} onValueChange={(v) => { if (v) setTransTo(v); }}>
                  <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue placeholder="To" /></SelectTrigger>
                  <SelectContent>{workflow.states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={transPerm} onValueChange={(v) => { if (v) setTransPerm(v); }}>
                  <SelectTrigger className="h-8 w-[100px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">any</SelectItem>
                    <SelectItem value="teammate">teammate</SelectItem>
                    <SelectItem value="lead">lead</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={addTransition}>Add</Button>
              </div>
            </div>

            {/* Workflow categories */}
            {allCategories.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2">Default Memory Categories</h3>
                <p className="text-xs text-muted-foreground mb-2">Stories using this workflow inherit these categories unless overridden.</p>
                <div className="flex gap-1 flex-wrap">
                  {allCategories.map((c) => {
                    const selected = (workflow.categories || []).includes(c);
                    return (
                      <Button
                        key={c}
                        variant={selected ? "default" : "outline"}
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => toggleCategory(c)}
                      >
                        {c}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * WorkflowDetailPage — Shows and edits a single workflow.
 *
 * A workflow is an ordered pipeline of active states between the implicit
 * `todo` and `done` buckets (see daemon docs/WORK-MODEL.md). This page renders
 * the pipeline, lets you edit the states (add/remove/reorder, agent|manual
 * type), and edit each agent state's persona markdown (the former "state
 * instructions" — same files, injected into that state's claim prompt).
 */

import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi, apiPut } from "@/hooks/useApi";
import { InstructionsEditor } from "@/components/workflow/InstructionsEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { GitBranch, ArrowLeft, Pencil, ArrowRight, Trash2, ChevronUp, ChevronDown, Plus, Bot, User } from "lucide-react";

interface WorkflowState {
  name: string;
  type: "agent" | "manual";
}

interface WorkflowConfig {
  states: WorkflowState[];
}

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, WorkflowConfig>;
  [key: string]: unknown;
}

export function WorkflowDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { data, loading, refetch } = useApi<WorkflowConfig>(`/api/workflows/${name}`);
  const { data: configData, refetch: refetchConfig } = useApi<ConfigData>("/api/config");
  const [editing, setEditing] = useState(false);

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="container mx-auto p-6 text-muted-foreground">Workflow not found.</div>;

  const isDefault = configData?.defaultWorkflow === name;
  const agentCount = data.states.filter(s => s.type === "agent").length;

  const handleSaved = () => {
    refetch();
    refetchConfig();
    setEditing(false);
  };

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <GitBranch className="h-5 w-5" />
          <h1 className="text-2xl font-bold">{name}</h1>
          <span className="text-sm text-muted-foreground">
            {data.states.length} states · {agentCount} agent · {data.states.length - agentCount} manual
            {isDefault && " · default"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(v => !v)} className="gap-1.5">
          <Pencil className="h-3.5 w-3.5" /> {editing ? "Close Editor" : "Edit States"}
        </Button>
      </div>

      {/* Pipeline visualization: todo → active states → done */}
      <section>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          Pipeline
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <BucketChip label="todo" />
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          {data.states.map((s) => (
            <span key={s.name} className="flex items-center gap-2">
              <StateChip state={s} />
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </span>
          ))}
          <BucketChip label="done" />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          <span className="font-medium">todo</span> and <span className="font-medium">done</span> are implicit buckets.
          Admission pulls one task per story from todo (CONWIP); completed agent work advances automatically;
          tasks in <span className="font-medium">manual</span> states wait for you to move them.
        </p>
      </section>

      {/* Inline states editor */}
      {editing && configData && (
        <StatesEditor name={name!} workflow={data} config={configData} onSaved={handleSaved} />
      )}

      {/* State personas (agent states only — manual states never get a prompt) */}
      <section>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          State Personas
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Each agent state's markdown is injected as the worker's role framing when it claims a task in that state.
        </p>
        <InstructionsEditor workflowName={name!} states={data.states.filter(s => s.type === "agent").map(s => s.name)} />
      </section>
    </div>
  );
}

/** An implicit bucket chip (todo/done). */
function BucketChip({ label }: { label: string }) {
  return (
    <span className="px-3 py-1.5 rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {label}
    </span>
  );
}

/** An active-state chip with its agent/manual type. */
function StateChip({ state }: { state: WorkflowState }) {
  const isAgent = state.type === "agent";
  return (
    <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm ${isAgent ? "border-blue-300 bg-blue-50 dark:bg-blue-950 dark:border-blue-800" : "border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800"}`}>
      {isAgent ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      {state.name.replace(/_/g, " ")}
      <Badge variant="outline" className="text-[10px] px-1 py-0">{state.type}</Badge>
    </span>
  );
}

/** Inline editor for a workflow's ordered states (name, type, order). */
function StatesEditor({ name, workflow, config, onSaved }: {
  name: string;
  workflow: WorkflowConfig;
  config: ConfigData;
  onSaved: () => void;
}) {
  const [states, setStates] = useState<WorkflowState[]>(workflow.states);
  const [newState, setNewState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setStates(workflow.states), [workflow]);

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...states];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    setStates(next);
  };

  const toggleType = (idx: number) => {
    setStates(states.map((s, i) => i === idx ? { ...s, type: s.type === "agent" ? "manual" : "agent" } : s));
  };

  const remove = (idx: number) => setStates(states.filter((_, i) => i !== idx));

  const add = () => {
    const slug = newState.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!slug) return;
    if (slug === "todo" || slug === "done") { setError(`"${slug}" is a reserved bucket name`); return; }
    if (states.some(s => s.name === slug)) { setError(`State "${slug}" already exists`); return; }
    setStates([...states, { name: slug, type: "agent" }]);
    setNewState("");
    setError(null);
  };

  const save = async () => {
    if (states.length === 0) { setError("A workflow needs at least one state"); return; }
    setSaving(true);
    setError(null);
    try {
      const updatedConfig = { ...config, workflows: { ...config.workflows, [name]: { states } } };
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", updatedConfig);
      if (res.success) onSaved();
      else setError(res.error || "Failed to save");
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    }
    setSaving(false);
  };

  return (
    <section className="border border-border rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-semibold">Edit States</h3>
      {states.map((s, idx) => (
        <div key={s.name} className="flex items-center gap-2">
          <div className="flex flex-col">
            <Button variant="ghost" size="icon" className="h-5 w-5" disabled={idx === 0} onClick={() => move(idx, -1)}><ChevronUp className="h-3 w-3" /></Button>
            <Button variant="ghost" size="icon" className="h-5 w-5" disabled={idx === states.length - 1} onClick={() => move(idx, 1)}><ChevronDown className="h-3 w-3" /></Button>
          </div>
          <span className="flex-1 text-sm font-medium">{s.name.replace(/_/g, " ")}</span>
          <Button variant="outline" size="sm" onClick={() => toggleType(idx)} title="Toggle who works this state">
            {s.type === "agent" ? <><Bot className="h-3.5 w-3.5 mr-1" />agent</> : <><User className="h-3.5 w-3.5 mr-1" />manual</>}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(idx)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <Input
          placeholder="New state name…"
          value={newState}
          onChange={e => setNewState(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") add(); }}
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={add} disabled={!newState.trim()}><Plus className="h-3.5 w-3.5 mr-1" />Add</Button>
        <div className="flex-1" />
        <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

/**
 * NewStoryPage — Full-page form for creating a new story with optional tasks
 * (/stories/new). Replaces the old AddStoryDialog modal: creation is a real
 * destination with room for the form's sections (workflow, directory,
 * context, inline tasks). On success, lands on the new story's detail page.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { ContextSelector } from "@/components/board/ContextSelector";
import { SegmentedTabs } from "@/components/RouteTabs";
import { Plus, X } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { useApi, apiPost } from "@/hooks/useApi";

interface WorkflowSummary {
  name: string;
  stateCount: number;
  isDefault: boolean;
}

export function NewStoryPage() {
  const navigate = useNavigate();
  const { data: workflows } = useApi<WorkflowSummary[]>("/api/workflows");
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [paused, setPaused] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Array<{ title: string; description: string; context: string[] }>>([]);
  const [error, setError] = useState("");

  // Pre-select the team's default workflow once the list loads (the user can
  // still pick another); render-time derivation avoids a setState-in-effect.
  const effectiveWorkflow = workflow || (workflows || []).find(wf => wf.isDefault)?.name || "";

  const addTask = () => setTasks([...tasks, { title: "", description: "", context: [] }]);
  const removeTask = (i: number) => setTasks(tasks.filter((_, idx) => idx !== i));
  const updateTask = (i: number, field: "title" | "description", value: string) => {
    const updated = [...tasks];
    updated[i] = { ...updated[i]!, [field]: value };
    setTasks(updated);
  };
  const updateTaskContext = (i: number, ids: string[]) => {
    const updated = [...tasks];
    updated[i] = { ...updated[i]!, context: ids };
    setTasks(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!effectiveWorkflow) { setError("Please select a workflow"); return; }
    const body: Record<string, unknown> = { id, title, description, workflow: effectiveWorkflow };
    // The working directory is plain story data — agents cd to it and it biases
    // which teammate picks up the work (directory affinity).
    if (directory.trim()) body.directory = directory.trim();
    if (paused) body.paused = true;
    if (context.length > 0) body.context = context;
    if (tasks.length > 0) body.tasks = tasks.filter(t => t.title).map(t => ({ title: t.title, description: t.description, context: t.context.length > 0 ? t.context : undefined }));

    const res = await apiPost<{ success: boolean; error?: string }>("/api/stories", body);
    if (res.success) navigate(`/story/${encodeURIComponent(id)}`);
    else setError(res.error || "Failed to create story");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback="/board" title="Back to board" />
        <h1 className="text-2xl font-bold">New Story</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="story-id">ID</Label><Input id="story-id" value={id} onChange={e => setId(e.target.value)} placeholder="my-story-id" required /></div>
          <div className="flex items-end pb-1"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} /> Paused (don't hand out tasks yet)</label></div>
        </div>
        <div>
          <Label>Workflow</Label>
          <div className="mt-1">
            <SegmentedTabs
              tabs={(workflows || []).map(wf => ({ key: wf.name, label: wf.name }))}
              active={effectiveWorkflow || null}
              onSelect={(key) => setWorkflow(key ?? "")}
            />
          </div>
        </div>
        <div><Label htmlFor="story-title">Title</Label><Input id="story-title" value={title} onChange={e => setTitle(e.target.value)} required /></div>
        <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required defaultEditing />

        <div><Label htmlFor="story-dir">Directory</Label><p className="text-xs text-muted-foreground mb-1">Where the work happens — teammates cd here and read its AGENTS.md. Also biases which teammate picks up the work.</p><Input id="story-dir" placeholder="/path/to/project (optional)" value={directory} onChange={e => setDirectory(e.target.value)} /></div>

        <div><Label>Context</Label><p className="text-xs text-muted-foreground mb-1">Attached entries are injected into every task's prompt for this story.</p><ContextSelector value={context} onChange={setContext} /></div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Tasks</Label>
            <Button type="button" variant="outline" size="sm" onClick={addTask}><Plus className="h-3 w-3 mr-1" />Task</Button>
          </div>
          {tasks.map((task, i) => (
            <div key={i} className="flex gap-2 mb-2 items-start">
              <div className="flex-1 space-y-1">
                <Input placeholder="Task title" value={task.title} onChange={e => updateTask(i, "title", e.target.value)} />
                <Input placeholder="Description" value={task.description} onChange={e => updateTask(i, "description", e.target.value)} />
                <ContextSelector value={task.context} onChange={ids => updateTaskContext(i, ids)} />
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeTask(i)}><X className="h-3 w-3" /></Button>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit">Create Story</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

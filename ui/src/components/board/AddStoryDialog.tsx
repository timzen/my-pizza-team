/**
 * AddStoryDialog — Modal for creating a new story with optional tasks.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { RequirementsEditor } from "@/components/board/RequirementsEditor";
import { ContextSelector } from "@/components/board/ContextSelector";
import { Plus, X } from "lucide-react";
import { useApi, apiPost } from "@/hooks/useApi";

interface WorkflowSummary {
  name: string;
  stateCount: number;
  transitionCount: number;
  isDefault: boolean;
}

interface AddStoryDialogProps {
  onCreated: () => void;
}

export function AddStoryDialog({ onCreated }: AddStoryDialogProps) {
  const [open, setOpen] = useState(false);
  const { data: workflows } = useApi<WorkflowSummary[]>("/api/workflows");
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [requirements, setRequirements] = useState<Record<string, string | null>>({});
  const [directory, setDirectory] = useState("");
  const [paused, setPaused] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Array<{ title: string; description: string; context: string[] }>>([]);
  const [error, setError] = useState("");

  const reset = () => { setId(""); setTitle(""); setDescription(""); setRequirements({}); setDirectory(""); setPaused(false); setWorkflow(""); setContext([]); setTasks([]); setError(""); };

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
    if (!workflow) { setError("Please select a workflow"); return; }
    const body: Record<string, unknown> = { id, title, description, workflow };
    // The story's capability requirements (presence-only skills etc.); the
    // working directory is plain story data — agents cd to it (WORK-MODEL.md).
    if (Object.keys(requirements).length > 0) body.requirements = requirements;
    if (directory.trim()) body.directory = directory.trim();
    if (paused) body.paused = true;
    if (context.length > 0) body.context = context;
    if (tasks.length > 0) body.tasks = tasks.filter(t => t.title).map(t => ({ title: t.title, description: t.description, context: t.context.length > 0 ? t.context : undefined }));

    const res = await apiPost<{ success: boolean; error?: string }>("/api/stories", body);
    if (res.success) { setOpen(false); reset(); onCreated(); }
    else setError(res.error || "Failed to create story");
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> Add Story</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>New Story</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="story-id">ID</Label><Input id="story-id" value={id} onChange={e => setId(e.target.value)} placeholder="my-story-id" required /></div>
            <div className="flex items-end pb-1"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} /> Paused (don't hand out tasks yet)</label></div>
          </div>
          <div>
            <Label>Workflow</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {(workflows || []).map(wf => (
                <Button
                  key={wf.name}
                  type="button"
                  size="sm"
                  variant={workflow === wf.name ? "default" : "outline"}
                  onClick={() => setWorkflow(wf.name)}
                >
                  {wf.name}
                </Button>
              ))}
            </div>
          </div>
          <div><Label htmlFor="story-title">Title</Label><Input id="story-title" value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required defaultEditing />

          <div><Label htmlFor="story-dir">Directory</Label><p className="text-xs text-muted-foreground mb-1">Where the work happens — teammates cd here and read its AGENTS.md.</p><Input id="story-dir" placeholder="/path/to/project (optional)" value={directory} onChange={e => setDirectory(e.target.value)} /></div>

          <div><Label>Requirements</Label><div className="mt-1"><RequirementsEditor value={requirements} onChange={setRequirements} /></div></div>

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
          <Button type="submit" className="w-full">Create Story</Button>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}

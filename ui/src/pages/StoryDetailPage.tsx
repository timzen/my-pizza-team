/**
 * StoryDetailPage — Full story view and editor at /story/:id.
 *
 * This page is the home for story *editing* (title, description, requirements,
 * paused). The board only links here; all story edits happen on this page.
 */

import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { MarkdownField } from "@/components/ui/markdown-field";
import { TitleField } from "@/components/ui/title-field";
import { RequirementsEditor } from "@/components/board/RequirementsEditor";
import { ContextSelector } from "@/components/board/ContextSelector";
import { AddTaskDialog } from "@/components/board/AddTaskDialog";
import { ArrowLeft, Save, Trash2, Plus, ChevronUp, ChevronDown } from "lucide-react";

interface StoryTask {
  id: string;
  title: string;
  status: string;
}

interface StoryView {
  id: string;
  title: string;
  description: string;
  status?: "open" | "done";
  requirements?: Record<string, string | null>;
  directory?: string;
  paused?: boolean;
  workflow?: string;
  context?: string[];
  tasks: StoryTask[];
}

/** Story requirements are a capability map: key -> value (string) or presence-only (null). */

export function StoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, refetch } = useApi<{ stories: StoryView[] }>("/api/stories");
  const story = data?.stories.find(s => s.id === id);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [requirements, setRequirements] = useState<Record<string, string | null>>({});
  const [directory, setDirectory] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [addTaskOpen, setAddTaskOpen] = useState(false);

  // Seed edit fields when the story loads/changes.
  useEffect(() => {
    if (story) {
      setTitle(story.title);
      setDescription(story.description);
      setRequirements(story.requirements ? { ...story.requirements } : {});
      setDirectory(story.directory || "");
      setContext(story.context ? [...story.context] : []);
      setPaused(!!story.paused); setError("");
    }
  }, [story?.id]);

  if (!story) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Story not found. <Link to="/board" className="underline">Back to board</Link></p>
      </div>
    );
  }

  const handleSave = async () => {
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, {
      title, description,
      requirements: Object.keys(requirements).length > 0 ? requirements : null,
      directory: directory.trim() || null,
      context,
      paused,
    });
    if (res.success) refetch();
    else setError(res.error || "Failed to update");
  };

  const handleDelete = async () => {
    if (!confirm(`Delete story "${story.id}"?`)) return;
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/stories/${story.id}`);
    if (res.success) navigate("/board");
    else setError(res.error || "Failed to delete");
  };

  /** Toggle paused immediately (like the task page's status moves). */
  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, { paused: next });
    if (res.success) refetch();
    else { setPaused(!next); setError(res.error || "Failed to update"); }
  };

  /** Move a task up/down and persist the new order. */
  const moveTask = async (index: number, delta: number) => {
    if (!story) return;
    const to = index + delta;
    if (to < 0 || to >= story.tasks.length) return;
    const order = story.tasks.map(t => t.id);
    const [moved] = order.splice(index, 1);
    order.splice(to, 0, moved!);
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${story.id}/tasks/reorder`, { order });
    if (res.success) refetch();
    else setError(res.error || "Failed to reorder");
  };

  /** Delete a task from this story. */
  const deleteTaskById = async (taskId: string) => {
    if (!confirm(`Delete task "${taskId}"?`)) return;
    setError("");
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.success) refetch();
    else setError(res.error || "Failed to delete task");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      {/* Top bar: back to board + save/delete actions */}
      <div className="flex items-center justify-between">
        <Link to="/board" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to board
        </Link>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleSave} title="Save changes">
            <Save className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
            onClick={handleDelete}
            title="Delete story"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Header: title, then path on the left + status on the right */}
      <div className="space-y-2">
        <TitleField label="Title" value={title} onChange={setTitle} required />
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="font-mono">/{story.id}</Badge>
          <Badge variant="secondary">{story.paused ? "paused" : (story.status || "open")}</Badge>
        </div>
      </div>

      <div className="space-y-4">
        <MarkdownField label="Description" value={description} onChange={setDescription} rows={4} required />

        {/* Pause toggle (below the description, right-aligned) */}
        <div className="flex items-center justify-end">
          <Button type="button" size="sm" variant={paused ? "default" : "outline"} onClick={togglePause}>
            {paused ? "Unpause" : "Pause"}
          </Button>
        </div>

        <div><div className="mb-2 pb-1 border-b border-border"><Label>Directory</Label></div><p className="text-xs text-muted-foreground mb-2">Where the work happens — teammates cd here and read its AGENTS.md before starting.</p><Input placeholder="/path/to/project (optional)" value={directory} onChange={e => setDirectory(e.target.value)} /></div>

        <div><div className="mb-2 pb-1 border-b border-border"><Label>Requirements</Label></div><RequirementsEditor value={requirements} onChange={setRequirements} /></div>

        <div><div className="mb-2 pb-1 border-b border-border"><Label>Context</Label></div><p className="text-xs text-muted-foreground mb-2">Injected into every task's prompt for this story.</p><ContextSelector value={context} onChange={setContext} /></div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {/* Task list with links to each task page */}
      <div className="space-y-2 pt-2">
        <div className="flex items-center justify-between mb-2 pb-1 border-b border-border">
          <Label>Tasks ({story.tasks.length})</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setAddTaskOpen(true)}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        {story.tasks.map((t, i) => (
          <div
            key={t.id}
            className="flex items-center gap-2 p-2 border rounded-lg hover:border-primary transition-colors"
          >
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={i === 0} onClick={() => moveTask(i, -1)} title="Move up">
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={i === story.tasks.length - 1} onClick={() => moveTask(i, 1)} title="Move down">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Link to={`/task/${story.id}/${t.id}`} className="text-sm flex-1 hover:underline">{t.title}</Link>
            <Badge variant="secondary" className="text-xs">{t.status.replace(/_/g, " ")}</Badge>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive/80 hover:bg-destructive/10" onClick={() => deleteTaskById(t.id)} title="Delete task">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {story.tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
      </div>

      <AddTaskDialog storyId={story.id} open={addTaskOpen} onClose={() => setAddTaskOpen(false)} onCreated={refetch} />
    </div>
  );
}

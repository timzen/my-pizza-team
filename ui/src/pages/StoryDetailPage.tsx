/**
 * StoryDetailPage — Full story view and editor at /story/:id.
 *
 * This page is the home for story *editing* (title, description, directory, workflow). The board only links here; all story edits happen on this page.
 * The Workflow picker applies at once, like the Pending toggle: "Team default"
 * clears the override (the effective name is shown), and a switch the daemon
 * refuses — an in-flight task's state missing from the new workflow (409) —
 * shows its reason under the picker (docs/DESIGN.md "The Work Model").
 * The header's Pending ⇄ Active toggle applies at once (docs/DESIGN.md
 * "Pending: Write, Review, Activate"): pending holds the story — a running
 * task finishes, nothing new is handed out, dependents wait.
 * A story with no tasks yet explains how its tasks run and offers Add a task
 * and the chat (components/ui/empty-state). A task row in a poll state shows
 * its poll status (`PollStatusBadge`; docs/DESIGN.md "Polling States").
 */

import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { DirectoryInput } from "@/components/ui/directory-input";
import { MarkdownField } from "@/components/ui/markdown-field";
import { TitleField } from "@/components/ui/title-field";
import { Save, Trash2, Plus, ChevronUp, ChevronDown, Archive, Hourglass, Play, ListChecks } from "lucide-react";
import { AskAssistantButton, EmptyState } from "@/components/ui/empty-state";
import { BackButton } from "@/components/ui/back-button";
import type { StoryView } from "@shared/protocol";
import { PollStatusBadge } from "@/components/board/PollStatusBadge";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { FormError } from "@/components/ui/form-error";
import { useAnnounce } from "@/hooks/useAnnounce";
import { PageHelpButton } from "@/components/help/PageHelpButton";
import { FieldHint } from "@/components/ui/field-hint";

/** One row of GET /api/workflows (only what the picker needs). */
interface WorkflowSummary {
  name: string;
  isDefault: boolean;
}

export function StoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, refetch } = useApi<{ stories: StoryView[] }>("/api/stories");
  const story = data?.stories.find(s => s.id === id);
  const { data: workflows } = useApi<WorkflowSummary[]>("/api/workflows");
  const [confirmDialog, confirm] = useConfirm();
  const announce = useAnnounce();
  // The tab's title is the story's (the path can't know it: lib/page-title.ts).
  useDocumentTitle([story?.title ?? id ?? "Story", "Story"]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [workflowError, setWorkflowError] = useState("");

  // Seed edit fields when the story loads/changes. Adjusting state during
  // render (guarded by a "last seeded" marker) is React's recommended pattern
  // for deriving state from external data — no effect, no cascading render.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (story && story.id !== seededId) {
    setSeededId(story.id);
    setTitle(story.title);
    setDescription(story.description);
    setDirectory(story.directory || "");
    setError("");
    setWorkflowError("");
  }

  if (!story) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Story not found. <Link to="/work/board" className="underline">Back to board</Link></p>
      </div>
    );
  }

  const handleSave = async () => {
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, {
      title, description,
      directory: directory.trim() || null,
    });
    if (res.success) { refetch(); announce("Story saved"); }
    else setError(res.error || "Failed to update");
  };

  const handleDelete = async () => {
    if (!(await confirm({ title: `Delete story "${story.id}"?`, confirmLabel: "Delete", destructive: true }))) return;
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/stories/${story.id}`);
    if (res.success) { announce(`Deleted story ${story.title}`); navigate("/work/board", { replace: true }); }
    else setError(res.error || "Failed to delete");
  };

  /** Archive this story. If not all tasks are done, confirm force-archive. */
  const handleArchive = async () => {
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${story.id}/archive`, {});
    if (res.success) {
      announce(`Archived story ${story.title}`);
      navigate("/work/board");
      return;
    }
    // If the error indicates not all tasks are done, offer force-archive
    if (res.error && res.error.includes("Not all tasks are done")) {
      if (!(await confirm({ title: "Not all tasks are done. Archive anyway?", description: "Tasks not in 'done' will be force-completed.", confirmLabel: "Archive" }))) return;
      const forceRes = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${story.id}/archive`, { force: true });
      if (forceRes.success) { announce(`Archived story ${story.title}`); navigate("/work/board"); }
      else setError(forceRes.error || "Failed to archive");
    } else {
      setError(res.error || "Failed to archive");
    }
  };

  /** Pending ⇄ active, applied immediately (like the task page's status moves). */
  const togglePending = async () => {
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${story.id}/${story.pending ? "activate" : "pending"}`);
    if (res.success) { refetch(); announce(story.pending ? "Story activated" : "Story made pending"); }
    else setError(res.error || "Failed to update");
  };

  // The team default (what "Team default" stands for) and whether the story's
  // own workflow still exists — a deleted one falls back to the default.
  const defaultWorkflow = workflows?.find(wf => wf.isDefault)?.name;
  const workflowMissing = !!story.workflow && !!workflows && !workflows.some(wf => wf.name === story.workflow);
  const effectiveWorkflow = story.workflow && !workflowMissing ? story.workflow : defaultWorkflow;

  /** Switch the story's workflow, applied immediately ("" = team default). A refusal shows under the picker. */
  const changeWorkflow = async (name: string) => {
    setWorkflowError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, { workflow: name || null });
    if (res.success) { refetch(); announce(`Workflow set to ${name || `team default${defaultWorkflow ? ` (${defaultWorkflow})` : ""}`}`); }
    else setWorkflowError(res.error || "Failed to change workflow");
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
    if (res.success) { refetch(); announce(`Moved ${delta < 0 ? "up" : "down"} to position ${to + 1}`); }
    else setError(res.error || "Failed to reorder");
  };

  /** Delete a task from this story. */
  const deleteTaskById = async (taskId: string) => {
    if (!(await confirm({ title: `Delete task "${taskId}"?`, confirmLabel: "Delete", destructive: true }))) return;
    setError("");
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.success) { refetch(); announce(`Deleted task ${taskId}`); }
    else setError(res.error || "Failed to delete task");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      {confirmDialog}
      {/* Top bar: back to board + save/delete actions */}
      <div className="flex items-center justify-between">
        <BackButton fallback="/work/board" label="Back to board" />
        <div className="flex items-center gap-1">
          <IconButton variant="ghost" size="icon" onClick={handleSave} label="Save changes">
            <Save className="h-4 w-4" />
          </IconButton>
          <IconButton variant="ghost" size="icon" onClick={handleArchive} label="Archive story">
            <Archive className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
            onClick={handleDelete}
            label="Delete story"
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
          <PageHelpButton />
        </div>
      </div>

      {/* Header: title, then path on the left + status on the right */}
      <div className="space-y-2">
        <TitleField label="Title" value={title} onChange={setTitle} required heading />
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="font-mono">/{story.id}</Badge>
          <div className="flex items-center gap-2">
            {story.pending && <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">pending</Badge>}
            <Badge variant="secondary">{story.status || "open"}</Badge>
            <Tooltip content={story.pending ? "Hand out this story's tasks again" : "Hold this story: a running task finishes, nothing new starts"}>
              <Button
                type="button"
                size="sm"
                variant={story.pending ? "default" : "outline"}
                onClick={togglePending}
              >
                {story.pending ? <><Play className="h-3.5 w-3.5 mr-1" />Activate</> : <><Hourglass className="h-3.5 w-3.5 mr-1" />Make pending</>}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <MarkdownField label="Description" value={description} onChange={setDescription} rows={4} required />

        <div><div className="mb-2 pb-1 border-b border-border"><Label htmlFor="story-edit-dir">Directory</Label></div><DirectoryInput id="story-edit-dir" placeholder="/path/to/project (optional)" value={directory} onChange={setDirectory} hintId="story-edit-dir-hint" /><FieldHint id="story-edit-dir-hint" field="directory" className="mt-1" /></div>

        <div>
          <div className="mb-2 pb-1 border-b border-border"><Label htmlFor="story-edit-workflow">Workflow</Label></div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="story-edit-workflow"
              value={story.workflow || ""}
              disabled={!workflows}
              onChange={(e) => changeWorkflow(e.target.value)}
              className="h-8 min-w-[220px] max-w-[360px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
              aria-invalid={!!workflowError || workflowMissing || undefined}
              aria-describedby={workflowError ? "story-edit-workflow-error story-edit-workflow-hint" : "story-edit-workflow-hint"}
            >
              <option value="">Team default{defaultWorkflow ? ` (${defaultWorkflow})` : ""}</option>
              {workflowMissing && <option value={story.workflow}>{story.workflow} (missing)</option>}
              {(workflows || []).map(wf => <option key={wf.name} value={wf.name}>{wf.name}</option>)}
            </select>
            {effectiveWorkflow && (workflowMissing || !story.workflow) && (
              <span className="text-xs text-muted-foreground">
                {workflowMissing ? `'${story.workflow}' no longer exists; using ${effectiveWorkflow}` : `Using ${effectiveWorkflow}`}
              </span>
            )}
          </div>
          <FormError id="story-edit-workflow-error" className="mt-1">{workflowError}</FormError>
          <FieldHint id="story-edit-workflow-hint" field="workflow" className="mt-1" />
        </div>

        <FormError className="text-sm">{error}</FormError>
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
            render={<Link to={`/story/${story.id}/tasks/new`} />}
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
              <IconButton variant="ghost" size="icon" className="h-6 w-6" disabled={i === 0} onClick={() => moveTask(i, -1)} label="Move up">
                <ChevronUp className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton variant="ghost" size="icon" className="h-6 w-6" disabled={i === story.tasks.length - 1} onClick={() => moveTask(i, 1)} label="Move down">
                <ChevronDown className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <Link to={`/task/${story.id}/${t.id}`} className="text-sm flex-1 hover:underline">{t.title}</Link>
            {t.poll && <PollStatusBadge poll={t.poll} workItemState={t.workItemState} />}
            <Badge variant="secondary" className="text-xs">{t.status.replace(/_/g, " ")}</Badge>
            <IconButton variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive/80 hover:bg-destructive/10" onClick={() => deleteTaskById(t.id)} label="Delete task">
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ))}
        {story.tasks.length === 0 && (
          <EmptyState kind="storyTasks" icon={ListChecks} className="py-8">
            <Button size="sm" render={<Link to={`/story/${story.id}/tasks/new`} />}><Plus className="mr-1 h-4 w-4" aria-hidden />Add a task</Button>
            <AskAssistantButton />
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/**
 * NewTaskPage — Full-page form for adding a task to a story
 * (/story/:id/tasks/new). Replaces the old AddTaskDialog modal. On success,
 * returns to wherever you came from (board or story page). **Save as pending**
 * creates it as pending: it holds its place in the story (later tasks wait
 * behind it) and gets no WorkItem until activated from the task page
 * (docs/DESIGN.md "Pending: Write, Review, Activate"). Its hints (where the
 * task goes in the story's order, what pending does) come from
 * lib/field-help.ts via components/ui/field-hint.
 */

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { BackButton } from "@/components/ui/back-button";
import { apiPost } from "@/hooks/useApi";
import { FormError } from "@/components/ui/form-error";
import { useAnnounce } from "@/hooks/useAnnounce";
import { PageHelpButton } from "@/components/help/PageHelpButton";
import { FieldHint } from "@/components/ui/field-hint";

export function NewTaskPage() {
  const { id: storyId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const announce = useAnnounce();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!storyId) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const pending = submitter?.value === "pending";
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${encodeURIComponent(storyId)}/tasks`, { title, description, pending: pending || undefined });
    if (res.success) { announce(pending ? "Task added as pending" : "Task added"); navigate(-1); }
    else setError(res.error || "Failed to create task");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback={`/story/${storyId}`} title="Back to story" />
        <h1 className="text-2xl font-bold">Add Task to {storyId}</h1>
        <PageHelpButton />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div><div className="mb-2 pb-1 border-b border-border"><Label htmlFor="task-title">Title</Label></div><Input id="task-title" value={title} onChange={e => setTitle(e.target.value)} required aria-describedby="task-order-hint" /><FieldHint id="task-order-hint" field="taskOrder" className="mt-1" /></div>
        <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required defaultEditing />
        <FormError className="text-sm">{error}</FormError>
        <div className="flex gap-2">
          <Button type="submit" value="add">Add Task</Button>
          <Button type="submit" value="pending" variant="secondary" aria-describedby="task-pending-hint">Save as pending</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
        <FieldHint id="task-pending-hint" field="pending">{" "}It holds its place in the story meanwhile.</FieldHint>
      </form>
    </div>
  );
}

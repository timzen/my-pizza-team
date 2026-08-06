/**
 * NewTaskPage — Full-page form for adding a task to a story
 * (/story/:id/tasks/new). Replaces the old AddTaskDialog modal. On success,
 * returns to wherever you came from (board or story page).
 */

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { ContextSelector } from "@/components/board/ContextSelector";
import { BackButton } from "@/components/ui/back-button";
import { apiPost } from "@/hooks/useApi";

export function NewTaskPage() {
  const { id: storyId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storyId) return;
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${encodeURIComponent(storyId)}/tasks`, { title, description, context: context.length > 0 ? context : undefined });
    if (res.success) navigate(-1);
    else setError(res.error || "Failed to create task");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback={`/story/${storyId}`} title="Back to story" />
        <h1 className="text-2xl font-bold">Add Task to {storyId}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div><div className="mb-2 pb-1 border-b border-border"><Label>Title</Label></div><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
        <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required defaultEditing />
        <div><div className="mb-2 pb-1 border-b border-border"><Label>Context</Label></div><div className="mt-1"><ContextSelector value={context} onChange={setContext} /></div></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit">Add Task</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

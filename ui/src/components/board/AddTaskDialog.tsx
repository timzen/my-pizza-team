/**
 * AddTaskDialog — Modal for adding a task to a story.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { apiPost } from "@/hooks/useApi";

interface AddTaskDialogProps {
  storyId: string | null;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddTaskDialog({ storyId, open, onClose, onCreated }: AddTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const reset = () => { setTitle(""); setDescription(""); setError(""); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storyId) return;
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/stories/${storyId}/tasks`, { title, description });
    if (res.success) { onClose(); reset(); onCreated(); }
    else setError(res.error || "Failed to create task");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add Task to {storyId}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required defaultEditing />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full">Add Task</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

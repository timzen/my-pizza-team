/**
 * EditStoryDialog — Modal for editing an existing story.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiPut, apiDelete } from "@/hooks/useApi";

interface StoryData {
  id: string;
  title: string;
  description: string;
  dir?: string;
  workflow?: string;
}

interface EditStoryDialogProps {
  story: StoryData | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditStoryDialog({ story, open, onClose, onUpdated }: EditStoryDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (story) { setTitle(story.title); setDescription(story.description); setDir(story.dir || ""); setError(""); }
  }, [story]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!story) return;
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, { title, description, dir: dir || null });
    if (res.success) { onClose(); onUpdated(); }
    else setError(res.error || "Failed to update");
  };

  const handleDelete = async () => {
    if (!story || !confirm(`Delete story "${story.id}"?`)) return;
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/stories/${story.id}`);
    if (res.success) { onClose(); onUpdated(); }
    else setError(res.error || "Failed to delete");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Story: {story?.id}</DialogTitle></DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <div><Label>Description</Label><Textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} required /></div>
          <div><Label>Directory</Label><Input value={dir} onChange={e => setDir(e.target.value)} placeholder="~/projects/foo" /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">Save</Button>
            <Button type="button" variant="destructive" onClick={handleDelete}>Delete</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

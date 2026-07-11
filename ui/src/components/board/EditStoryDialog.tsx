/**
 * EditStoryDialog — Modal for editing an existing story.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DirectoryInput } from "@/components/ui/directory-input";
import { MarkdownField } from "@/components/ui/markdown-field";
import { apiPut, apiDelete } from "@/hooks/useApi";

interface StoryData {
  id: string;
  title: string;
  description: string;
  requirements?: Record<string, string | null>;
  paused?: boolean;
  workflow?: string;
}

interface EditStoryDialogProps {
  story: StoryData | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

/** Split a requirements map into the directory value and the presence-only skill keys. */
function splitRequirements(reqs?: Record<string, string | null>): { dir: string; skills: string } {
  if (!reqs) return { dir: "", skills: "" };
  const dir = typeof reqs.directory === "string" ? reqs.directory : "";
  const skills = Object.keys(reqs).filter(k => k !== "directory").join(", ");
  return { dir, skills };
}

export function EditStoryDialog({ story, open, onClose, onUpdated }: EditStoryDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dir, setDir] = useState("");
  const [skills, setSkills] = useState("");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (story) {
      setTitle(story.title); setDescription(story.description);
      const { dir: d, skills: s } = splitRequirements(story.requirements);
      setDir(d); setSkills(s); setPaused(!!story.paused); setError("");
    }
  }, [story]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!story) return;
    const requirements: Record<string, string | null> = {};
    if (dir) requirements.directory = dir;
    for (const skill of skills.split(",").map(s => s.trim()).filter(Boolean)) requirements[skill] = null;
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/stories/${story.id}`, {
      title, description,
      requirements: Object.keys(requirements).length > 0 ? requirements : null,
      paused,
    });
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
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit Story: {story?.id}</DialogTitle></DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} required />
          <div><Label>Directory</Label><DirectoryInput value={dir} onChange={setDir} /></div>
          <div><Label>Required skills (comma-separated)</Label><Input value={skills} onChange={e => setSkills(e.target.value)} placeholder="python, docker" /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} /> Paused (don't hand out tasks yet)</label>
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

/**
 * EditTaskDialog — Modal for editing/moving/deleting a task.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiPut, apiPost, apiDelete } from "@/hooks/useApi";

interface TaskData {
  id: string;
  title: string;
  status: string;
  description?: string;
}

interface EditTaskDialogProps {
  task: TaskData | null;
  states: string[];
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditTaskDialog({ task, states, open, onClose, onUpdated }: EditTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (task) { setTitle(task.title); setDescription(task.description || ""); setStatus(task.status); setError(""); }
  }, [task]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task) return;
    // Update details
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/tasks/${task.id}`, { title, description });
    if (!res.success) { setError(res.error || "Failed"); return; }
    // Move if status changed
    if (status !== task.status) {
      const moveRes = await apiPost<{ success: boolean; error?: string }>(`/api/tasks/${task.id}/move`, { status });
      if (!moveRes.success) { setError(moveRes.error || "Failed to move"); return; }
    }
    onClose(); onUpdated();
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete task "${task.id}"?`)) return;
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${task.id}`);
    if (res.success) { onClose(); onUpdated(); }
    else setError(res.error || "Failed to delete");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Task: {task?.id}</DialogTitle></DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <div><Label>Description</Label><Textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} /></div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => { if (v) setStatus(v); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {states.map(s => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
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

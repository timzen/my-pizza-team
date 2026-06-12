/**
 * EditTaskDialog — Modal for editing/moving/deleting a task.
 * Shows valid status transitions as buttons instead of a dropdown.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MarkdownField } from "@/components/ui/markdown-field";
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
  /** Workflow transitions: { fromState: { toState: permission } } */
  transitions: Record<string, Record<string, string>>;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditTaskDialog({ task, states, transitions, open, onClose, onUpdated }: EditTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (task) { setTitle(task.title); setDescription(task.description || ""); setError(""); }
  }, [task]);

  /** Get valid target states from the current status based on workflow transitions */
  const validTransitions = task ? Object.keys(transitions[task.status] || {}) : [];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task) return;
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(task.id)}`, { title, description });
    if (!res.success) { setError(res.error || "Failed"); return; }
    onClose(); onUpdated();
  };

  const handleMove = async (targetStatus: string) => {
    if (!task) return;
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(task.id)}/move`, { status: targetStatus });
    if (res.success) { onClose(); onUpdated(); }
    else setError(res.error || "Failed to move");
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete task "${task.id}"?`)) return;
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(task.id)}`);
    if (res.success) { onClose(); onUpdated(); }
    else setError(res.error || "Failed to delete");
  };

  /** Color for a transition target button based on its position in workflow states */
  const buttonVariant = (targetState: string): "default" | "outline" | "secondary" => {
    const idx = states.indexOf(targetState);
    if (idx === states.length - 1) return "default"; // done state gets primary
    return "outline";
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit Task: {task?.id}</DialogTitle></DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <MarkdownField label="Description" value={description} onChange={setDescription} rows={3} />

          {/* Current status display */}
          <div>
            <Label>Current Status</Label>
            <div className="mt-1">
              <Badge variant="secondary" className="text-sm">{task?.status.replace(/_/g, " ")}</Badge>
            </div>
          </div>

          {/* Transition buttons */}
          {validTransitions.length > 0 && (
            <div>
              <Label>Move To</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {validTransitions.map(targetState => (
                  <Button
                    key={targetState}
                    type="button"
                    size="sm"
                    variant={buttonVariant(targetState)}
                    onClick={() => handleMove(targetState)}
                  >
                    {targetState.replace(/_/g, " ")}
                  </Button>
                ))}
              </div>
            </div>
          )}

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

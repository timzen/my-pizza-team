/**
 * ScratchpadPage — A personal scratch pad: a todo list (left 1/3) and a
 * free-form notes doc (right 2/3).
 *
 * Backed by plain files on disk (TODO.jsonl + NOTES.md) via /api/scratchpad.
 * Todos toggle/add/delete immediately; notes save on blur (and via a button
 * when dirty). The assistant can read this when asked.
 */

import { useEffect, useState } from "react";
import { useApi, apiPost, apiPut, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Plus, Trash2, Check, Pencil, Eye } from "lucide-react";

interface TodoItem {
  status: "open" | "done";
  item: string;
  created: string;
  completed: string;
}

interface Scratchpad {
  todos: TodoItem[];
  notes: string;
}

export function ScratchpadPage() {
  const { data, refetch } = useApi<Scratchpad>("/api/scratchpad");
  const todos = data?.todos || [];

  const [newItem, setNewItem] = useState("");

  const addTodo = async () => {
    const item = newItem.trim();
    if (!item) return;
    setNewItem("");
    await apiPost("/api/scratchpad/todos", { item });
    refetch();
  };

  const toggleTodo = async (index: number, done: boolean) => {
    await apiPut(`/api/scratchpad/todos/${index}`, { status: done ? "done" : "open" });
    refetch();
  };

  const deleteTodo = async (index: number) => {
    await apiDelete(`/api/scratchpad/todos/${index}`);
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Scratch Pad</h1>
        <p className="text-sm text-muted-foreground">A quick todo list and notes — your assistant can read these when you ask.</p>
      </div>

      <div className="flex flex-col md:flex-row gap-4">
        {/* Todos — left 1/3 */}
        <div className="md:w-1/3 md:shrink-0">
          <Card>
            <CardContent className="p-4 space-y-3">
              <h2 className="text-sm font-semibold">Todo</h2>

              <div className="flex gap-2">
                <Input
                  placeholder="Add a todo…"
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addTodo(); }}
                />
                <Button size="icon" className="shrink-0" onClick={addTodo} disabled={!newItem.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <ul className="space-y-1">
                {todos.map((todo, i) => (
                  <li key={i} className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/50">
                    <button
                      onClick={() => toggleTodo(i, todo.status !== "done")}
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center ${
                        todo.status === "done" ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40"
                      }`}
                      title={todo.status === "done" ? "Reopen" : "Mark done"}
                    >
                      {todo.status === "done" && <Check className="h-3 w-3" />}
                    </button>
                    <span className={`flex-1 text-sm break-words ${todo.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                      {todo.item}
                    </span>
                    <button
                      onClick={() => deleteTodo(i)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
                {todos.length === 0 && <p className="text-sm text-muted-foreground italic py-2">Nothing here yet.</p>}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Notes — right 2/3 */}
        <div className="md:w-2/3 md:flex-1 min-w-0">
          <NotesEditor notes={data?.notes ?? ""} onSaved={refetch} />
        </div>
      </div>
    </div>
  );
}

/** Free-form markdown notes with an edit/preview toggle; saves on blur. */
function NotesEditor({ notes, onSaved }: { notes: string; onSaved: () => void }) {
  const [value, setValue] = useState(notes);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = value !== notes;

  // Re-seed when the fetched notes change (and we're not mid-edit).
  useEffect(() => {
    if (!editing) setValue(notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await apiPut("/api/scratchpad/notes", { content: value });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between pb-1 border-b border-border">
          <h2 className="text-sm font-semibold">Notes</h2>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-muted-foreground">unsaved</span>}
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => setEditing(!editing)}>
              {editing ? <><Eye className="h-3 w-3" /> Preview</> : <><Pencil className="h-3 w-3" /> Edit</>}
            </Button>
          </div>
        </div>

        {editing ? (
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            placeholder="Jot anything down… (markdown supported)"
            className="font-mono text-sm min-h-[60vh]"
          />
        ) : (
          <div className="min-h-[60vh] cursor-text" onClick={() => setEditing(true)}>
            {value.trim() ? <MarkdownView content={value} /> : <p className="text-sm text-muted-foreground italic">No notes yet. Click to edit.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

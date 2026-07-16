/**
 * daemon/store/scratchpad.ts — Personal scratch pad persistence.
 *
 * A lightweight, human-first scratch pad kept as plain files under the team
 * directory (no SQLite): a todo list and a free-form notes doc.
 *   - `TODO.jsonl` — one JSON object per line: { status, item, created, completed }
 *   - `NOTES.md`   — a free-form markdown document
 *
 * Todos are addressed by their line index (this is a single-user scratch pad,
 * so index addressing is simple and sufficient). Pure functions over a team
 * directory — no database, no shared state.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";

export interface TodoItem {
  status: "open" | "done";
  item: string;
  /** ISO date (YYYY-MM-DD) the item was created. */
  created: string;
  /** ISO date (YYYY-MM-DD) the item was completed, or "" while open. */
  completed: string;
}

const TODO_FILE = "TODO.jsonl";
const NOTES_FILE = "NOTES.md";

/** Today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function todoPath(teamDir: string): string {
  return path.join(teamDir, TODO_FILE);
}

function notesPath(teamDir: string): string {
  return path.join(teamDir, NOTES_FILE);
}

/** Read all todos, skipping any malformed lines. */
export function readTodos(teamDir: string): TodoItem[] {
  const filePath = todoPath(teamDir);
  if (!existsSync(filePath)) return [];
  const todos: TodoItem[] = [];
  for (const line of Deno.readTextFileSync(filePath).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<TodoItem>;
      if (typeof parsed.item !== "string") continue;
      todos.push({
        status: parsed.status === "done" ? "done" : "open",
        item: parsed.item,
        created: typeof parsed.created === "string" ? parsed.created : "",
        completed: typeof parsed.completed === "string" ? parsed.completed : "",
      });
    } catch {
      // Skip unparseable lines rather than throwing on a hand-edited file.
    }
  }
  return todos;
}

/** Overwrite the whole todo list (one JSON object per line). */
function writeTodos(teamDir: string, todos: TodoItem[]): void {
  const body = todos.map((t) => JSON.stringify(t)).join("\n");
  Deno.writeTextFileSync(todoPath(teamDir), todos.length > 0 ? body + "\n" : "");
}

/** Read the notes markdown (empty string if the file doesn't exist yet). */
export function readNotes(teamDir: string): string {
  const filePath = notesPath(teamDir);
  return existsSync(filePath) ? Deno.readTextFileSync(filePath) : "";
}

/** Read the whole scratch pad (todos + notes). */
export function readScratchpad(teamDir: string): { todos: TodoItem[]; notes: string } {
  return { todos: readTodos(teamDir), notes: readNotes(teamDir) };
}

/** Append a new open todo (created = today). Returns the updated list. */
export function addTodo(teamDir: string, item: string): TodoItem[] {
  const todos = readTodos(teamDir);
  todos.push({ status: "open", item, created: today(), completed: "" });
  writeTodos(teamDir, todos);
  return todos;
}

/**
 * Update a todo by index. Toggling to `done` stamps `completed` with today's
 * date; reopening clears it. Returns the updated list, or null if out of range.
 */
export function updateTodo(
  teamDir: string,
  index: number,
  updates: { status?: "open" | "done"; item?: string },
): TodoItem[] | null {
  const todos = readTodos(teamDir);
  const todo = todos[index];
  if (!todo) return null;
  if (typeof updates.item === "string") todo.item = updates.item;
  if (updates.status && updates.status !== todo.status) {
    todo.status = updates.status;
    todo.completed = updates.status === "done" ? today() : "";
  }
  writeTodos(teamDir, todos);
  return todos;
}

/** Delete a todo by index. Returns the updated list, or null if out of range. */
export function deleteTodo(teamDir: string, index: number): TodoItem[] | null {
  const todos = readTodos(teamDir);
  if (index < 0 || index >= todos.length) return null;
  todos.splice(index, 1);
  writeTodos(teamDir, todos);
  return todos;
}

/** Overwrite the notes markdown. */
export function writeNotes(teamDir: string, content: string): void {
  Deno.writeTextFileSync(notesPath(teamDir), content);
}

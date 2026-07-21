/**
 * StorySwimlane — A horizontal swimlane for one story containing its task cards.
 * Groups tasks by workflow state into columns. Each column is a drop target:
 * dragging a card into another column performs a judgment move
 * (POST /api/tasks/:id/move) — the daemon resets substatus/lease on entry.
 * Drops only accept tasks from the same story (the drag MIME type carries the
 * story id, so foreign cards don't even highlight). The implicit todo/done
 * bucket columns can be hidden per story (persisted in localStorage) to give
 * the workflow's own states more room; hidden buckets surface their counts in
 * the header.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { TaskCard, taskDragType } from "./TaskCard";
import { Archive, FolderMinus, Plus, Eye, FoldHorizontal, UnfoldHorizontal } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface StoryData {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  ready: boolean;
  requirements?: Record<string, string | null>;
  /** Where the work happens (plain story data; teammates cd here). */
  directory?: string;
  paused?: boolean;
  workflow?: string;
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    substatus?: "ready" | "claimed" | null;
    description?: string;
    assignee: string | null;
    tokenUsage?: { totalCostUsd: number };
  }>;
}

interface StorySwimlaneProps {
  story: StoryData;
  states: string[];
  onViewStory?: (storyId: string) => void;
  onViewTask?: (taskId: string) => void;
  onAddTask?: (storyId: string) => void;
  onArchive?: (storyId: string) => void;
  onBacklog?: (storyId: string) => void;
  onStatusChange?: () => void;
}

export function StorySwimlane({ story, states, onViewStory, onViewTask, onAddTask, onArchive, onBacklog, onStatusChange }: StorySwimlaneProps) {
  /** The column currently hovered by a same-story drag (for highlight). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Show/hide the implicit todo/done bucket columns to give the workflow's
  // own states more room. Persisted per story so the board remembers.
  const bucketsKey = `mpt-board-buckets-${story.id}`;
  const [showBuckets, setShowBuckets] = useState(() => localStorage.getItem(bucketsKey) !== "hidden");
  const toggleBuckets = () => {
    const next = !showBuckets;
    setShowBuckets(next);
    localStorage.setItem(bucketsKey, next ? "shown" : "hidden");
  };
  // The buckets are always the first/last columns (implicit todo/done).
  const visibleStates = showBuckets ? states : states.filter(s => s !== "todo" && s !== "done");

  const tasksByStatus = new Map<string, typeof story.tasks>();
  for (const state of states) {
    tasksByStatus.set(state, []);
  }
  for (const task of story.tasks) {
    const list = tasksByStatus.get(task.status) || [];
    list.push(task);
    tasksByStatus.set(task.status, list);
  }

  const allDone = story.tasks.length > 0 && story.tasks.every(t => t.status === states[states.length - 1]);
  const todoCount = (tasksByStatus.get("todo") || []).length;
  const doneCount = (tasksByStatus.get("done") || []).length;

  const dragType = taskDragType(story.id);

  /** Accept dragover only for this story's cards (payload is unreadable until
   *  drop, but the MIME *type* — which carries the story id — is visible). */
  const handleDragOver = (state: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(dragType)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(state);
  };

  const handleDrop = (state: string) => async (e: React.DragEvent) => {
    setDropTarget(null);
    const raw = e.dataTransfer.getData(dragType);
    if (!raw) return;
    e.preventDefault();
    const { taskId, fromStatus } = JSON.parse(raw) as { taskId: string; fromStatus: string };
    if (fromStatus === state) return; // dropped back into its own column
    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/move`, { status: state });
    onStatusChange?.();
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Story header (distinct panel color; edit lives on the story page) */}
      <div className="bg-muted px-4 py-2 border-b border-border flex items-center gap-2">
        <Link
          to={`/story/${story.id}`}
          className="font-medium text-sm hover:underline"
        >
          {story.title}
        </Link>
        {!story.ready && (
          <Badge variant="outline" className="text-xs">blocked</Badge>
        )}
        {story.paused && (
          <Badge variant="outline" className="text-xs">paused</Badge>
        )}
        {story.directory && (
          <Badge variant="secondary" className="text-xs font-mono">{story.directory}</Badge>
        )}
        {story.requirements && Object.keys(story.requirements).map(skill => (
          <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {/* Hidden buckets still exist — surface their counts so nothing feels lost. */}
          {!showBuckets && (todoCount > 0 || doneCount > 0) && (
            <span className="text-xs text-muted-foreground mr-1">{todoCount} todo · {doneCount} done</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={toggleBuckets}
            title={showBuckets ? "Hide todo/done columns" : "Show todo/done columns"}
          >
            {showBuckets ? <FoldHorizontal className="h-3.5 w-3.5" /> : <UnfoldHorizontal className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onViewStory?.(story.id)} title="View story">
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onAddTask?.(story.id)} title="Add task">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {allDone && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onArchive?.(story.id)} title="Archive">
              <Archive className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onBacklog?.(story.id)} title="Move to backlog">
            <FolderMinus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid overflow-x-auto border-b border-border" style={{ gridTemplateColumns: `repeat(${visibleStates.length}, minmax(180px, 1fr))` }}>
        {visibleStates.map(state => (
          <div key={state} className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {state.replace(/_/g, " ")}
          </div>
        ))}
      </div>

      {/* Task columns (drop targets for same-story drags) */}
      <div className="grid overflow-x-auto" style={{ gridTemplateColumns: `repeat(${visibleStates.length}, minmax(180px, 1fr))` }}>
        {visibleStates.map(state => (
          <div
            key={state}
            className={`p-2 min-h-[80px] border-r border-border last:border-r-0 transition-colors ${dropTarget === state ? "bg-accent/50" : ""}`}
            onDragOver={handleDragOver(state)}
            onDragLeave={() => setDropTarget(prev => (prev === state ? null : prev))}
            onDrop={handleDrop(state)}
          >
            <div className="flex flex-col gap-2">
              {(tasksByStatus.get(state) || []).map(task => (
                <TaskCard key={task.id} task={task} storyId={story.id} onView={onViewTask} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

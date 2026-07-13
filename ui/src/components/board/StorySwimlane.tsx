/**
 * StorySwimlane — A horizontal swimlane for one story containing its task cards.
 * Groups tasks by workflow state into columns.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { TaskCard } from "./TaskCard";
import { Archive, FolderMinus, Plus, Eye } from "lucide-react";

interface StoryData {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  ready: boolean;
  requirements?: Record<string, string | null>;
  paused?: boolean;
  workflow?: string;
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
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
        {story.requirements && typeof story.requirements.directory === "string" && (
          <Badge variant="secondary" className="text-xs font-mono">{story.requirements.directory}</Badge>
        )}
        {story.requirements && Object.keys(story.requirements).filter(k => k !== "directory").map(skill => (
          <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>
        ))}
        <div className="ml-auto flex items-center gap-1">
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
      <div className="grid overflow-x-auto border-b border-border" style={{ gridTemplateColumns: `repeat(${states.length}, minmax(180px, 1fr))` }}>
        {states.map(state => (
          <div key={state} className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {state.replace(/_/g, " ")}
          </div>
        ))}
      </div>

      {/* Task columns */}
      <div className="grid overflow-x-auto" style={{ gridTemplateColumns: `repeat(${states.length}, minmax(180px, 1fr))` }}>
        {states.map(state => (
          <div key={state} className="p-2 min-h-[80px] border-r border-border last:border-r-0">
            <div className="flex flex-col gap-2">
              {(tasksByStatus.get(state) || []).map(task => (
                <TaskCard key={task.id} task={task} storyId={story.id} states={states} onView={onViewTask} onStatusChange={onStatusChange} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

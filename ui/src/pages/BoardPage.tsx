/**
 * BoardPage — Kanban board with story swimlanes, task cards, filters, and actions.
 *
 * Features:
 * - Story swimlanes with task columns per workflow state
 * - Search/filter by story title or task title
 * - Sort by title, status, or readiness
 * - Add story modal (editing a story lives on its /story page)
 * - Add task modal
 * - Read-only task preview modal (editing lives on the task page)
 * - Archive and backlog buttons per story
 * - Spawn teammate dialog
 */

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi, apiPost } from "@/hooks/useApi";
import { StorySwimlane } from "@/components/board/StorySwimlane";
import { AddStoryDialog } from "@/components/board/AddStoryDialog";
import { AddTaskDialog } from "@/components/board/AddTaskDialog";
import { TaskViewDialog } from "@/components/board/TaskViewDialog";
import { StoryViewDialog } from "@/components/board/StoryViewDialog";
import { Search } from "lucide-react";

interface StoryView {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  ready: boolean;
  requirements?: Record<string, string | null>;
  paused?: boolean;
  workflow?: string;
  context?: string[];
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    substatus?: "ready" | "claimed" | null;
    description?: string;
    assignee: string | null;
    tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  }>;
}

interface StatusData {
  defaultWorkflow: string;
  workflows: Record<string, { states: Array<{ name: string; type: "agent" | "manual" }> }>;
}

type SortOption = "title" | "status" | "ready";


export function BoardPage() {
  const { data: storiesData, refetch } = useApi<{ stories: StoryView[] }>("/api/stories", [], { pollInterval: 5000 });
  const { data: statusData } = useApi<StatusData>("/api/status", [], { pollInterval: 5000 });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("ready");
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [viewStoryId, setViewStoryId] = useState<string | null>(null);
  const [addTaskStoryId, setAddTaskStoryId] = useState<string | null>(null);

  const stories = storiesData?.stories || [];
  const taskCount = stories.reduce((n, s) => n + (s.tasks?.length || 0), 0);
  const defaultWorkflow = statusData?.defaultWorkflow || "default";
  const workflows = statusData?.workflows || {};

  /** Board columns for a workflow: the implicit buckets around its active states. */
  const columnsFor = (wfName: string | undefined): string[] => {
    const wf = (wfName && workflows[wfName]) || workflows[defaultWorkflow];
    const active = wf?.states?.map(s => s.name) || ["in_progress", "review"];
    return ["todo", ...active, "done"];
  };

  /** Resolve board columns for a given story (falls back to default workflow) */
  const getStatesForStory = (story: StoryView): string[] => columnsFor(story.workflow);
  // Filter stories by search
  const filtered = useMemo(() => {
    let result = stories;

    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.tasks.some(t => t.title.toLowerCase().includes(q))
      );
    }

    return result;
  }, [stories, search]);

  // Sort stories
  const sorted = useMemo(() => {
    const copy = [...filtered];
    switch (sort) {
      case "title": return copy.sort((a, b) => a.title.localeCompare(b.title));
      case "status": return copy.sort((a, b) => a.status.localeCompare(b.status));
      case "ready": return copy.sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || a.title.localeCompare(b.title));
      default: return copy;
    }
  }, [filtered, sort]);

  // Find data for the read-only task preview modal
  const viewTaskStory = stories.find(s => s.tasks.some(t => t.id === viewTaskId)) || null;
  const viewTask = viewTaskStory?.tasks.find(t => t.id === viewTaskId) || null;
  const viewStory = stories.find(s => s.id === viewStoryId) || null;

  const handleArchive = async (storyId: string) => {
    if (!confirm(`Archive story "${storyId}"? Tasks not in 'done' will be force-completed.`)) return;
    await apiPost(`/api/stories/${storyId}/archive`, { force: true });
    refetch();
  };

  const handleBacklog = async (storyId: string) => {
    if (!confirm(`Move "${storyId}" to backlog?`)) return;
    await apiPost(`/api/stories/${storyId}/backlog`);
    refetch();
  };

  return (
    <div className="container mx-auto p-4 space-y-4">
      {/* Header: title + story/task counts */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Board</h1>
        <div className="text-sm text-muted-foreground">
          {stories.length} {stories.length === 1 ? "story" : "stories"} · {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search stories & tasks..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ready">Ready first</SelectItem>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="status">Status</SelectItem>
          </SelectContent>
        </Select>
        <AddStoryDialog onCreated={refetch} />
      </div>

      {/* Swimlanes */}
      <div className="space-y-3">
        {sorted.map(story => (
          <StorySwimlane
            key={story.id}
            story={story}
            states={getStatesForStory(story)}
            onViewStory={setViewStoryId}
            onViewTask={setViewTaskId}
            onAddTask={setAddTaskStoryId}
            onArchive={handleArchive}
            onBacklog={handleBacklog}
            onStatusChange={refetch}
          />
        ))}
        {sorted.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            {search ? "No stories match your search." : "No stories yet. Create one to get started."}
          </p>
        )}
      </div>

      {/* Dialogs */}
      <TaskViewDialog task={viewTask} storyId={viewTaskStory?.id ?? null} open={!!viewTaskId} onClose={() => setViewTaskId(null)} />
      <StoryViewDialog story={viewStory} open={!!viewStoryId} onClose={() => setViewStoryId(null)} />
      <AddTaskDialog storyId={addTaskStoryId} open={!!addTaskStoryId} onClose={() => setAddTaskStoryId(null)} onCreated={refetch} />
    </div>
  );
}

/**
 * BoardPage — Kanban board with story swimlanes, task cards, filters, and actions.
 *
 * Features:
 * - Story swimlanes with task columns per workflow state
 * - Search/filter by story title or task title
 * - Sort by title, status, or readiness
 * - Add/edit story modals
 * - Add/edit task modals
 * - Archive and backlog buttons per story
 * - Spawn teammate dialog
 */

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi, apiPost } from "@/hooks/useApi";
import { StorySwimlane } from "@/components/board/StorySwimlane";
import { AddStoryDialog } from "@/components/board/AddStoryDialog";
import { EditStoryDialog } from "@/components/board/EditStoryDialog";
import { AddTaskDialog } from "@/components/board/AddTaskDialog";
import { EditTaskDialog } from "@/components/board/EditTaskDialog";
import { SpawnDialog } from "@/components/board/SpawnDialog";
import { Search } from "lucide-react";

interface StoryView {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  ready: boolean;
  dir?: string;
  workflow?: string;
  categories?: string[];
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    description?: string;
    assignee: string | null;
    hasMessages: boolean;
    tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  }>;
}

interface StatusData {
  defaultWorkflow: string;
  workflows: Record<string, { states: string[] }>;
}

type SortOption = "title" | "status" | "ready";

export function BoardPage() {
  const { data: storiesData, refetch } = useApi<{ stories: StoryView[] }>("/api/stories");
  const { data: statusData } = useApi<StatusData>("/api/status");

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("ready");
  const [editStoryId, setEditStoryId] = useState<string | null>(null);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [addTaskStoryId, setAddTaskStoryId] = useState<string | null>(null);

  const stories = storiesData?.stories || [];
  const defaultWorkflow = statusData?.defaultWorkflow || "default";
  const workflows = statusData?.workflows || {};
  const states = workflows[defaultWorkflow]?.states || ["todo", "in_progress", "needs_input", "review", "done"];

  // Filter stories by search
  const filtered = useMemo(() => {
    if (!search) return stories;
    const q = search.toLowerCase();
    return stories.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.tasks.some(t => t.title.toLowerCase().includes(q))
    );
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

  // Find data for edit dialogs
  const editStory = stories.find(s => s.id === editStoryId) || null;
  const editTask = stories.flatMap(s => s.tasks).find(t => t.id === editTaskId) || null;

  const handleArchive = async (storyId: string) => {
    if (!confirm(`Archive story "${storyId}"?`)) return;
    await apiPost(`/api/stories/${storyId}/archive`);
    refetch();
  };

  const handleBacklog = async (storyId: string) => {
    if (!confirm(`Move "${storyId}" to backlog?`)) return;
    await apiPost(`/api/stories/${storyId}/backlog`);
    refetch();
  };

  return (
    <div className="container mx-auto p-4 space-y-4">
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
        <SpawnDialog />
      </div>

      {/* Column headers */}
      <div className="grid overflow-x-auto border-b border-border pb-1" style={{ gridTemplateColumns: `repeat(${states.length}, minmax(180px, 1fr))` }}>
        {states.map(state => (
          <div key={state} className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-2">
            {state.replace(/_/g, " ")}
          </div>
        ))}
      </div>

      {/* Swimlanes */}
      <div className="space-y-3">
        {sorted.map(story => (
          <StorySwimlane
            key={story.id}
            story={story}
            states={states}
            onEditStory={setEditStoryId}
            onEditTask={setEditTaskId}
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
      <EditStoryDialog story={editStory} open={!!editStoryId} onClose={() => setEditStoryId(null)} onUpdated={refetch} />
      <EditTaskDialog task={editTask} states={states} open={!!editTaskId} onClose={() => setEditTaskId(null)} onUpdated={refetch} />
      <AddTaskDialog storyId={addTaskStoryId} open={!!addTaskStoryId} onClose={() => setAddTaskStoryId(null)} onCreated={refetch} />
    </div>
  );
}

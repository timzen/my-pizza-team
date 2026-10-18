/**
 * BoardPage — Kanban board with story swimlanes, task cards, filters, and actions.
 *
 * Features:
 * - Story swimlanes with task columns per workflow state
 * - Search/filter by story title or task title
 * - Sort by title, status, or readiness
 * - Links to the full-page create forms (/stories/new, /story/:id/tasks/new)
 *   — no modals; viewing/editing stories and tasks lives on their pages
 * - Archive and pending ⇄ active buttons per story
 * - Expand/collapse per story (chevron) plus Expand all / Collapse all over the
 *   visible stories; state is lifted here (`useStoryCollapse`) and persisted
 *   per story in localStorage. Search does not auto-expand collapsed stories.
 * - Lives at Work Items → Board (`/work-items/board`, under the WorkItemsTabs
 *   bar) and shows **active** stories only. Work Items → Pending
 *   (pages/PendingPage.tsx) embeds the same board as `StoryBoard
 *   view="pending"`, so a task finishing in a just-paused story stays visible;
 *   archived stories are on Work Items → Archived.
 */

import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi, apiPost } from "@/hooks/useApi";
import { StorySwimlane } from "@/components/board/StorySwimlane";
import { WorkItemsTabs } from "@/components/WorkItemsTabs";
import { useStoryCollapse } from "@/hooks/useStoryCollapse";
import { Search, Plus, ChevronsDownUp, ChevronsUpDown } from "lucide-react";

interface StoryView {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  ready: boolean;
  directory?: string;
  pending?: boolean;
  workflow?: string;
  context?: string[];
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    pending?: boolean;
    workItemState?: "READY" | "IN_PROGRESS" | "MORIBUND" | "COMPLETE" | "FAILED" | "CANCELED" | null;
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


/** Which lifecycle view of the stories this board shows. */
export type BoardView = "active" | "pending";

/** Work Items → Board: the tab bar over the board of active stories. */
export function BoardPage() {
  return (
    <div className="container mx-auto p-4 space-y-4">
      <WorkItemsTabs />
      <StoryBoard view="active" />
    </div>
  );
}

/**
 * The story board itself — counts, toolbar, and swimlanes — for one lifecycle
 * view: active stories (the Board tab) or pending ones (the Pending tab).
 */
export function StoryBoard({ view }: { view: BoardView }) {
  const { data: storiesData, refetch } = useApi<{ stories: StoryView[] }>("/api/stories", [], { pollInterval: 5000 });
  const { data: statusData } = useApi<StatusData>("/api/status", [], { pollInterval: 5000 });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("ready");
  const { isCollapsed, setCollapsed, setAllCollapsed } = useStoryCollapse();

  // The Board shows active stories, the Pending tab pending ones.
  const stories = useMemo(
    () => (storiesData?.stories || []).filter(s => !!s.pending === (view === "pending")),
    [storiesData, view],
  );
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
  const handleArchive = async (storyId: string) => {
    if (!confirm(`Archive story "${storyId}"? Tasks not in 'done' will be force-completed.`)) return;
    await apiPost(`/api/stories/${storyId}/archive`, { force: true });
    refetch();
  };

  /** Pending ⇄ active. Pending stops new work only; an in-flight task finishes. */
  const handleTogglePending = async (storyId: string, pending: boolean) => {
    if (pending && !confirm(`Make "${storyId}" pending? Nothing new is handed out until it's activated (a task already running finishes).`)) return;
    await apiPost(`/api/stories/${storyId}/${pending ? "pending" : "activate"}`);
    refetch();
  };

  return (
    <div className="space-y-4">
      {/* Toolbar (story/task counts at the right) */}
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
        {/* Bulk expand/collapse applies to the stories currently shown (after search). */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAllCollapsed(sorted.map(s => s.id), false)}
          disabled={sorted.length === 0}
          title="Expand all visible stories"
        >
          <ChevronsUpDown className="h-4 w-4 mr-1" /> Expand all
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAllCollapsed(sorted.map(s => s.id), true)}
          disabled={sorted.length === 0}
          title="Collapse all visible stories"
        >
          <ChevronsDownUp className="h-4 w-4 mr-1" /> Collapse all
        </Button>
        <AddStoryButton />
        <div className="ml-auto text-sm text-muted-foreground">
          {stories.length} {stories.length === 1 ? "story" : "stories"} · {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </div>
      </div>

      {/* Swimlanes */}
      <div className="space-y-3">
        {sorted.map(story => (
          <StorySwimlane
            key={story.id}
            story={story}
            states={getStatesForStory(story)}
            onArchive={handleArchive}
            onTogglePending={handleTogglePending}
            onStatusChange={refetch}
            collapsed={isCollapsed(story.id)}
            onToggleCollapsed={c => setCollapsed(story.id, c)}
          />
        ))}
        {sorted.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            {search
              ? "No stories match your search."
              : view === "pending"
                ? "No pending stories. Make a story pending to hold it without losing its place."
                : "No stories yet. Create one to get started."}
          </p>
        )}
      </div>
    </div>
  );
}

/** Link to the full-page story creation form. */
function AddStoryButton() {
  return (
    <Button size="sm" render={<Link to="/stories/new" />}>
      <Plus className="h-4 w-4 mr-1" /> Add Story
    </Button>
  );
}

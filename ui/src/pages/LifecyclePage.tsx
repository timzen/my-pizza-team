/**
 * LifecyclePage — Work → Pending (`/work/pending`) and Work →
 * Archived (`/work/archived`): one mixed list of the stories, standalone
 * tasks, and scheduled jobs in that state (docs/DESIGN.md "Pending: Write,
 * Review, Activate"). Board, Tasks, and Schedule list active work only, so
 * this is where held-back work is activated and retired work restored.
 *
 * Each row: a type badge (Story / Task / Schedule), the title (→ its detail
 * page), its directory, and a timestamp when one is known. The rows, the kind
 * rules, and the newest-first order come from lib/lifecycle-list.ts.
 *
 * - **Filter chips** — Stories · Tasks · Schedules, multi-select, all on by
 *   default; a switched-off kind's chip (and rows) is hidden (hooks/useFeatures).
 *   Plus a text search over title, id, and directory.
 * - **Pending rows** — **Activate** (a story resumes, reversible; a task's or
 *   job's definition locks, one-way; a job held only by its Schedule resumes at
 *   its next cron time) and **Archive**.
 * - **Archived rows** — tasks and jobs have **Restore** and **Delete**. There's
 *   no unarchive for stories (the API has none), so an archived story's row
 *   expands to show its synopsis instead of linking to a detail page.
 *
 * The data is composed client-side from the existing list endpoints (see
 * lib/lifecycle-list.ts). Replaced the per-kind-section PendingPage and
 * ArchivedPage (and, before them, the Board's Pending/Backlog and Archive
 * tabs).
 *
 * Empty, each explains what lands there and offers the next step — Pending:
 * the chat (ask it to write work up as pending) and the first create form the
 * team has on; Archived: the Board (or Tasks), where things are archived from.
 * Chips or a search that leave nothing say "Nothing matches the filters." with
 * Clear filters instead (docs/DESIGN.md "An Empty Screen Teaches").
 */

import { Link } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useFeatures } from "@/hooks/useFeatures";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import {
  KIND_BADGES, LIFECYCLE_KINDS, archivedRows, countByKind, enabledKinds, filterRows, pendingRows, sortNewestFirst, toggleKind,
  type ActivateTarget, type ArchivedStoryLike, type LifecycleKind, type LifecycleRow, type LifecycleState, type ScheduleLike, type StoryLike, type WorkDefLike,
} from "@/lib/lifecycle-list";
import { Archive, ArchiveRestore, CalendarClock, ChevronDown, ChevronRight, Clock, FolderOpen, Search, Send, Trash2 } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { AskAssistantButton, EmptyState, NoMatches } from "@/components/ui/empty-state";
import { listView } from "@/lib/empty-states";
import { filterByFeatures } from "@/lib/features";
import { START_WORK } from "@/lib/start-work";
import { useConfirm } from "@/components/ui/confirm-dialog";

const POLL_MS = 10_000;

const INTRO: Record<LifecycleState, string> = {
  pending: "Work held back until you activate it. Nothing here is handed out or fires.",
  archived: "Retired work, preserved for reference.",
};

/** Work → Pending or Archived: the tab bar, chips, search, and the mixed list. */
export function LifecyclePage({ state }: { state: LifecycleState }) {
  const features = useFeatures();
  const enabled = enabledKinds(features);
  const [selected, setSelected] = useState<LifecycleKind[]>(["story", "task", "schedule"]);
  const [query, setQuery] = useState("");
  const [confirmDialog, confirm] = useConfirm();
  const announce = useAnnounce();

  // Only fetch what the team has switched on (a switched-off kind's routes 403).
  const wantStories = !!features?.stories;
  const wantDefs = !!(features?.tasks || features?.schedules);
  const archived = state === "archived";
  const { data: storiesData, refetch: refetchStories } = useApi<{ stories: StoryLike[] }>(
    wantStories && !archived ? "/api/stories" : null, [wantStories, archived], { pollInterval: POLL_MS });
  const { data: archivedData } = useApi<{ stories: ArchivedStoryLike[] }>(
    wantStories && archived ? "/api/archived" : null, [wantStories, archived], { pollInterval: POLL_MS });
  const { data: defsData, refetch: refetchDefs } = useApi<{ workDefs: WorkDefLike[] }>(
    wantDefs ? (archived ? "/api/work-defs?status=archived" : "/api/work-defs") : null, [wantDefs, archived], { pollInterval: POLL_MS });
  const { data: schedData, refetch: refetchSchedules } = useApi<{ schedules: ScheduleLike[] }>(
    features?.schedules ? "/api/schedules" : null, [features?.schedules], { pollInterval: POLL_MS });

  const defs = defsData?.workDefs || [];
  const schedules = schedData?.schedules || [];
  const rows = archived
    ? archivedRows(archivedData?.stories || [], defs, schedules)
    : pendingRows(storiesData?.stories || [], defs, schedules);
  // A switched-off kind's rows never show, whatever the chips say.
  const allRows = filterRows(rows, enabled);
  const counts = countByKind(allRows);
  const shown = sortNewestFirst(filterRows(allRows, selected, query));
  // Loaded once every list this page asked for has answered.
  const loaded = !!features
    && (!wantStories || !!(archived ? archivedData : storiesData))
    && (!wantDefs || !!defsData)
    && (!features.schedules || !!schedData);
  const view = listView({ loaded, total: allRows.length, shown: shown.length });
  const clearFilters = () => { setSelected(["story", "task", "schedule"]); setQuery(""); };

  const refetchAll = () => { refetchStories(); refetchDefs(); refetchSchedules(); };

  /** Activate a pending row — see lib/lifecycle-list.ts `pendingRows` for which target. */
  const activate = async (t: ActivateTarget) => {
    const base = t.kind === "story" ? "/api/stories" : t.kind === "schedule" ? "/api/schedules" : "/api/work-defs";
    const res = await apiPost<{ success?: boolean; error?: string }>(`${base}/${encodeURIComponent(t.id)}/activate`, {});
    announce(res.success === false ? res.error || "Couldn't activate it" : "Activated", res.success === false ? "assertive" : "polite");
    refetchAll();
  };
  const archive = async (row: LifecycleRow) => {
    if (row.kind === "story") {
      if (!(await confirm({
        title: `Archive story "${row.id}"?`,
        description: "Tasks not in 'done' will be force-completed.",
        confirmLabel: "Archive",
      }))) return;
      await apiPost(`/api/stories/${encodeURIComponent(row.id)}/archive`, { force: true });
    } else {
      await apiPost(`/api/work-defs/${encodeURIComponent(row.id)}/archive`, {});
    }
    announce(`Archived ${row.title}`);
    refetchAll();
  };
  const restore = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/restore`, {});
    announce("Restored");
    refetchDefs();
  };
  const remove = async (row: LifecycleRow) => {
    if (!(await confirm({ title: `Delete "${row.title}" for good?`, confirmLabel: "Delete", destructive: true }))) return;
    await apiDelete(`/api/work-defs/${encodeURIComponent(row.id)}`);
    announce(`Deleted ${row.title}`);
    refetchDefs();
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      {confirmDialog}
      <p className="text-sm text-muted-foreground">{INTRO[state]}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {LIFECYCLE_KINDS.filter(k => enabled.includes(k.kind)).map(({ kind, label }) => (
          <Tooltip key={kind} content={`Show ${label.toLowerCase()}`}>
            <Button
              size="sm"
              variant={selected.includes(kind) ? "default" : "outline"}
              aria-pressed={selected.includes(kind)}
              onClick={() => setSelected(s => toggleKind(s, kind))}
            >
              {label} ({counts[kind]})
            </Button>
          </Tooltip>
        ))}
        <div className="relative ml-auto min-w-[200px]">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} className="pl-9 h-8" aria-label={`Search ${state} work`} />
        </div>
      </div>

      <div className="grid gap-3">
        {shown.map(row => (
          <LifecycleRowCard key={`${row.kind}:${row.id}`} row={row}>
            {state === "pending" ? (
              <>
                <Tooltip content="Archive" describe={false}>
                  <Button variant="ghost" size="sm" onClick={() => archive(row)} aria-label="Archive"><Archive className="h-3.5 w-3.5" /></Button>
                </Tooltip>
                {row.activate && (
                  <Tooltip content={activateTitle(row.activate)}>
                    <Button size="sm" onClick={() => activate(row.activate!)}>
                      <Send className="h-3.5 w-3.5 mr-1" />Activate
                    </Button>
                  </Tooltip>
                )}
              </>
            ) : row.kind !== "story" && (
              <>
                <Tooltip content="Back to its tab">
                  <Button variant="outline" size="sm" onClick={() => restore(row.id)}><ArchiveRestore className="h-3.5 w-3.5 mr-1" />Restore</Button>
                </Tooltip>
                <Tooltip content="Delete for good" describe={false}>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(row)} aria-label="Delete for good"><Trash2 className="h-3.5 w-3.5" /></Button>
                </Tooltip>
              </>
            )}
          </LifecycleRowCard>
        ))}
        {view === "empty" && <LifecycleEmpty state={state} />}
        {view === "no-matches" && <NoMatches onClear={clearFilters} />}
      </div>
    </WorkItemsLayout>
  );
}

/**
 * Nothing pending / archived: what the tab holds, and where such work comes
 * from — Pending: the chat (ask for it "as pending") and a create form, whose
 * Pending box holds it; Archived: the Board (or Tasks), where it's archived from.
 */
function LifecycleEmpty({ state }: { state: LifecycleState }) {
  const features = useFeatures();
  const create = filterByFeatures(START_WORK, features)[0];
  if (state === "pending") {
    return (
      <EmptyState kind="pending" icon={Clock}>
        <AskAssistantButton label="Ask the assistant to write some up" variant="default" />
        {create && <Button size="sm" variant="outline" render={<Link to={create.to} />}><create.icon className="mr-1 h-3.5 w-3.5" aria-hidden />{create.label}</Button>}
      </EmptyState>
    );
  }
  const from = features?.stories ? { to: "/work/board", label: "Go to the Board" } : features?.tasks ? { to: "/work/tasks", label: "Go to Tasks" } : null;
  return (
    <EmptyState kind="archived" icon={Archive}>
      {from && <Button size="sm" variant="outline" render={<Link to={from.to} />}>{from.label}</Button>}
    </EmptyState>
  );
}

/** Why Activate does what it does, per target (the button's tooltip). */
function activateTitle(t: ActivateTarget): string {
  switch (t.kind) {
    case "story": return "Resume the story where it left off";
    case "schedule": return "Resume the schedule at its next cron time (missed runs are not back-filled)";
    case "workDef": return "Lock the definition (a task is enqueued now; a job fires on its next cron time once its schedule is active)";
  }
}

/** One row: type badge, title (→ detail page), directory/cron, timestamp, and its actions. */
function LifecycleRowCard({ row, children }: { row: LifecycleRow; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant="outline" className="text-[10px] shrink-0">{KIND_BADGES[row.kind]}</Badge>
        <p className="font-medium truncate">{row.title}</p>
      </div>
      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
        {row.cron && <Badge variant="outline" className="text-[10px] flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" /><code>{row.cron}</code></Badge>}
        {row.directory && (
          <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{row.directory}</Badge>
        )}
        {row.at && <Tooltip content={row.at} describe={false}><span>{row.atLabel} {new Date(row.at).toLocaleString()}</span></Tooltip>}
      </div>
    </>
  );
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {row.href ? (
            <Link to={row.href} className="min-w-0 flex-1">{body}</Link>
          ) : (
            // An archived story has no detail page: the row toggles its synopsis.
            <button type="button" onClick={() => setOpen(o => !o)} className="min-w-0 flex-1 text-left flex items-start gap-1" aria-expanded={open}>
              {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
              <div className="min-w-0 flex-1">{body}</div>
            </button>
          )}
          {children}
        </div>
        {open && (
          <pre className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground bg-muted p-3 rounded max-h-48 overflow-y-auto">
            {row.synopsis || "No synopsis available."}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

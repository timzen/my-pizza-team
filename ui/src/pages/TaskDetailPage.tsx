/**
 * TaskDetailPage — Full board-task view (`/task/:storyId/:taskId`).
 *
 * A board task IS a WorkDef (parent = its story), so this page mirrors the
 * WorkDefDetailPage format: two tabs below the title — **Details** (title, goal,
 * acceptance criteria, additional context, directory, and its runs — each
 * with the persona its workflow state gave it) and **Thread**
 * (the run thread — comments + attachments, newest first). Details is the
 * default; the Inbox deep-links to `?tab=thread`. The board-specific concerns
 * layered on top are the story breadcrumb, the workflow status + move buttons,
 * and delete (which routes through the task endpoint so the story's task list +
 * CONWIP token are cleaned up). A task in a poll state shows its poll status
 * (lib/poll-status.ts: waiting with the next check, held with the readiness
 * probe's reason, a check running, or — after a manual timeout — "Needs
 * attention" with **Mark done**, the move a done check would make) and a
 * **Check now** button (`POST /api/tasks/:id/check-now`; docs/DESIGN.md
 * "Polling States"): disabled with the reason while a check is queued or
 * running, and the daemon's refusal (e.g. the team isn't ready) shown beside it.
 *
 * The definition is `WorkDefDefinition`: a **pending** task can be edited and
 * activated (it holds its place in the story until then); an active one is
 * locked — rework goes through the Thread and a move back into a teammate state
 * (docs/DESIGN.md "Pending: Write, Review, Activate").
 *
 * Comments live on the WorkDef's ref (same comments.jsonl the agents append
 * completion summaries to). The Thread tab is the shared `components/RunThread`
 * (attachments stay clickable — opening the diff/file viewer with line-level
 * review). The header's run-count badge
 * (`executionCount`) counts this task's WorkItems, rework runs included
 * (docs/DESIGN.md "Execution Count: Derived, not Counted").
 */

import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WorkDefDefinition, PendingBadge } from "@/components/WorkDefDefinition";
import { RunHistory } from "@/components/RunHistory";
import { RunThread } from "@/components/RunThread";
import { runCountLabel } from "@/lib/run-count";
import { DetailTabBar, useDetailTab } from "@/components/ui/detail-tabs";
import { DetailPageLayout, DetailPageMessage } from "@/components/TabbedPageLayout";
import { Trash2 } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import type { Comment, WorkflowState } from "@shared/types";
import type { CheckNowResponse, StoryView, TaskPollView, WorkDefView } from "@shared/protocol";
import { checkNowBlockedReason, checkNowRefusal, pollChip } from "@/lib/poll-status";
import { Tooltip } from "@/components/ui/tooltip";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormError } from "@/components/ui/form-error";
import { useAnnounce } from "@/hooks/useAnnounce";

type WorkDef = WorkDefView;

interface StatusData {
  defaultWorkflow: string;
  workflows: Record<string, { states: WorkflowState[]; transitions?: Record<string, Record<string, string>> }>;
}

export function TaskDetailPage() {
  const { storyId, taskId } = useParams<{ storyId: string; taskId: string }>();
  const navigate = useNavigate();
  const { data: defData, refetch: refetchDef } = useApi<{ workDef?: WorkDef }>(`/api/work-defs/${encodeURIComponent(taskId || "")}`, [taskId]);
  const { data: storiesData, refetch: refetchStories } = useApi<{ stories: StoryView[] }>("/api/stories");
  const { data: statusData } = useApi<StatusData>("/api/status");
  const { data: commentsData, refetch: refetchComments } = useApi<{ comments: Comment[] }>(
    `/api/work-defs/${encodeURIComponent(taskId || "")}/comments`, [], { pollInterval: 5000 }
  );

  const def = defData?.workDef;
  const story = storiesData?.stories.find(s => s.id === storyId);
  const task = story?.tasks.find(t => t.id === taskId);
  const comments = commentsData?.comments || [];
  useDocumentTitle([def?.title ?? taskId ?? "Task", "Task"]);
  const [confirmDialog, confirm] = useConfirm();

  const [tab, setTab] = useDetailTab();

  const [editError, setEditError] = useState("");
  const announce = useAnnounce();

  // Resolve workflow states/transitions for this task's story.
  const workflows = statusData?.workflows || {};
  const defaultWorkflow = statusData?.defaultWorkflow || "default";
  const wfName = story?.workflow && workflows[story.workflow] ? story.workflow : defaultWorkflow;
  const states = (workflows[wfName]?.states || []).map((s) => s.name);
  const transitions = workflows[wfName]?.transitions || {};
  const validTransitions = task ? Object.keys(transitions[task.status] || {}) : [];

  const definitionChanged = () => {
    refetchDef();
    refetchStories();
  };

  const moveTask = async (targetStatus: string) => {
    if (!taskId) return;
    setEditError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}/move`, { status: targetStatus });
    if (!res.success) { setEditError(res.error || "Failed to move"); return; }
    announce(`Moved to ${targetStatus.replace(/_/g, " ")}`);
    refetchStories();
  };

  // Check now: busy while asking; a refusal (409 — e.g. the team isn't ready)
  // shows beside the button until the next ask.
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const checkNow = async () => {
    if (!taskId) return;
    setChecking(true);
    setCheckError("");
    try {
      const res = await apiPost<CheckNowResponse>(`/api/tasks/${encodeURIComponent(taskId)}/check-now`, {});
      if (!res.success) { setCheckError(checkNowRefusal(res)); return; }
      announce("Check queued");
      refetchStories();
    } catch (e) {
      setCheckError("Network error: " + (e as Error).message);
    } finally { setChecking(false); }
  };

  const deleteTask = async () => {
    if (!taskId || !(await confirm({ title: `Delete task "${taskId}"?`, confirmLabel: "Delete", destructive: true }))) return;
    // Delete via the task endpoint: it drops the task from the story's list and
    // frees the CONWIP token (the plain WorkDef delete wouldn't).
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.success) { announce(`Deleted task ${taskId}`); navigate("/work/board", { replace: true }); }
    else setEditError(res.error || "Failed to delete");
  };

  if (!def || !task) {
    return (
      <DetailPageMessage>Task not found. <Link to="/work/board" className="underline">Back to board</Link></DetailPageMessage>
    );
  }

  return (
    // Fixed header (DetailPageLayout), left-aligned like WorkDefDetailPage.
    <DetailPageLayout
      headerClassName="max-w-3xl"
      bodyClassName="max-w-3xl"
      tabs={<DetailTabBar tab={tab} onChange={setTab} threadCount={comments.length} />}
      header={<>
      {confirmDialog}
      {/* Top bar: breadcrumb + status + save/delete */}
      <div className="flex items-center gap-3">
        <BackButton fallback="/work/board" title="Back to board" />
        <h1 className="text-2xl font-bold flex-1">{def.title}</h1>
        {def.pending && <PendingBadge />}
        <Tooltip content={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this yet"} focusable>
          <Badge variant="outline">
            {runCountLabel(def.executionCount)}
          </Badge>
        </Tooltip>
        <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="font-mono">
          /<Link to={`/story/${storyId}`} className="text-primary hover:underline">{storyId}</Link>/{taskId}
        </Badge>
        {task.assignee && <span className="text-sm text-muted-foreground">Assigned to <strong>{task.assignee}</strong></span>}
      </div>
      </>}
    >

      {tab === "details" && (
      <div className="space-y-4">
        <WorkDefDefinition
          def={def}
          onChanged={definitionChanged}
          actions={<Button variant="destructive" onClick={deleteTask}><Trash2 className="h-4 w-4 mr-1" />Delete</Button>}
        />

        {/* Workflow moves */}
        {validTransitions.length > 0 && (
          <div className="flex items-center justify-end gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Move to:</span>
            {validTransitions.map(target => (
              <Button
                key={target}
                type="button"
                size="sm"
                variant={states.indexOf(target) === states.length - 1 ? "default" : "outline"}
                onClick={() => moveTask(target)}
              >
                {target.replace(/_/g, " ")}
              </Button>
            ))}
          </div>
        )}

        {/* Poll state: what it's doing between checks, and Check now. */}
        {task.poll && (
          <PollPanel
            poll={task.poll}
            workItemState={task.workItemState}
            blocked={checkNowBlockedReason(task, checking)}
            checkError={checkError}
            onCheckNow={checkNow}
            nextState={nextStateName(states, task.status)}
            onMarkDone={moveTask}
          />
        )}

        <RunHistory workDefId={def.id} />

        <FormError className="text-sm">{editError}</FormError>
      </div>
      )}

      {/* Run thread — human notes, agent completion summaries, and attachments,
          newest first. */}
      <RunThread
        workDefId={def.id}
        comments={comments}
        onCommentsChanged={refetchComments}
        visible={tab === "thread"}
        author="lead"
        sendOnCmdEnter
      />
    </DetailPageLayout>
  );
}

/** Where a done check would move a task in `status`: the next state, or done after the last. */
function nextStateName(states: string[], status: string): string {
  const i = states.indexOf(status);
  return (i >= 0 && states[i + 1]) || "done";
}

/**
 * The task page's poll panel: the status in words (waiting with the next
 * check and the last wait reason, held with the probe's reason, a check
 * running, or "Needs attention: polling timed out" with Mark done), and the
 * Check now button — disabled, with the reason as its tooltip, while a check
 * is in flight; the daemon's refusal shows beside it.
 */
function PollPanel({ poll, workItemState, blocked, checkError, onCheckNow, nextState, onMarkDone }: {
  poll: TaskPollView;
  workItemState?: string | null;
  blocked: string | null;
  checkError: string;
  onCheckNow: () => void;
  nextState: string;
  onMarkDone: (target: string) => void;
}) {
  const chip = workItemState ? null : pollChip(poll);
  const running = workItemState === "IN_PROGRESS" ? "A check is running." : workItemState ? "A check is queued." : null;
  const needsYou = chip?.kind === "needs-you";
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${needsYou ? "border-amber-500 bg-amber-50 dark:bg-amber-950/40" : "border-border"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-0 text-sm">
          <p className={needsYou ? "font-semibold text-amber-800 dark:text-amber-300" : "font-medium"}>
            {running ?? chip?.label ?? "Polling"}
            {chip?.count && <span className="ml-2 text-xs font-normal text-muted-foreground">{chip.count}</span>}
          </p>
          {chip && <p className="text-xs text-muted-foreground">{chip.title}</p>}
          {!chip && poll.lastWaitReason && <p className="text-xs text-muted-foreground">Last check: {poll.lastWaitReason}</p>}
        </div>
        {needsYou && (
          <Button type="button" size="sm" onClick={() => onMarkDone(nextState)}>
            Mark done (move to {nextState.replace(/_/g, " ")})
          </Button>
        )}
        <Tooltip content={blocked ?? "Run one check now, outside the schedule"}>
          <Button
            type="button" size="sm" variant="outline" onClick={onCheckNow}
            disabled={blocked !== null} focusableWhenDisabled
          >
            Check now
          </Button>
        </Tooltip>
      </div>
      <FormError id="check-now-error" className="text-xs">{checkError}</FormError>
    </div>
  );
}

/**
 * WorkDefDetailPage — View, edit, run, and delete a WorkDef (`/work-defs/:id`).
 *
 * The WorkDef is the home for a Solitary/Scheduled job's rich detail, split
 * into two tabs below the title: **Details** (goal, acceptance criteria,
 * additional context, directory, its persona, and its runs — each with the
 * persona it worked with) and **Thread** (the run thread — comments, including the
 * completion summaries agents post after each run, newest first). Details is
 * the default; the Inbox deep-links to `?tab=thread`. The definition section is
 * `WorkDefDefinition`: a **pending** one can be edited and activated; an active
 * one is locked (revise it with a comment and Run — docs/DESIGN.md "Pending:
 * Write, Review, Activate"). A Scheduled job's cron lives on its Schedule, so it stays
 * editable either way. Its Schedule also has a reversible **pending** flag: the
 * header's Make pending / Activate toggles it (once the definition is active),
 * and while it is set the cron doesn't fire — reactivating resumes at the next
 * occurrence, with no catch-up (docs/DESIGN.md "Pending schedules: reversible,
 * no catch-up"). "Run now" enqueues a fresh WorkItem (not while the definition is
 * pending; a pending Schedule only stops the cron). Comments live on the ref, not on any
 * individual WorkItem (see docs/DESIGN.md "Comments"). Thread attachments are
 * clickable (open the diff/file viewer with line-level review) and the composer
 * has an **Attach** button — uploads go to the ref (`/api/work-defs/:id/
 * attachments`), so they work for Solitary and Scheduled work just like board
 * tasks. The header's run-count badge (`executionCount`, with the last run on
 * hover) is derived by the daemon from the WorkItem table (docs/DESIGN.md
 * "Execution Count: Derived, not Counted"). A WorkDef whose kind the team has
 * switched off answers 403, and the page shows the "turned off" notice
 * (components/FeatureGate). A **mirrored** (External) def — a read-only copy of
 * an external source's item — reuses this page with editing and Delete off,
 * an "Open in <source>" link, and Back to its source's Work tab; its
 * Thread, attachments, and Run work as for any WorkDef (docs/DESIGN.md "Work Sources").
 * Comments its source reported (pulled by sync) carry a badge with the source
 * and channel beside their author (docs/DESIGN.md "A mirrored thread").
 * A **triage-mode** mirror leads with a **Triage** tab (its default; the Inbox
 * links `?tab=triage`): the item read-only beside its latest analysis, each
 * proposal with Accept / Edit / Reject, and earlier rounds
 * (components/triage/MirrorTriagePanel) — and its Run is **Triage now**
 * (docs/DESIGN.md "External sources" — "Triage mode").
 */

import { useState, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { FeatureOffNotice } from "@/components/FeatureGate";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
import { useProposalDecisions } from "@/hooks/useProposalDecisions";
import { MirrorTriagePanel } from "@/components/triage/MirrorTriagePanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { WorkDefDefinition, PendingBadge } from "@/components/WorkDefDefinition";
import { RunHistory } from "@/components/RunHistory";
import { DetailTabBar, useDetailTab } from "@/components/ui/detail-tabs";
import { DetailPageLayout, DetailPageMessage } from "@/components/TabbedPageLayout";
import { FileViewer } from "@/components/viewer/FileViewer";
import { Save, Trash2, Play, Pause, CalendarClock, Zap, Upload, ExternalLink, FolderSync } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { workDefHomePath } from "@/lib/nav-section";
import { runCountLabel } from "@/lib/run-count";
import { commentToneClass } from "@/lib/retry";
import { externalCommentLabel, isTriageMode, mirroredDefHomePath, newestFirst, openInLabel, readOnlyHint, type ExternalCommentInfo, type MirrorInfo } from "@/lib/external-sources";
import { mirrorTriageNowBlocked, type WorkDefTriageView } from "@/lib/triage";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board" | "Triage" | "External";
  parent?: { kind: "story" | "schedule" | "thought" | "external"; id: string; source?: string };
  /** Mirrored (External) defs only: where it comes from (lib/external-sources.ts). */
  mirror?: MirrorInfo;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  /** Solitary/Scheduled: the persona it runs with; a mirror: its source's suggestion. */
  persona?: string;
  directory?: string | null;
  pending?: boolean;
  status?: "active" | "archived";
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  executionCount?: number;
  lastRunAt?: string | null;
}

interface Schedule { id: string; cron: string; lastEnqueuedAt?: string | null; pending?: boolean }

interface Comment {
  from: string;
  body: string;
  at: string;
  attachments?: Array<{ name: string; size: number; type: string }>;
  /** Pulled from the mirror's source by sync (docs/DESIGN.md "A mirrored thread"). */
  external?: ExternalCommentInfo;
}

interface Attachment {
  name: string;
  storedName: string;
  size: number;
  addedAt: number;
}

export function WorkDefDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, refetch, error: loadError } = useApi<{ workDef?: WorkDef; success?: boolean }>(`/api/work-defs/${id}`, [id]);
  const { data: commentsData, refetch: refetchComments } = useApi<{ comments: Comment[] }>(`/api/work-defs/${id}/comments`, [id], { pollInterval: 10_000 });
  const { data: attachData, refetch: refetchAttachments } = useApi<{ attachments: Attachment[] }>(`/api/work-defs/${id}/attachments`, [id]);
  const def = data?.workDef;
  // Cron lives on the parent Schedule, not the WorkDef.
  const scheduleId = def?.parent?.kind === "schedule" ? def.parent.id : undefined;
  const { data: schedData, refetch: refetchSchedule } = useApi<{ schedule?: Schedule }>(scheduleId ? `/api/schedules/${scheduleId}` : "/api/schedules?none", [scheduleId]);

  const [cron, setCron] = useState("");
  const [error, setError] = useState("");
  const [newComment, setNewComment] = useState("");
  // A triage-mode mirror's page leads with (and defaults to) its Triage tab.
  const triageMode = isTriageMode(def?.mirror);
  const [tab, setTab] = useDetailTab(triageMode ? "triage" : "details", triageMode);
  const { data: triageView, refetch: refetchTriage } = useApi<WorkDefTriageView>(
    triageMode ? `/api/work-defs/${encodeURIComponent(id ?? "")}/triage` : null, [id, triageMode], { pollInterval: 15_000 },
  );
  const decisions = useProposalDecisions(
    (proposalId, action) => `/api/work-defs/${encodeURIComponent(id ?? "")}/triage/proposals/${encodeURIComponent(proposalId)}/${action}`,
    () => { refetchTriage(); refetchComments(); },
  );
  const [viewerFile, setViewerFile] = useState<{ storedName: string; displayName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed cron once its parent Schedule loads.
  const [seededCron, setSeededCron] = useState<string | null>(null);
  if (schedData?.schedule && schedData.schedule.id !== seededCron) {
    setSeededCron(schedData.schedule.id);
    setCron(schedData.schedule.cron || "");
  }

  // 403 = its kind (Tasks/Schedules/Stories) is switched off (daemon/features.ts).
  if (!def && loadError === "HTTP 403") return <FeatureOffNotice />;
  if (!def) {
    return (
      <DetailPageMessage>Work not found. <Link to="/work/tasks" className="underline">Back to Tasks</Link></DetailPageMessage>
    );
  }

  // Back fallback / post-delete landing: the list this WorkDef type lives on
  // (the same section the NavBar highlights for it).
  // A mirrored def lives on its external source's tab.
  const mirror = def.mirror;
  const backTo = mirror ? mirroredDefHomePath(mirror) : workDefHomePath(def.type);

  // The cron is the parent Schedule's, not the definition's, so a cron-only PUT
  // is accepted even after activating.
  const saveCron = async () => {
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/work-defs/${def.id}`, { cron: cron.trim() });
    if (res.success) refetch();
    else setError(res.error || "Failed to save schedule");
  };

  // Reversible schedule-level pending (the definition's own pending is one-way, via WorkDefDefinition).
  const schedule = schedData?.schedule;
  const setSchedulePending = async (pending: boolean) => {
    if (!schedule) return;
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/schedules/${encodeURIComponent(schedule.id)}/${pending ? "pending" : "activate"}`, {});
    if (!res.success) setError(res.error || "Failed to update schedule");
    refetchSchedule();
  };

  // On a triage-mode mirror, Run is Triage now (force a triage of the current revision).
  const triageBlocked = triageMode
    ? mirrorTriageNowBlocked(triageView?.latestState ?? null, def.status === "archived" || !!mirror?.vanished)
    : null;
  const run = async () => {
    setError("");
    decisions.setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/work-defs/${def.id}/enqueue`, {});
    if (!res.success) {
      const message = res.error || (triageMode ? "Could not start a triage run" : "Failed to run");
      if (triageMode) decisions.setError(message); else setError(message);
    }
    refetch();
    if (triageMode) refetchTriage();
  };

  const remove = async () => {
    if (!confirm(`Delete "${def.title}"? This can't be undone.`)) return;
    await apiDelete(`/api/work-defs/${def.id}`);
    // replace: the deleted page must not be a Back target.
    navigate(backTo, { replace: true });
  };

  const addComment = async () => {
    const b = newComment.trim();
    if (!b) return;
    await apiPost(`/api/work-defs/${def.id}/comment`, { from: "you", body: b });
    setNewComment("");
    refetchComments();
  };

  const attachments = attachData?.attachments || [];
  const openFileByName = (displayName: string) => {
    const att = attachments.find(a => a.name === displayName);
    if (att) setViewerFile({ storedName: att.storedName, displayName: att.name });
  };
  const handleReviewSubmitted = () => {
    refetchComments();
    refetchAttachments();
  };
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const isBinary = file.type.startsWith("image/") || file.type === "application/octet-stream";
      let content: string;
      let encoding: string | undefined;
      if (isBinary) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        content = btoa(binary);
        encoding = "base64";
      } else {
        content = await file.text();
      }
      await apiPost(`/api/work-defs/${def.id}/attachments`, { name: file.name, content, encoding });
      refetchAttachments();
    } catch {
      // silently fail
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const comments = commentsData?.comments || [];
  // Newest first: the run thread's most recent outcome should be at the top.
  // By each comment's own time, not file order: a comment pulled from the
  // source is appended at sync time but dated when it was written there.
  const threadComments = newestFirst(comments);

  return (
    // Fixed header (DetailPageLayout): its width depends only on whether the
    // page has a Triage tab, never on the active tab, so it doesn't shift. The
    // Triage tab body is two columns (the item beside its analysis), as a
    // note's triage page; Details/Thread stay narrow, left-aligned under it.
    <DetailPageLayout
      headerClassName={triageMode ? "max-w-6xl" : "max-w-3xl"}
      bodyClassName={tab === "triage" ? "max-w-6xl" : "max-w-3xl"}
      tabs={<DetailTabBar tab={tab} onChange={setTab} threadCount={comments.length} triage={triageMode ? { pending: triageView?.pending.length ?? 0 } : undefined} />}
      header={
      <div className="flex items-center gap-3">
        <BackButton fallback={backTo} title="Back" />
        <h1 className="text-2xl font-bold flex-1">{def.title}</h1>
        {(def.pending || schedule?.pending) && <PendingBadge />}
        <Badge variant="outline" className="flex items-center gap-1">
          {def.type === "Scheduled" ? <CalendarClock className="h-3 w-3" /> : mirror ? <FolderSync className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
          {mirror ? mirror.sourceLabel : def.type}
        </Badge>
        {mirror?.url && (
          <Button variant="outline" size="sm" render={<a href={mirror.url} target="_blank" rel="noreferrer" />} title={`${mirror.sourceLabel} ${mirror.externalId}`}>
            <ExternalLink className="h-3.5 w-3.5 mr-1" />{openInLabel(mirror.sourceLabel)}
          </Button>
        )}
        <Badge variant="outline" title={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this yet"}>
          {runCountLabel(def.executionCount)}
        </Badge>
        {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
          <Badge variant="secondary" className="font-mono" title={`${def.tokenUsage.totalInputTokens.toLocaleString()} in / ${def.tokenUsage.totalOutputTokens.toLocaleString()} out tokens across all runs`}>
            ${def.tokenUsage.totalCostUsd.toFixed(3)}
          </Badge>
        )}
        {schedule && !def.pending && (schedule.pending
          ? <Button variant="outline" size="sm" onClick={() => setSchedulePending(false)} title="Resume the schedule at its next cron time (missed runs are not back-filled)"><Play className="h-3.5 w-3.5 mr-1" />Activate</Button>
          : <Button variant="ghost" size="sm" onClick={() => setSchedulePending(true)} title="Stop firing this job until you activate it again"><Pause className="h-3.5 w-3.5 mr-1" />Make pending</Button>)}
        {triageMode
          ? <Button size="sm" onClick={run} disabled={decisions.busy || triageBlocked !== null} title={triageBlocked ?? "Triage the item's current revision now"}><Play className="h-3.5 w-3.5 mr-1" />Triage now</Button>
          : <Button variant="outline" size="sm" onClick={run} disabled={def.pending} title={def.pending ? "Activate it before running it" : "Enqueue a fresh run"}><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>}
      </div>
      }
    >

      {tab === "triage" && triageMode && (triageView
        ? <MirrorTriagePanel item={def} view={triageView} decisions={decisions} blocked={triageBlocked} />
        : <p className="text-sm text-muted-foreground">Loading…</p>)}

      {tab === "details" && (
      <div className="space-y-4">
        {/* A mirrored def is read-only (pull only): no Edit, no Delete — sync archives what vanishes. */}
        <WorkDefDefinition
          def={def}
          onChanged={refetch}
          readOnlyNote={mirror ? readOnlyHint(mirror.sourceLabel) : undefined}
          actions={mirror ? undefined : <Button variant="destructive" onClick={remove}><Trash2 className="h-4 w-4 mr-1" />Delete</Button>}
        />
        {def.type === "Scheduled" && (
          <div>
            <div className="mb-2 pb-1 border-b border-border"><Label>Schedule (cron)</Label></div>
            <div className="flex gap-2 mt-1">
              <Input className="font-mono" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" />
              <Button variant="outline" onClick={saveCron}><Save className="h-4 w-4 mr-1" />Save schedule</Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Five fields: <span className="font-mono">minute hour day-of-month month day-of-week</span> (use <span className="font-mono">*</span> for any). E.g. <span className="font-mono">0 9 * * *</span> = 9:00 every day; <span className="font-mono">*/15 * * * *</span> = every 15 min; <span className="font-mono">0 2 * * 1</span> = 02:00 every Monday.
            </p>
          </div>
        )}

        <RunHistory workDefId={def.id} />

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      )}

      {/* Run thread — completion summaries and human notes, newest first. */}
      {tab === "thread" && (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload className="h-3.5 w-3.5 mr-1" />{uploading ? "Uploading…" : "Attach"}
          </Button>
        </div>
        {threadComments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet. Completion summaries appear here after each run.</p>}
        {threadComments.map((c, i) => (
          <div key={i} className={`rounded-md border p-3 ${commentToneClass(c.body)}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{c.from}</span>
                {c.external && (
                  <Badge variant="outline" className="text-[10px]" title={`From ${mirror?.sourceLabel ?? c.external.source}${c.external.channel ? ` (${c.external.channel})` : ""} — not sent back`}>
                    {externalCommentLabel(c.external, mirror?.sourceLabel)}
                  </Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{new Date(c.at).toLocaleString()}</span>
            </div>
            <MarkdownView content={c.body} />
            {c.attachments && c.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {c.attachments.map(a => (
                  <Badge
                    key={a.name}
                    variant="secondary"
                    className="text-[10px] font-mono cursor-pointer hover:bg-accent"
                    onClick={() => openFileByName(a.name)}
                  >
                    📎 {a.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <Textarea value={newComment} onChange={e => setNewComment(e.target.value)} rows={2} placeholder="Add a note…" className="flex-1 resize-none" />
          <Button className="self-end" onClick={addComment} disabled={!newComment.trim()}>Post</Button>
        </div>
      </div>
      )}

      {/* File Viewer Modal (diff review with line comments) */}
      {viewerFile && (
        <FileViewer
          open={!!viewerFile}
          onClose={() => setViewerFile(null)}
          workDefId={def.id}
          storedName={viewerFile.storedName}
          displayName={viewerFile.displayName}
          onReviewSubmitted={handleReviewSubmitted}
        />
      )}
    </DetailPageLayout>
  );
}

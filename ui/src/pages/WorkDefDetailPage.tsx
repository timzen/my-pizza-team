/**
 * WorkDefDetailPage — View, edit, run, and delete a WorkDef (`/work-defs/:id`).
 *
 * The WorkDef is the home for a Solitary/Scheduled job's rich detail, split
 * into two tabs below the title: **Details** (goal, acceptance criteria,
 * context, directory) and **Thread** (the run thread — comments, including the
 * completion summaries agents post after each run, newest first). Details is
 * the default; the Inbox deep-links to `?tab=thread`. The definition section is
 * `WorkDefDefinition`: a **draft** can be edited and published; a published one
 * is locked (revise it with a comment and Run — docs/DESIGN.md "Drafts: Write,
 * Review, Publish"). A Scheduled job's cron lives on its Schedule, so it stays
 * editable either way. "Run now" enqueues a fresh WorkItem (not for a draft). Comments live on the ref, not on any
 * individual WorkItem (see docs/DESIGN.md "Comments"). Thread attachments are
 * clickable (open the diff/file viewer with line-level review) and the composer
 * has an **Attach** button — uploads go to the ref (`/api/work-defs/:id/
 * attachments`), so they work for Solitary and Scheduled work just like board
 * tasks. The header's run-count badge (`executionCount`, with the last run on
 * hover) is derived by the daemon from the WorkItem table (docs/DESIGN.md
 * "Execution Count: Derived, not Counted"). A WorkDef whose kind the team has
 * switched off answers 403, and the page shows the "turned off" notice
 * (components/FeatureGate).
 */

import { useState, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { FeatureOffNotice } from "@/components/FeatureGate";
import { useApi, apiPut, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { WorkDefDefinition, DraftBadge } from "@/components/WorkDefDefinition";
import { DetailTabBar, useDetailTab } from "@/components/ui/detail-tabs";
import { FileViewer } from "@/components/viewer/FileViewer";
import { Save, Trash2, Play, CalendarClock, Zap, Upload } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { workDefHomePath } from "@/lib/nav-section";
import { runCountLabel } from "@/lib/run-count";
import { commentToneClass } from "@/lib/retry";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board" | "Triage";
  parent?: { kind: "story" | "schedule"; id: string };
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string | null;
  draft?: boolean;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  executionCount?: number;
  lastRunAt?: string | null;
}

interface Schedule { id: string; cron: string; lastEnqueuedAt?: string | null }

interface Comment {
  from: string;
  body: string;
  at: string;
  attachments?: Array<{ name: string; size: number; type: string }>;
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
  const { data: schedData } = useApi<{ schedule?: Schedule }>(scheduleId ? `/api/schedules/${scheduleId}` : "/api/schedules?none", [scheduleId]);

  const [cron, setCron] = useState("");
  const [error, setError] = useState("");
  const [newComment, setNewComment] = useState("");
  const [tab, setTab] = useDetailTab();
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
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Work not found. <Link to="/tasks" className="underline">Back to Tasks</Link></p>
      </div>
    );
  }

  // Back fallback / post-delete landing: the list this WorkDef type lives on
  // (the same section the NavBar highlights for it).
  const backTo = workDefHomePath(def.type);

  // The cron is the parent Schedule's, not the definition's, so a cron-only PUT
  // is accepted even after publishing.
  const saveCron = async () => {
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/work-defs/${def.id}`, { cron: cron.trim() });
    if (res.success) refetch();
    else setError(res.error || "Failed to save schedule");
  };

  const run = async () => {
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/work-defs/${def.id}/enqueue`, {});
    if (!res.success) setError(res.error || "Failed to run");
    refetch();
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
  // Newest first: the run thread's most recent outcome should be at the top
  // (comments are stored oldest-first).
  const threadComments = [...comments].reverse();

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback={backTo} title="Back" />
        <h1 className="text-2xl font-bold flex-1">{def.title}</h1>
        {def.draft && <DraftBadge />}
        <Badge variant="outline" className="flex items-center gap-1">
          {def.type === "Scheduled" ? <CalendarClock className="h-3 w-3" /> : <Zap className="h-3 w-3" />}{def.type}
        </Badge>
        <Badge variant="outline" title={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this yet"}>
          {runCountLabel(def.executionCount)}
        </Badge>
        {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
          <Badge variant="secondary" className="font-mono" title={`${def.tokenUsage.totalInputTokens.toLocaleString()} in / ${def.tokenUsage.totalOutputTokens.toLocaleString()} out tokens across all runs`}>
            ${def.tokenUsage.totalCostUsd.toFixed(3)}
          </Badge>
        )}
        <Button variant="outline" size="sm" onClick={run} disabled={def.draft} title={def.draft ? "Publish the draft before running it" : "Enqueue a fresh run"}><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>
      </div>

      <DetailTabBar tab={tab} onChange={setTab} threadCount={comments.length} />

      {tab === "details" && (
      <div className="space-y-4">
        <WorkDefDefinition
          def={def}
          onChanged={refetch}
          actions={<Button variant="destructive" onClick={remove}><Trash2 className="h-4 w-4 mr-1" />Delete</Button>}
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
              <span className="text-xs font-medium">{c.from}</span>
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
    </div>
  );
}

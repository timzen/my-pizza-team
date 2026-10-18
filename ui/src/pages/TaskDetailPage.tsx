/**
 * TaskDetailPage — Full board-task view (`/task/:storyId/:taskId`).
 *
 * A board task IS a WorkDef (parent = its story), so this page mirrors the
 * WorkDefDetailPage format: two tabs below the title — **Details** (title, goal,
 * acceptance criteria, additional context, directory, context) and **Thread**
 * (the run thread — comments + attachments, newest first). Details is the
 * default; the Inbox deep-links to `?tab=thread`. The board-specific concerns
 * layered on top are the story breadcrumb, the workflow status + move buttons,
 * and delete (which routes through the task endpoint so the story's task list +
 * CONWIP token are cleaned up).
 *
 * The definition is `WorkDefDefinition`: a **pending** task can be edited and
 * activated (it holds its place in the story until then); an active one is
 * locked — rework goes through the Thread and a move back into an agent state
 * (docs/DESIGN.md "Pending: Write, Review, Activate").
 *
 * Comments live on the WorkDef's ref (same comments.jsonl the agents append
 * completion summaries to). Attachments remain clickable — opening the diff/
 * file viewer with line-level review. The header's run-count badge
 * (`executionCount`) counts this task's WorkItems, rework runs included
 * (docs/DESIGN.md "Execution Count: Derived, not Counted").
 */

import { useState, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { WorkDefDefinition, PendingBadge } from "@/components/WorkDefDefinition";
import { runCountLabel } from "@/lib/run-count";
import { DetailTabBar, useDetailTab } from "@/components/ui/detail-tabs";
import { Trash2, Upload } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { FileViewer } from "@/components/viewer/FileViewer";
import { commentToneClass } from "@/lib/retry";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  pending?: boolean;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string | null;
  executionCount?: number;
  lastRunAt?: string | null;
}

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

interface TaskData {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
}

interface StoryView {
  id: string;
  title: string;
  workflow?: string;
  tasks: TaskData[];
}

interface StatusData {
  defaultWorkflow: string;
  workflows: Record<string, { states: string[]; transitions?: Record<string, Record<string, string>> }>;
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
  const { data: attachData, refetch: refetchAttachments } = useApi<{ attachments: Attachment[] }>(
    `/api/work-defs/${encodeURIComponent(taskId || "")}/attachments`
  );

  const def = defData?.workDef;
  const story = storiesData?.stories.find(s => s.id === storyId);
  const task = story?.tasks.find(t => t.id === taskId);
  const comments = commentsData?.comments || [];
  // Newest first: the run thread's most recent outcome should be at the top
  // (comments are stored oldest-first).
  const threadComments = [...comments].reverse();
  const attachments = attachData?.attachments || [];

  const [newComment, setNewComment] = useState("");
  const [viewerFile, setViewerFile] = useState<{ storedName: string; displayName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useDetailTab();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editError, setEditError] = useState("");

  // Resolve workflow states/transitions for this task's story.
  const workflows = statusData?.workflows || {};
  const defaultWorkflow = statusData?.defaultWorkflow || "default";
  const wfName = story?.workflow && workflows[story.workflow] ? story.workflow : defaultWorkflow;
  const states = workflows[wfName]?.states || [];
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
    refetchStories();
  };

  const deleteTask = async () => {
    if (!taskId || !confirm(`Delete task "${taskId}"?`)) return;
    // Delete via the task endpoint: it drops the task from the story's list and
    // frees the CONWIP token (the plain WorkDef delete wouldn't).
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.success) navigate("/board", { replace: true });
    else setEditError(res.error || "Failed to delete");
  };

  const sendComment = async () => {
    if (!newComment.trim() || !taskId) return;
    await apiPost(`/api/work-defs/${encodeURIComponent(taskId)}/comment`, { from: "lead", body: newComment });
    setNewComment("");
    refetchComments();
  };

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
    if (!file || !taskId) return;
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
      await apiPost(`/api/work-defs/${encodeURIComponent(taskId)}/attachments`, { name: file.name, content, encoding });
      refetchAttachments();
    } catch {
      // silently fail
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!def || !task) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Task not found. <Link to="/board" className="underline">Back to board</Link></p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      {/* Top bar: breadcrumb + status + save/delete */}
      <div className="flex items-center gap-3">
        <BackButton fallback="/board" title="Back to board" />
        <h1 className="text-2xl font-bold flex-1">{def.title}</h1>
        {def.pending && <PendingBadge />}
        <Badge variant="outline" title={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this yet"}>
          {runCountLabel(def.executionCount)}
        </Badge>
        <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="font-mono">
          /<Link to={`/story/${storyId}`} className="text-primary hover:underline">{storyId}</Link>/{taskId}
        </Badge>
        {task.assignee && <span className="text-sm text-muted-foreground">Assigned to <strong>{task.assignee}</strong></span>}
      </div>

      <DetailTabBar tab={tab} onChange={setTab} threadCount={comments.length} />

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

        {editError && <p className="text-sm text-destructive">{editError}</p>}
      </div>
      )}

      {/* Run thread — human notes, agent completion summaries, and attachments,
          newest first. */}
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
          <Textarea
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            rows={2}
            placeholder="Add a note… (⌘+Enter to send)"
            className="flex-1 resize-none"
            onKeyDown={e => { if (e.key === "Enter" && e.metaKey) sendComment(); }}
          />
          <Button className="self-end" onClick={sendComment} disabled={!newComment.trim()}>Post</Button>
        </div>
      </div>
      )}

      {/* File Viewer Modal (diff review with line comments) */}
      {viewerFile && taskId && (
        <FileViewer
          open={!!viewerFile}
          onClose={() => setViewerFile(null)}
          workDefId={taskId}
          storedName={viewerFile.storedName}
          displayName={viewerFile.displayName}
          onReviewSubmitted={handleReviewSubmitted}
        />
      )}
    </div>
  );
}

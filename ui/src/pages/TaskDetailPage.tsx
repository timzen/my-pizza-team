/**
 * TaskDetailPage — Full task view with editing, comments, file attachments,
 * and diff review.
 *
 * This page is the home for task *editing* (title, description, status moves,
 * delete). The board only previews tasks read-only; all edits happen here.
 *
 * Features:
 * - Editable task header (title, description) with Save
 * - Status move buttons based on the story's workflow transitions + Delete
 * - Tabs: Comments (chat-style) and Files (attachment list)
 * - Clickable attachments in comments open the file viewer
 * - Interactive diff viewer with line commenting + batched review
 * - Auto-refresh for comments
 */

import { useState, useRef, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, apiPost, apiPut, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownField } from "@/components/ui/markdown-field";
import { TitleField } from "@/components/ui/title-field";
import { MarkdownView } from "@/components/ui/markdown-view";
import { ArrowLeft, Send, MessageSquare, Paperclip, FileText, FileCode, Image, Upload, Trash2, Save } from "lucide-react";
import { FileViewer } from "@/components/viewer/FileViewer";

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
}

interface TaskData {
  id: string;
  seq: number;
  title: string;
  status: string;
  description?: string;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["diff", "patch"].includes(ext)) return <FileCode className="h-4 w-4 text-orange-500" />;
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return <Image className="h-4 w-4 text-purple-500" />;
  if (["md"].includes(ext)) return <FileText className="h-4 w-4 text-blue-500" />;
  return <Paperclip className="h-4 w-4 text-muted-foreground" />;
}

export function TaskDetailPage() {
  const { storyId, taskId } = useParams<{ storyId: string; taskId: string }>();
  const navigate = useNavigate();
  const { data: storiesData, refetch: refetchStories } = useApi<{ stories: StoryView[] }>("/api/stories");
  const { data: statusData } = useApi<StatusData>("/api/status");
  const { data: commentsData, refetch: refetchComments } = useApi<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId || "")}/comments`, [], { pollInterval: 5000 }
  );
  const { data: attachData, refetch: refetchAttachments } = useApi<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId || "")}/attachments`
  );

  const [activeTab, setActiveTab] = useState<"comments" | "files">("comments");
  const [newComment, setNewComment] = useState("");
  const [viewerFile, setViewerFile] = useState<{ storedName: string; displayName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const story = storiesData?.stories.find(s => s.id === storyId);
  const task = story?.tasks.find(t => t.id === taskId);
  const comments = commentsData?.comments || [];
  const attachments = attachData?.attachments || [];

  // --- Task editing (title/description/status/delete) lives on this page ---
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [editError, setEditError] = useState("");

  // Seed the edit fields whenever the task loads/changes.
  useEffect(() => {
    if (task) { setTitle(task.title); setDescription(task.description || ""); setEditError(""); }
  }, [task?.id]);

  // Resolve workflow states/transitions for this task's story.
  const workflows = statusData?.workflows || {};
  const defaultWorkflow = statusData?.defaultWorkflow || "default";
  const wfName = story?.workflow && workflows[story.workflow] ? story.workflow : defaultWorkflow;
  const states = workflows[wfName]?.states || [];
  const transitions = workflows[wfName]?.transitions || {};
  const validTransitions = task ? Object.keys(transitions[task.status] || {}) : [];

  const saveTask = async () => {
    if (!taskId) return;
    setEditError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`, { title, description });
    if (!res.success) { setEditError(res.error || "Failed to save"); return; }
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
    const res = await apiDelete<{ success: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.success) navigate("/board");
    else setEditError(res.error || "Failed to delete");
  };

  const sendComment = async () => {
    if (!newComment.trim() || !taskId) return;
    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/comment`, { from: "lead", body: newComment });
    setNewComment("");
    refetchComments();
  };


  const openFile = (storedName: string, displayName: string) => {
    setViewerFile({ storedName, displayName });
  };

  const deleteFile = async (storedName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!taskId) return;
    await apiDelete(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(storedName)}`);
    refetchAttachments();
  };

  const openFileByName = (displayName: string) => {
    const att = attachments.find(a => a.name === displayName);
    if (att) openFile(att.storedName, att.name);
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
      // Use base64 for binary files (images, etc.), text for everything else
      const isBinary = file.type.startsWith("image/") || file.type === "application/octet-stream";
      let content: string;
      let encoding: string | undefined;

      if (isBinary) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        content = btoa(binary);
        encoding = "base64";
      } else {
        content = await file.text();
      }

      await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
        name: file.name,
        content,
        encoding,
      });
      refetchAttachments();
    } catch {
      // silently fail
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!task) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Task not found. <Link to="/board" className="underline">Back to board</Link></p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-4xl">
      {/* Top bar: back to board + save/delete actions */}
      <div className="flex items-center justify-between">
        <Link to="/board" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to board
        </Link>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={saveTask} title="Save changes">
            <Save className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
            onClick={deleteTask}
            title="Delete task"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Editable task header: title, then path on the left + status on the right */}
      <div className="space-y-2">
        <TitleField label="Title" value={title} onChange={setTitle} required />
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="font-mono">
            /<Link to={`/story/${storyId}`} className="text-primary hover:underline">{storyId}</Link>/{taskId}
          </Badge>
          <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
        </div>
        {task.assignee && <p className="text-sm">Assigned to: <strong>{task.assignee}</strong></p>}
      </div>

      {/* Editable description */}
      <MarkdownField label="Description" value={description} onChange={setDescription} rows={4} />

      {/* Workflow moves (below the description) */}
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

      {/* Tabs */}
      <div className="flex border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "comments" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveTab("comments")}
        >
          <MessageSquare className="h-4 w-4 inline mr-1" />
          Comments ({comments.length})
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "files" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveTab("files")}
        >
          <Paperclip className="h-4 w-4 inline mr-1" />
          Files {attachments.length > 0 && `(${attachments.length})`}
        </button>
      </div>

      {/* Comments Tab */}
      {activeTab === "comments" && (
        <div className="space-y-3">
          <div className="flex justify-end">
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {comments.map((msg, i) => (
              <Card key={i} className={msg.from === "lead" ? "border-l-4 border-l-primary ml-8" : "mr-8"}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium">{msg.from}</span>
                    <span className="text-xs text-muted-foreground">{new Date(msg.at).toLocaleString()}</span>
                  </div>
                  <MarkdownView content={msg.body} />
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 flex gap-2 flex-wrap">
                      {msg.attachments.map((att, j) => (
                        <Badge
                          key={j}
                          variant="outline"
                          className="text-xs cursor-pointer hover:bg-accent"
                          onClick={() => openFileByName(att.name)}
                        >
                          📎 {att.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {comments.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No comments yet.</p>}
          </div>

          {/* Send comment */}
          <div className="flex gap-2">
            <Textarea
              placeholder="Add a comment... (⌘+Enter to send)"
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              rows={2}
              className="flex-1"
              onKeyDown={e => { if (e.key === "Enter" && e.metaKey) sendComment(); }}
            />
            <Button onClick={sendComment} disabled={!newComment.trim()} className="self-end">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Files Tab */}
      {activeTab === "files" && (
        <div className="space-y-3">
          {/* Upload button */}
          <div className="flex justify-end">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Upload className="h-4 w-4 mr-1" />
              {uploading ? "Uploading..." : "Upload File"}
            </Button>
          </div>

          {attachments.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No files attached yet.</p>
          )}
          {attachments.map((att) => (
            <div
              key={att.storedName}
              className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:border-primary transition-colors"
              onClick={() => openFile(att.storedName, att.name)}
            >
              {getFileIcon(att.name)}
              <span className="text-sm font-medium flex-1">{att.name}</span>
              <span className="text-xs text-muted-foreground">{formatSize(att.size)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
                onClick={(e) => deleteFile(att.storedName, e)}
                title="Delete file"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* File Viewer Modal */}
      {viewerFile && taskId && (
        <FileViewer
          open={!!viewerFile}
          onClose={() => setViewerFile(null)}
          taskId={taskId}
          storedName={viewerFile.storedName}
          displayName={viewerFile.displayName}
          onReviewSubmitted={handleReviewSubmitted}
        />
      )}
    </div>
  );
}

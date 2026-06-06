/**
 * TaskDetailPage — Full task view with comments, file attachments, and diff review.
 *
 * Features:
 * - Task header with status and assignment info
 * - Tabs: Comments (chat-style) and Files (attachment list)
 * - Clickable attachments in comments open the file viewer
 * - Interactive diff viewer with line commenting + batched review
 * - Auto-refresh for comments
 */

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Send, MessageSquare, Paperclip, FileText, FileCode, Image } from "lucide-react";
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
  hasComments: boolean;
}

interface StoryView {
  id: string;
  title: string;
  tasks: TaskData[];
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
  const { data: storiesData } = useApi<{ stories: StoryView[] }>("/api/stories");
  const { data: commentsData, refetch: refetchComments } = useApi<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId || "")}/comments`, [], { pollInterval: 5000 }
  );
  const { data: attachData, refetch: refetchAttachments } = useApi<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId || "")}/attachments`
  );

  const [activeTab, setActiveTab] = useState<"comments" | "files">("comments");
  const [newComment, setNewComment] = useState("");
  const [viewerFile, setViewerFile] = useState<{ storedName: string; displayName: string } | null>(null);

  const story = storiesData?.stories.find(s => s.id === storyId);
  const task = story?.tasks.find(t => t.id === taskId);
  const comments = commentsData?.comments || [];
  const attachments = attachData?.attachments || [];

  const sendComment = async () => {
    if (!newComment.trim() || !taskId) return;
    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/comment`, { from: "lead", body: newComment });
    setNewComment("");
    refetchComments();
  };

  const markRead = async () => {
    if (!taskId) return;
    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/mark-read`);
  };

  const openFile = (storedName: string, displayName: string) => {
    setViewerFile({ storedName, displayName });
  };

  const openFileByName = (displayName: string) => {
    const att = attachments.find(a => a.name === displayName);
    if (att) openFile(att.storedName, att.name);
  };

  const handleReviewSubmitted = () => {
    refetchComments();
    refetchAttachments();
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
      <Link to="/board" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to board
      </Link>

      {/* Task header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-xl font-bold">{task.title}</h1>
          <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{taskId} • Story: {storyId}</p>
        {task.assignee && <p className="text-sm mt-1">Assigned to: <strong>{task.assignee}</strong></p>}
      </div>

      {/* Description */}
      {task.description && (
        <Card>
          <CardContent className="p-4">
            <pre className="whitespace-pre-wrap text-sm font-mono">{task.description}</pre>
          </CardContent>
        </Card>
      )}

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
            <Button variant="ghost" size="sm" onClick={markRead}>Mark read</Button>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {comments.map((msg, i) => (
              <Card key={i} className={msg.from === "lead" ? "border-l-4 border-l-primary ml-8" : "mr-8"}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium">{msg.from}</span>
                    <span className="text-xs text-muted-foreground">{new Date(msg.at).toLocaleString()}</span>
                  </div>
                  <div className="text-sm whitespace-pre-wrap">{msg.body}</div>
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
        <div className="space-y-2">
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

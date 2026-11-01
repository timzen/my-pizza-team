/**
 * RunThread — The **Thread** tab of a WorkDef's page: the run thread
 * (comments, newest first, each tinted by `commentToneClass`), its
 * attachments, the **Attach** upload, the comment composer, and the
 * FileViewer (diff/file review with line comments) its attachment badges open.
 *
 * Shared by `pages/TaskDetailPage.tsx` (a board task) and
 * `pages/WorkDefDetailPage.tsx` (Solitary, Scheduled, and mirrored defs).
 * Comments and attachments live on the WorkDef's ref, not on any WorkItem
 * (docs/DESIGN.md "Comments"), so the API is the same for every kind:
 * `GET …/attachments`, `POST …/attachments` (upload, `lib/attachment-upload.ts`)
 * and `POST …/comment` under `/api/work-defs/:id`.
 *
 * The page owns the comment fetch (its tab bar shows the count, and other
 * panels refresh it) and passes the comments in. The component stays mounted
 * on every tab — `visible` only hides the thread — so a half-typed comment
 * survives a trip to Details, and the viewer modal isn't torn down by a tab
 * change. Per-page differences are props: `external` turns on the mirrored
 * thread's rules (sort by each comment's time, source · channel badges —
 * docs/DESIGN.md "A mirrored thread"); the composer's author, ⌘+Enter
 * shortcut and trimming keep each page's existing behavior.
 */

import { useState, useRef } from "react";
import { keyLookup, threadEntryKey } from "@/lib/list-keys";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { FileViewer } from "@/components/viewer/FileViewer";
import { Upload } from "lucide-react";
import { commentToneClass } from "@/lib/retry";
import { attachmentUploadBody } from "@/lib/attachment-upload";
import { externalCommentLabel, newestFirst } from "@/lib/external-sources";
import type { Comment } from "@shared/types";
import type { AttachmentView } from "@shared/protocol";
import { Tooltip } from "@/components/ui/tooltip";

export interface RunThreadProps {
  /** The WorkDef whose ref holds the thread. */
  workDefId: string;
  /** The thread's comments as stored (oldest first); the page fetches them. */
  comments: Comment[];
  /** Refetch the comments (after a post or a submitted review). */
  onCommentsChanged: () => void;
  /** Whether the Thread tab is showing; hidden, only the viewer modal can render. */
  visible: boolean;
  /** Author recorded on a posted comment (`from`). */
  author: string;
  /** Post with ⌘+Enter (and say so in the placeholder). */
  sendOnCmdEnter?: boolean;
  /** Trim the body before posting (it is always required to be non-blank). */
  trimBody?: boolean;
  /**
   * Mirrored-thread rules: order by each comment's own time (a comment pulled
   * from the source is appended at sync time but dated when it was written
   * there) and badge pulled comments with their source. `sourceLabel` is the
   * mirror's source label, when the def is a mirror. Absent = stored order,
   * reversed, and no badges.
   */
  external?: { sourceLabel?: string };
}

/** Render a WorkDef's run thread: Attach, comments newest first, composer, viewer. */
export function RunThread({ workDefId, comments, onCommentsChanged, visible, author, sendOnCmdEnter, trimBody, external }: RunThreadProps) {
  const { data: attachData, refetch: refetchAttachments } = useApi<{ attachments: AttachmentView[] }>(
    `/api/work-defs/${encodeURIComponent(workDefId)}/attachments`, [workDefId],
  );
  const attachments = attachData?.attachments || [];
  const [newComment, setNewComment] = useState("");
  const [viewerFile, setViewerFile] = useState<{ storedName: string; displayName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Newest first: the run thread's most recent outcome should be at the top
  // (comments are stored oldest-first).
  const threadComments = external ? newestFirst(comments) : [...comments].reverse();
  const commentKey = keyLookup(comments, threadEntryKey);

  const sendComment = async () => {
    if (!newComment.trim()) return;
    const body = trimBody ? newComment.trim() : newComment;
    await apiPost(`/api/work-defs/${encodeURIComponent(workDefId)}/comment`, { from: author, body });
    setNewComment("");
    onCommentsChanged();
  };

  const openFileByName = (displayName: string) => {
    const att = attachments.find(a => a.name === displayName);
    if (att) setViewerFile({ storedName: att.storedName, displayName: att.name });
  };

  const handleReviewSubmitted = () => {
    onCommentsChanged();
    refetchAttachments();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await apiPost(`/api/work-defs/${encodeURIComponent(workDefId)}/attachments`, await attachmentUploadBody(file));
      refetchAttachments();
    } catch {
      // silently fail
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      {visible && (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload className="h-3.5 w-3.5 mr-1" />{uploading ? "Uploading…" : "Attach"}
          </Button>
        </div>
        {threadComments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet. Completion summaries appear here after each run.</p>}
        {/* Newest first, so an index key would shift every row when a comment
            lands; key by author + time instead (lib/list-keys.ts). */}
        {threadComments.map((c) => (
          <div key={commentKey(c)} className={`rounded-md border p-3 ${commentToneClass(c.body)}`}>
            <div className="flex items-center justify-between mb-1">
              {external ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-medium">{c.from}</span>
                  {c.external && (
                    <Tooltip content={`From ${external.sourceLabel ?? c.external.source}${c.external.channel ? ` (${c.external.channel})` : ""} — not sent back`} describe={false}>
                      <Badge variant="outline" className="text-[10px]">
                        {externalCommentLabel(c.external, external.sourceLabel)}
                      </Badge>
                    </Tooltip>
                  )}
                </span>
              ) : (
                <span className="text-xs font-medium">{c.from}</span>
              )}
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
            aria-label="Add a note"
            placeholder={sendOnCmdEnter ? "Add a note… (⌘+Enter to send)" : "Add a note…"}
            className="flex-1 resize-none"
            onKeyDown={sendOnCmdEnter ? (e => { if (e.key === "Enter" && e.metaKey) sendComment(); }) : undefined}
          />
          <Button className="self-end" onClick={sendComment} disabled={!newComment.trim()}>Post</Button>
        </div>
      </div>
      )}

      {/* File Viewer Modal (diff review with line comments) */}
      {viewerFile && (
        <FileViewer
          open={!!viewerFile}
          onClose={() => setViewerFile(null)}
          workDefId={workDefId}
          storedName={viewerFile.storedName}
          displayName={viewerFile.displayName}
          onReviewSubmitted={handleReviewSubmitted}
        />
      )}
    </>
  );
}

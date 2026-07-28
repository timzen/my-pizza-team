/**
 * FileViewer — Modal viewer for task attachments.
 *
 * Supports:
 * - .diff/.patch: Interactive DiffViewer with line commenting
 * - .md: Rendered markdown
 * - .json/.xml: Syntax display
 * - Images: Inline display
 * - Other: Download link
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DiffViewer } from "./DiffViewer";

interface FileViewerProps {
  open: boolean;
  onClose: () => void;
  taskId: string;
  storedName: string;
  displayName: string;
  onReviewSubmitted?: () => void;
}

function getFileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name.endsWith(".review.json")) return "review";
  const map: Record<string, string> = {
    diff: "diff", patch: "diff",
    md: "markdown",
    json: "json", xml: "xml",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  };
  return map[ext] || "other";
}

export function FileViewer({ open, onClose, taskId, storedName, displayName, onReviewSubmitted }: FileViewerProps) {
  // The last fetched file, keyed by URL — content/loading are derived from it
  // rather than synced with setState in the effect (only the fetch itself is
  // the external system here).
  const [loaded, setLoaded] = useState<{ url: string; text: string } | null>(null);
  const fileType = getFileType(displayName);
  const fileUrl = `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(storedName)}`;

  useEffect(() => {
    if (!open) return;
    if (fileType === "image") return; // images use <img src>

    let cancelled = false;
    fetch(fileUrl)
      .then(r => r.text())
      .then(text => { if (!cancelled) setLoaded({ url: fileUrl, text }); })
      .catch(() => { if (!cancelled) setLoaded({ url: fileUrl, text: "Failed to load file" }); });
    return () => { cancelled = true; };
  }, [open, fileUrl, fileType]);

  const content = loaded?.url === fileUrl ? loaded.text : null;
  const loading = open && fileType !== "image" && content === null;

  const handleReviewSubmitted = () => {
    onClose();
    onReviewSubmitted?.();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[95vw] max-w-[1200px] h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm font-mono">{displayName}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden min-h-0">
          {loading && <div className="p-8 text-center text-muted-foreground">Loading...</div>}

          {!loading && fileType === "diff" && content && (
            <DiffViewer
              content={content}
              filename={displayName}
              taskId={taskId}
              storedName={storedName}
              onReviewSubmitted={handleReviewSubmitted}
            />
          )}

          {!loading && fileType === "markdown" && content && (
            <div className="p-6 prose prose-sm dark:prose-invert max-w-none overflow-auto h-full">
              <pre className="whitespace-pre-wrap">{content}</pre>
            </div>
          )}

          {!loading && (fileType === "json" || fileType === "review") && content && (
            <pre className="p-4 text-xs font-mono overflow-auto h-full">{content}</pre>
          )}

          {fileType === "image" && (
            <div className="p-6 text-center overflow-auto h-full">
              <img src={fileUrl} alt={displayName} className="max-w-full max-h-[75vh] rounded-lg inline-block" />
            </div>
          )}

          {!loading && fileType === "other" && (
            <div className="p-8 text-center">
              <p className="text-muted-foreground mb-4">Preview not available for this file type.</p>
              <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                Download {displayName}
              </a>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

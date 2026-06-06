/**
 * DiffViewer — Interactive diff viewer with inline line commenting and review submission.
 *
 * Features:
 * - Syntax-highlighted diff rendering (+/-/@@)
 * - Click any line to add a comment
 * - Review panel accumulates comments
 * - Submit Review posts batched comments + .review.json attachment
 */

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface ReviewComment {
  line: number;
  quote: string;
  body: string;
}

interface DiffViewerProps {
  content: string;
  filename: string;
  taskId: string;
  storedName: string;
  onReviewSubmitted?: () => void;
}

export function DiffViewer({ content, filename, taskId, storedName, onReviewSubmitted }: DiffViewerProps) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [activeInput, setActiveInput] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const lines = content.split("\n");

  const addComment = useCallback((lineIdx: number) => {
    if (!inputValue.trim()) return;
    const quote = lines[lineIdx]?.trim().slice(0, 100) || "";
    setComments(prev => [...prev.filter(c => c.line !== lineIdx), { line: lineIdx, quote, body: inputValue.trim() }]);
    setInputValue("");
    setActiveInput(null);
  }, [inputValue, lines]);

  const removeComment = (lineIdx: number) => {
    setComments(prev => prev.filter(c => c.line !== lineIdx));
  };

  const discardAll = () => {
    setComments([]);
    setSummary("");
  };

  const submitReview = async () => {
    if (comments.length === 0) return;
    setSubmitting(true);

    const review = {
      file: storedName,
      comments: comments.map(c => ({ line: c.line + 1, quote: c.quote, body: c.body })),
      summary,
    };

    // Upload review JSON as attachment
    const reviewFileName = `review-${Date.now()}.review.json`;
    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      name: reviewFileName,
      content: JSON.stringify(review, null, 2),
    });

    // Post comment with all review feedback
    let msgBody = `Review of ${filename} (${comments.length} comment${comments.length > 1 ? "s" : ""}):\n\n`;
    for (const c of comments) {
      msgBody += `Line ${c.line + 1}: ${c.body}\n`;
      if (c.quote) msgBody += `  > ${c.quote}\n`;
      msgBody += "\n";
    }
    if (summary) msgBody += `Summary: ${summary}`;

    await apiPost(`/api/tasks/${encodeURIComponent(taskId)}/comment`, {
      from: "lead",
      body: msgBody.trim(),
      attachments: [{ name: reviewFileName, size: JSON.stringify(review).length, type: "review" }],
    });

    setComments([]);
    setSummary("");
    setSubmitting(false);
    onReviewSubmitted?.();
  };

  let lineNum = 0;

  return (
    <div className="flex flex-col h-full">
      {/* Diff content */}
      <div className="flex-1 overflow-auto font-mono text-xs leading-relaxed">
        {lines.map((line, idx) => {
          let cls = "";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400";
          else if (line.startsWith("-") && !line.startsWith("---")) cls = "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400";
          else if (line.startsWith("@@")) cls = "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 italic";

          if (!line.startsWith("@@") && !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("diff ")) lineNum++;

          const hasComment = comments.some(c => c.line === idx);
          const comment = comments.find(c => c.line === idx);

          return (
            <div key={idx}>
              <div
                className={`flex cursor-pointer hover:bg-accent/5 ${cls} ${hasComment ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}
                onClick={() => { setActiveInput(activeInput === idx ? null : idx); setInputValue(""); }}
              >
                <span className="w-10 text-right pr-2 text-muted-foreground select-none shrink-0">
                  {cls.includes("italic") ? "" : lineNum}
                </span>
                <span className="px-3 whitespace-pre flex-1">{line}</span>
              </div>

              {/* Persistent inline comment */}
              {comment && (
                <div className="pl-12 pr-4 py-1 text-xs bg-blue-50/50 dark:bg-blue-950/20 border-l-2 border-blue-400 text-blue-700 dark:text-blue-300">
                  💬 {comment.body}
                </div>
              )}

              {/* Comment input */}
              {activeInput === idx && (
                <div className="pl-12 pr-4 py-2 bg-muted/30 border-b">
                  <Textarea
                    autoFocus
                    placeholder="Add a comment on this line..."
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                    rows={2}
                    className="text-xs mb-2"
                    onKeyDown={e => { if (e.key === "Enter" && e.metaKey) addComment(idx); }}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="default" onClick={() => addComment(idx)} disabled={!inputValue.trim()}>
                      Add Comment
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setActiveInput(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="px-4 py-2 text-xs text-muted-foreground">Click a line to add a review comment</div>
      </div>

      {/* Review panel (shown when comments exist) */}
      {comments.length > 0 && (
        <div className="border-t p-4 space-y-3 max-h-[40vh] overflow-y-auto shrink-0">
          <h3 className="text-sm font-semibold">
            Review ({comments.length} comment{comments.length > 1 ? "s" : ""})
          </h3>
          <div className="space-y-1">
            {comments.map((c, i) => (
              <div key={i} className="text-xs p-2 bg-muted rounded border-l-2 border-primary flex items-start justify-between gap-2">
                <div>
                  <span className="font-semibold text-primary">Line {c.line + 1}:</span> {c.body}
                </div>
                <button onClick={() => removeComment(c.line)} className="text-destructive hover:text-destructive/80 shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <Textarea
            placeholder="Overall summary (optional)..."
            value={summary}
            onChange={e => setSummary(e.target.value)}
            rows={2}
            className="text-sm"
          />
          <div className="flex justify-between">
            <Button variant="outline" size="sm" className="text-destructive border-destructive" onClick={discardAll}>
              Discard All
            </Button>
            <Button size="sm" onClick={submitReview} disabled={submitting}>
              {submitting ? "Submitting..." : "Submit Review"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

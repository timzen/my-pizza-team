/**
 * PairComposer — Message a paired teammate from its watch view.
 *
 * Only rendered while paired (docs/TEAMMATE_CHAT.md §4). Two ways to send,
 * because the teammate may be mid-run and interrupting it is a choice:
 *
 *   Enter          **queue** — lands after the current run (Pi followUp)
 *   ⌘/Ctrl+Enter   **steer** — lands at its next tool step (Pi steer)
 *
 * When it's idle both just start a run. Shift+Enter is a newline. The message
 * shows up in the transcript (tagged `[you]`) once the teammate picks it up,
 * which is the delivery receipt.
 */

import { useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Zap } from "lucide-react";

export function PairComposer({ memberId, running }: { memberId: string; running: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (mode: "queue" | "steer") => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const res = await apiPost<{ success: boolean; error?: string }>(
      `/api/agents/${encodeURIComponent(memberId)}/messages`, { text: body, mode },
    );
    setSending(false);
    if (!res.success) { setError(res.error || "Couldn't send"); return; }
    setError("");
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    send(e.metaKey || e.ctrlKey ? "steer" : "queue");
  };

  return (
    <div className="shrink-0 border-t border-border bg-muted/30 p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={running ? "Message the teammate — Enter queues it after this run, ⌘↵ steers now" : "Message the teammate…"}
          className="min-h-0 flex-1 resize-none font-mono text-[13px]"
          autoFocus
        />
        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={() => send("queue")} disabled={!text.trim() || sending} title={running ? "Queue — lands after the current run (Enter)" : "Send (Enter)"}>
            <Send className="mr-1 h-3.5 w-3.5" />{running ? "Queue" : "Send"}
          </Button>
          {running && (
            <Button size="sm" variant="outline" onClick={() => send("steer")} disabled={!text.trim() || sending} title="Steer — lands at its next tool step (⌘↵)">
              <Zap className="mr-1 h-3.5 w-3.5" />Steer
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

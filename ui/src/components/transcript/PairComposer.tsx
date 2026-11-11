/**
 * PairComposer — Message a paired teammate (or, in the assistant's terminal
 * mode, the leader) from its watch view.
 *
 * Rendered by AgentTerminal: for a teammate only while paired (docs/DESIGN.md
 * "Watching and Pairing with a Teammate"); for the assistant always. Same
 * route either way (`/api/agents/:id/messages`). Two ways to send,
 * because the teammate may be mid-run and interrupting it is a choice:
 *
 *   Enter          **queue** — lands after the current run (Pi followUp)
 *   ⌘/Ctrl+Enter   **steer** — lands at its next tool step (Pi steer)
 *
 * When it's idle both just start a run. Shift+Enter is a newline. The message
 * shows up in the transcript (tagged `[you]`) once the teammate picks it up,
 * which is the delivery receipt.
 *
 * Ctrl+G, the Edit button, or `/editor` + Enter open the big editor
 * (ui/full-editor.tsx); its ⌘↵ queues (the Enter action here).
 *
 * The text is its own state for a teammate. The assistant's terminal passes
 * `draft` instead — the assistant's shared draft (lib/assistant-draft.ts), so
 * what was typed in the docked chat is here at Full page and back again. It
 * mounts with the cursor after any carried-over text. One source per
 * instance: AgentTerminal keys it by agent and source (`pairComposerKey`), so
 * a mounted composer never swaps one for the other or serves another agent.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FullEditorButton, useFullEditor } from "@/components/ui/full-editor";
import { editorCommandSeed } from "@/lib/editorPrefs";
import { composerSource, placeCursorAtEnd, type ComposerDraft } from "@/lib/assistant-draft";
import { Send, Zap } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { FormError } from "@/components/ui/form-error";
import { useAnnounce } from "@/hooks/useAnnounce";

export function PairComposer({ memberId, running, recipient = "the teammate", draft }: {
  memberId: string;
  running: boolean;
  /** Who's on the other end, for the placeholder and editor title. */
  recipient?: string;
  /** Keep the text here instead of in local state (the assistant's shared draft). */
  draft?: ComposerDraft;
}) {
  // Always called (hook order), used only without a `draft`.
  const local = useState("");
  const [text, setText] = composerSource(draft, local);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A carried-over draft continues where it left off.
  useLayoutEffect(() => {
    if (textareaRef.current) placeCursorAtEnd(textareaRef.current);
  }, []);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const announce = useAnnounce();
  // Unique per composer, for the error's aria-describedby.
  const errorId = `pair-composer-${memberId}-error`;

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
    announce(mode === "steer" ? `Sent to ${recipient} — steering now` : running ? `Queued for ${recipient}` : `Sent to ${recipient}`);
  };

  const editor = useFullEditor({
    value: text, onChange: setText, title: `Message ${recipient}`,
    onSubmit: () => send("queue"), submitLabel: running ? "Queue" : "Send",
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (editor.handleKeyDown(e)) return;
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // `/editor` is a UI command, not a message: open the big editor instead.
    const seed = editorCommandSeed(text);
    if (seed !== null) { setText(seed); editor.open(seed); return; }
    send(e.metaKey || e.ctrlKey ? "steer" : "queue");
  };

  return (
    <div className="shrink-0 border-t border-border bg-muted/30 p-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          aria-label={`Message ${recipient}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={running ? `Message ${recipient} — Enter queues it after this run, ⌘↵ steers now` : `Message ${recipient}…`}
          className="min-h-0 flex-1 resize-none font-mono text-[13px]"
        />
        {/* Edit and Send side by side (Steer below while running), so the
            buttons never stack taller than the two-line box. */}
        <div className="grid grid-cols-2 gap-1">
          <FullEditorButton onClick={() => editor.open()} />
          <Tooltip content={running ? "Queue — lands after the current run (Enter)" : "Send (Enter)"}>
            <Button size="sm" onClick={() => send("queue")} disabled={!text.trim() || sending}>
              <Send className="mr-1 h-3.5 w-3.5" />{running ? "Queue" : "Send"}
            </Button>
          </Tooltip>
          {running && (
            <Tooltip content="Steer — lands at its next tool step (⌘↵)">
              <Button size="sm" variant="outline" className="col-span-2" onClick={() => send("steer")} disabled={!text.trim() || sending}>
                <Zap className="mr-1 h-3.5 w-3.5" />Steer
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <FormError id={errorId} className="mt-1 text-xs">{error}</FormError>
      {editor.overlay}
    </div>
  );
}

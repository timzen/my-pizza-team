/**
 * AssistantChat — the conversation itself, without any outer chrome.
 *
 * Presentational on purpose: the live stream is owned by whatever mounts this
 * (the dock), so collapsing the chat can't drop the SSE connection or lose the
 * unread count. This component owns only *composing* state — the draft and the
 * bubble being quoted.
 *
 * Renders as the SideDock's Assistant tab (~300–560px), so it stays vertical
 * and tight: persona chips that scroll, 90%-width bubbles, and the composer
 * pinned to the bottom. It has no toolbar of its own: the dock's tab row shows
 * the leader's presence (a dot on the tab) and the session menu.
 */

import { useEffect, useRef, useState } from "react";
import { apiPost, apiPut, useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "./MessageBubble";
import { ThinkingBubble } from "./ThinkingBubble";
import { Composer } from "./Composer";
import { PersonaChips } from "./PersonaChips";
import type { AssistantStreamState } from "@/hooks/useAssistantStream";
import { PERSONA_TAG, type AssistantMessage, type ContextEntry } from "@/lib/assistant-types";

interface AssistantChatProps {
  /** Live chat state, owned by the dock so it survives collapse. */
  stream: AssistantStreamState;
  /** The session being viewed (null = follow the live one). */
  viewingId: string | null;
  onViewSession: (sessionId: string | null) => void;
}

export function AssistantChat({ stream, viewingId, onViewSession }: AssistantChatProps) {
  const { session, messages, chatAgent, thinking, thoughts, refresh } = stream;

  const { data: personaData, refetch: refetchPersona } = useApi<{ personaId: string | null; entry: ContextEntry | null }>("/api/assistant/persona", [], { pollInterval: 10_000 });
  const { data: contextData } = useApi<{ entries: ContextEntry[] }>("/api/context", [], { pollInterval: 30_000 });

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<AssistantMessage | null>(null);
  const [swapping, setSwapping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The leader answers the chat (there is no separate assistant process), so
  // presence is simply "is a chat agent designated".
  const chatOnline = chatAgent !== null;
  const personas = (contextData?.entries || []).filter((e) => e.tags.includes(PERSONA_TAG));
  const activePersonaId = personaData?.personaId ?? null;
  // Viewing history is read-only: sending would land in the *live* session and
  // silently move you out of the transcript you're reading.
  const isHistory = viewingId !== null;

  // Auto-scroll to the newest message (and when the `…` appears/disappears).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, thinking]);

  const send = async () => {
    const content = draft.trim();
    if (!content || isHistory) return;
    setDraft("");
    const quotedId = replyTo?.id ?? null;
    setReplyTo(null);
    // No optimistic append needed: the SSE `message` frame lands in a few ms.
    await apiPost("/api/assistant/messages", { content, replyTo: quotedId });
  };

  const swapPersona = async (personaId: string | null) => {
    if (swapping || personaId === activePersonaId) return;
    setSwapping(true);
    try {
      // The daemon ends + snapshots the current session and starts a new one.
      await apiPut("/api/assistant/persona", { personaId });
      onViewSession(null);
      await refetchPersona();
      refresh();
    } finally {
      setSwapping(false);
    }
  };

  /** Scroll to a quoted original and flash it, so the quote is a real link. */
  const jumpTo = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary/60", "rounded-2xl");
    setTimeout(() => el.classList.remove("ring-2", "ring-primary/60", "rounded-2xl"), 1200);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Persona picker — hidden while reading history (it would swap the live chat) */}
      {!isHistory && personas.length > 0 && (
        <div className="shrink-0 overflow-x-auto px-3">
          <PersonaChips personas={personas} activePersonaId={activePersonaId} disabled={swapping} onSelect={swapPersona} />
        </div>
      )}

      {/* Reading an earlier session */}
      {isHistory && (
        <div className="mx-3 mt-3 shrink-0 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
          <p className="text-muted-foreground">
            Viewing “{session?.title || viewingId}” — read-only.
            {session && !session.piSessionPath && " The assistant's context for this session is gone."}
          </p>
          <Button variant="ghost" size="sm" className="mt-1 h-6 px-2" onClick={() => onViewSession(null)}>
            Back to live chat
          </Button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages yet. Say hello to your assistant below.
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onReply={setReplyTo} onJumpTo={jumpTo} />
        ))}
        {/* Keep the affordance after the run: the reasoning buffer outlives it,
            and only rendering while `thinking` made the peek a race. */}
        {(thinking || thoughts) && !isHistory && <ThinkingBubble thoughts={thoughts} thinking={thinking} />}
        {!chatOnline && !isHistory && messages.some((m) => m.role === "user" && m.delivery === "queued") && (
          <p className="text-center text-xs text-muted-foreground">
            No leader is running, so your messages are queued. Start one with{" "}
            <code className="rounded bg-muted px-1">pi --ppt-lead</code> in your project and they'll be delivered.
          </p>
        )}
      </div>

      <div className="shrink-0 px-3 pb-3">
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSend={send}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          enabled={!isHistory}
          placeholder={isHistory ? "Viewing history — go back to the live chat to send" : "Message the assistant…"}
        />
      </div>
    </div>
  );
}

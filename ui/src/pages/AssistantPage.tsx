/**
 * AssistantPage — the live chat with the team assistant.
 *
 * Chat v2 (docs/ASSISTANT_CHAT_V2.md): the daemon chat mirrors the assistant's Pi
 * session, so this page is a chat client, not a form.
 *
 * - Send whenever you like — the composer never locks and mid-run messages are
 *   steered into the agent's current run.
 * - Bubbles, receipts (queued → delivered → read), thoughts, and session changes
 *   arrive over SSE (`useAssistantStream`), not polling.
 * - Anything typed in the assistant's tmux pane shows up here too, marked with a
 *   terminal glyph — it is one conversation on two surfaces.
 * - Hover a bubble to reply (quote), expand it full screen, or copy it.
 * - Personas and session history live in the header; nothing is ever deleted.
 */

import { useEffect, useRef, useState } from "react";
import { useApi, apiPost, apiPut } from "@/hooks/useApi";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "@/components/assistant/MessageBubble";
import { ThinkingBubble } from "@/components/assistant/ThinkingBubble";
import { Composer } from "@/components/assistant/Composer";
import { PersonaChips } from "@/components/assistant/PersonaChips";
import { SessionMenu } from "@/components/assistant/SessionMenu";
import { UserPlus } from "lucide-react";
import { PERSONA_TAG, type AssistantMessage, type ContextEntry } from "@/lib/assistant-types";

export function AssistantPage() {
  // null = follow the active session; an id = read an earlier one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const { session, messages, thinking, thoughts, connected, refresh } = useAssistantStream(viewingId ?? undefined);

  const { data: agentsData } = useApi<{ agents: Array<{ id: string; name: string; status: string; hostId?: string }> }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: personaData, refetch: refetchPersona } = useApi<{ personaId: string | null; entry: ContextEntry | null }>("/api/assistant/persona", [], { pollInterval: 10_000 });
  const { data: contextData } = useApi<{ entries: ContextEntry[] }>("/api/context", [], { pollInterval: 30_000 });

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<AssistantMessage | null>(null);
  const [swapping, setSwapping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agents = agentsData?.agents || [];
  const assistantOnline = agents.some((a) => a.name.includes("assistant") && a.status !== "offline");
  const personas = (contextData?.entries || []).filter((e) => e.tags.includes(PERSONA_TAG));
  const activePersonaId = personaData?.personaId ?? null;
  // Viewing history is read-only: sending would land in the active session and
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
    // Optimism isn't needed: the SSE `message` frame lands in a few ms.
    await apiPost("/api/assistant/messages", { content, replyTo: quotedId });
  };

  const swapPersona = async (personaId: string | null) => {
    if (swapping || personaId === activePersonaId) return;
    setSwapping(true);
    try {
      // The daemon ends + snapshots the current session and starts a new one.
      await apiPut("/api/assistant/persona", { personaId });
      setViewingId(null);
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
    <div className="flex flex-col h-full min-h-0 w-full max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-2xl font-bold">Assistant</h1>
          <span
            className={`h-2 w-2 rounded-full ${assistantOnline ? "bg-green-500" : "bg-muted-foreground/40"}`}
            title={assistantOnline ? "Assistant online" : "Assistant offline"}
          />
          {activePersonaId && (
            <span className="truncate text-xs text-muted-foreground">· {personaData?.entry?.title ?? activePersonaId}</span>
          )}
          {!connected && <span className="text-xs text-muted-foreground">· reconnecting…</span>}
        </div>
        <div className="flex items-center gap-2">
          <SessionMenu viewingId={viewingId} onView={setViewingId} onChanged={refresh} />
          <SpawnAssistantButton disabled={assistantOnline} />
        </div>
      </div>

      {/* Persona picker */}
      {!isHistory && (
        <PersonaChips personas={personas} activePersonaId={activePersonaId} disabled={swapping} onSelect={swapPersona} />
      )}

      {/* Reading an earlier session */}
      {isHistory && (
        <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <span className="truncate text-muted-foreground">
            Viewing “{session?.title || viewingId}” — read-only.
            {session && !session.piSessionPath && " The assistant's context for this session is no longer available."}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setViewingId(null)}>Back to live chat</Button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">
            No messages yet. Say hello to your assistant below.
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onReply={setReplyTo} onJumpTo={jumpTo} />
        ))}
        {thinking && !isHistory && <ThinkingBubble thoughts={thoughts} />}
        {!assistantOnline && !isHistory && messages.some((m) => m.role === "user" && m.delivery === "queued") && (
          <p className="text-center text-xs text-muted-foreground">
            Assistant is offline — your messages are queued and will be delivered when it comes back.
          </p>
        )}
      </div>

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={send}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        enabled={!isHistory}
        placeholder={isHistory
          ? "Viewing history — go back to the live chat to send a message"
          : "Message the assistant…  (Enter to send, Shift+Enter for newline)"}
      />
    </div>
  );
}

/** Button to spawn an assistant agent. Disabled if one is already running. */
function SpawnAssistantButton({ disabled }: { disabled: boolean }) {
  const [spawning, setSpawning] = useState(false);

  const handleSpawn = async () => {
    setSpawning(true);
    try {
      const agentsRes = await fetch("/api/agents").then((r) => r.json());
      const hosts = new Set<string>();
      for (const a of agentsRes.agents || []) {
        if (a.hostId && a.status !== "offline") hosts.add(a.hostId);
      }
      const hostId = [...hosts][0];
      if (!hostId) { setSpawning(false); return; }
      await apiPost(`/api/hosts/${encodeURIComponent(hostId)}/leader/directives`, { action: "spawn", params: { reason: "assistant" } });
    } finally {
      setSpawning(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleSpawn}
      disabled={disabled || spawning}
      title={disabled ? "Assistant already running" : "Spawn an assistant agent"}
    >
      <UserPlus className="h-4 w-4 mr-1" />
      {disabled ? "Running" : "Spawn"}
    </Button>
  );
}

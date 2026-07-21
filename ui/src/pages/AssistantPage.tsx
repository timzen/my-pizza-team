/**
 * AssistantPage — Chat window with the team assistant.
 *
 * Renders the conversation as message bubbles (you on the right, the assistant
 * on the left, iMessage-style). Sending a message appends it to the chat; the
 * assistant answers in a response "turn" that can stream several bubbles. While
 * a turn is processing (`activeTurn`), a typing indicator shows and the composer
 * is locked. Your messages show read receipts (✓ sent, ✓✓ read once a turn picks
 * them up). Polls /api/assistant/messages for updates.
 */

import { useState, useRef, useEffect } from "react";
import { useApi, apiPost, apiPut, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Send, SquarePen, UserPlus, Check, CheckCheck, Eraser } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "sent" | "read" | "done" | "failed";
  turnId: string | null;
  createdAt: string;
}

interface ActiveTurn {
  id: string;
  status: "processing";
}

interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
}

/** The tag that marks a context entry as a selectable assistant persona. */
const PERSONA_TAG = "persona";

export function AssistantPage() {
  const { data, refetch } = useApi<{ messages: Message[]; activeTurn: ActiveTurn | null }>("/api/assistant/messages", [], { pollInterval: 2000 });
  const { data: agentsData } = useApi<{ agents: Array<{ id: string; name: string; status: string; capabilities?: Record<string, string | null> }> }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: personaData, refetch: refetchPersona } = useApi<{ personaId: string | null; entry: ContextEntry | null }>("/api/assistant/persona", [], { pollInterval: 10_000 });
  const { data: contextData } = useApi<{ entries: ContextEntry[] }>("/api/context", [], { pollInterval: 30_000 });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Throttle typing pings so we don't POST on every keystroke; the daemon only
  // needs a recent-enough "still typing" signal for the pre-claim debounce.
  const lastTypingPing = useRef(0);

  const messages = data?.messages || [];
  const activeTurn = data?.activeTurn || null;
  // A turn is being worked: show a typing indicator and lock the composer so we
  // never have to enqueue/order mid-turn messages (see ARCHITECTURE.md).
  const turnActive = !!activeTurn;
  const agents = agentsData?.agents || [];
  const onlineAssistant = agents.find(a => a.name.includes("assistant") && a.status !== "offline");
  const assistantOnline = !!onlineAssistant;
  // Persona chips are only meaningful when the assistant advertises the
  // `persona` capability (i.e. a build that knows how to load one).
  const personaCapable = !!onlineAssistant?.capabilities && PERSONA_TAG in onlineAssistant.capabilities;
  const personas = (contextData?.entries || []).filter(e => e.tags.includes(PERSONA_TAG));
  const activePersonaId = personaData?.personaId ?? null;

  const swapPersona = async (personaId: string | null) => {
    if (swapping || personaId === activePersonaId) return;
    setSwapping(true);
    try {
      await apiPut("/api/assistant/persona", { personaId });
      await Promise.all([refetchPersona(), refetch()]);
    } finally {
      setSwapping(false);
    }
  };

  // Auto-scroll to the newest message (and when a turn starts/stops typing).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, turnActive]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending || turnActive) return;
    setSending(true);
    setDraft("");
    try {
      await apiPost("/api/assistant/messages", { content });
      await refetch();
    } finally {
      setSending(false);
    }
  };

  const clearConversation = async () => {
    if (!confirm("Start a new chat? This clears the conversation and resets the assistant's context.")) return;
    await apiDelete("/api/assistant/messages");
    refetch();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!turnActive) send();
    }
  };

  // Tell the daemon the user is actively composing so it holds off claiming a
  // turn until they go quiet (pre-claim debounce). Throttled to ~1.5s.
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const now = Date.now();
    if (now - lastTypingPing.current > 1500) {
      lastTypingPing.current = now;
      apiPost("/api/assistant/typing", {}).catch(() => {});
    }
  };

  // Keystroke pings alone go silent when the user pauses with half-written text
  // in the box (thinking, re-reading, about to backspace) — and a >debounce
  // pause would let the assistant claim the turn out from under them. So while
  // there's an unsent draft (and no active turn), heartbeat every 2s: an unsent
  // draft means "I'm not done yet."
  useEffect(() => {
    if (turnActive || !draft.trim()) return;
    const ping = () => {
      lastTypingPing.current = Date.now();
      apiPost("/api/assistant/typing", {}).catch(() => {});
    };
    const id = setInterval(ping, 2000);
    return () => clearInterval(id);
  }, [draft, turnActive]);

  return (
    <div className="container mx-auto flex flex-col h-[calc(100vh-4rem)] max-w-3xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Assistant</h1>
          <span className={`h-2 w-2 rounded-full ${assistantOnline ? "bg-green-500" : "bg-muted-foreground/40"}`} title={assistantOnline ? "Assistant online" : "Assistant offline"} />
          {personaCapable && activePersonaId && (
            <span className="text-xs text-muted-foreground">· {personaData?.entry?.title ?? activePersonaId}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearConversation} title="New chat (clears + resets context)">
              <SquarePen className="h-4 w-4 mr-1" />New chat
            </Button>
          )}
          <SpawnAssistantButton disabled={assistantOnline} />
        </div>
      </div>

      {/* Persona chips — only when the assistant can load a persona */}
      {personaCapable && personas.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-3">
          <span className="text-xs text-muted-foreground mr-1">Persona:</span>
          <Button variant={activePersonaId === null ? "default" : "outline"} size="sm" disabled={swapping} onClick={() => swapPersona(null)}>
            Default
          </Button>
          {personas.map(p => (
            <Button
              key={p.id}
              variant={activePersonaId === p.id ? "default" : "outline"}
              size="sm"
              disabled={swapping}
              title={p.description || p.title}
              onClick={() => swapPersona(p.id)}
            >
              {p.title}
            </Button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">
            No messages yet. Say hello to your assistant below.
          </p>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {/* Typing indicator while the assistant works the current turn. */}
        {turnActive && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm">
              <TypingIndicator />
            </div>
          </div>
        )}
        {!assistantOnline && messages.some(m => m.role === "user" && m.status === "sent") && (
          <p className="text-center text-xs text-muted-foreground">
            Assistant is offline — spawn one to get a reply.
          </p>
        )}
      </div>

      {/* Composer — locked while a turn is being answered */}
      <div className="flex gap-2 pt-3 border-t border-border">
        <Textarea
          placeholder={turnActive ? "Assistant is replying…" : "Message the assistant…  (Enter to send, Shift+Enter for newline)"}
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={turnActive}
          className="flex-1 resize-none"
        />
        <div className="flex flex-col gap-2 self-end">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDraft("")}
            disabled={!draft || turnActive}
            title="Clear textbox"
          >
            <Eraser className="h-4 w-4" />
          </Button>
          <Button onClick={send} size="icon" disabled={!draft.trim() || sending || turnActive} title="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A single chat bubble — right-aligned for the user, left-aligned for the assistant. */
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const failed = !isUser && message.status === "failed";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={[
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : failed
              ? "bg-destructive/10 text-destructive rounded-bl-sm"
              : "bg-muted text-foreground rounded-bl-sm",
        ].join(" ")}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        ) : failed ? (
          <span className="whitespace-pre-wrap break-words">{message.content || "The assistant hit an error."}</span>
        ) : (
          <MarkdownView content={message.content} />
        )}
      </div>
      {/* Read receipt on the user's own messages: ✓ delivered, ✓✓ read (picked up by a turn). */}
      {isUser && (
        <span className="mt-0.5 mr-1 text-muted-foreground" title={message.status === "read" ? "Read" : "Sent"}>
          {message.status === "read"
            ? <CheckCheck className="h-3 w-3" />
            : <Check className="h-3 w-3" />}
        </span>
      )}
    </div>
  );
}

/** Animated three-dot "typing" indicator for a pending assistant turn. */
function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

/** Button to spawn an assistant agent. Disabled if one is already running. */
function SpawnAssistantButton({ disabled }: { disabled: boolean }) {
  const [spawning, setSpawning] = useState(false);

  const handleSpawn = async () => {
    setSpawning(true);
    try {
      const agentsRes = await fetch("/api/agents").then(r => r.json());
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

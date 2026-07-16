/**
 * AssistantPage — Chat window with the team assistant.
 *
 * Renders the conversation as message bubbles (you on the right, the assistant
 * on the left, iMessage-style). Sending a message creates a pending assistant
 * turn that the assistant agent answers; pending/processing turns show a typing
 * indicator. Polls /api/assistant/messages for updates.
 */

import { useState, useRef, useEffect } from "react";
import { useApi, apiPost, apiPut, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Send, SquarePen, UserPlus } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "processing" | "done" | "failed";
  createdAt: string;
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
  const { data, refetch } = useApi<{ messages: Message[] }>("/api/assistant/messages", [], { pollInterval: 2000 });
  const { data: agentsData } = useApi<{ agents: Array<{ id: string; name: string; status: string; capabilities?: Record<string, string | null> }> }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: personaData, refetch: refetchPersona } = useApi<{ personaId: string | null; entry: ContextEntry | null }>("/api/assistant/persona", [], { pollInterval: 10_000 });
  const { data: contextData } = useApi<{ entries: ContextEntry[] }>("/api/context", [], { pollInterval: 30_000 });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = data?.messages || [];
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

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.status]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
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
      send();
    }
  };

  return (
    <div className="container mx-auto flex flex-col h-[calc(100vh-4rem)] max-w-3xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Assistant</h1>
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
        {!assistantOnline && messages.some(m => m.role === "assistant" && (m.status === "pending" || m.status === "processing")) && (
          <p className="text-center text-xs text-muted-foreground">
            Assistant is offline — spawn one to get a reply.
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="flex gap-2 pt-3 border-t border-border">
        <Textarea
          placeholder="Message the assistant…  (Enter to send, Shift+Enter for newline)"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="flex-1 resize-none"
        />
        <Button onClick={send} disabled={!draft.trim() || sending} className="self-end">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/** A single chat bubble — right-aligned for the user, left-aligned for the assistant. */
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const pending = !isUser && (message.status === "pending" || message.status === "processing");
  const failed = !isUser && message.status === "failed";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
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
        {pending ? (
          <TypingIndicator />
        ) : isUser ? (
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        ) : failed ? (
          <span className="whitespace-pre-wrap break-words">{message.content || "The assistant hit an error."}</span>
        ) : (
          <MarkdownView content={message.content} />
        )}
      </div>
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

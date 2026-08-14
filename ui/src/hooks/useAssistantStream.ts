/**
 * useAssistantStream — Live state for the assistant chat.
 *
 * The chat is pushed, not polled: a single SSE connection to
 * `/api/assistant/stream` delivers new bubbles, delivery receipts, reasoning
 * chunks (the payload behind the `…`), and session changes. Polling at 2s made
 * the typing indicator and the thought peek useless (see
 * docs/ASSISTANT_CHAT_V2.md §4.5).
 *
 * A slow reconciliation fetch of `/api/assistant/messages` runs alongside it, so
 * a dropped frame or a reconnect can never leave the transcript wrong.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantMessage, AssistantSession, AssistantStreamEvent } from "@/lib/assistant-types";

/** How often to reconcile the transcript against the server (safety net only). */
const RECONCILE_MS = 15_000;
/** Cap on locally-held reasoning chunks — the server caps its own buffer too. */
const MAX_THOUGHT_CHUNKS = 400;

export interface AssistantStreamState {
  session: AssistantSession | null;
  messages: AssistantMessage[];
  /** The agent that answers (the designated leader), or null if none is online. */
  chatAgent: { id: string; name: string } | null;
  /** True while the agent is mid-run (drives the `…` bubble). */
  thinking: boolean;
  /** Live reasoning text for the "peek behind the …" panel. */
  thoughts: string;
  /** False while the SSE connection is down (daemon restart, etc.). */
  connected: boolean;
  /** Force a transcript refresh (e.g. after switching sessions). */
  refresh: () => void;
}

/**
 * Subscribe to the chat. `sessionId` pins an earlier session (read-only history);
 * omit it to follow the active session.
 */
export function useAssistantStream(sessionId?: string): AssistantStreamState {
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [chatAgent, setChatAgent] = useState<{ id: string; name: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [thoughtChunks, setThoughtChunks] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Read the pinned session inside SSE handlers without making them a dependency
  // of the subscription effect (a re-subscribe per keystroke would be wasteful).
  const pinnedRef = useRef<string | undefined>(sessionId);
  useEffect(() => { pinnedRef.current = sessionId; }, [sessionId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // ─── Transcript fetch (initial + reconcile) ──────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const url = sessionId
        ? `/api/assistant/messages?sessionId=${encodeURIComponent(sessionId)}`
        : "/api/assistant/messages";
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json() as {
          session: AssistantSession | null;
          messages: AssistantMessage[];
          thinking: boolean;
          chatAgent: { id: string; name: string } | null;
        };
        if (cancelled) return;
        setSession(data.session);
        setMessages(data.messages || []);
        setThinking(!!data.thinking);
        setChatAgent(data.chatAgent ?? null);
      } catch {
        // Leave the last known transcript in place; the stream or the next
        // reconcile will catch us up.
      }
    };
    load();
    const timer = setInterval(load, RECONCILE_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, nonce]);

  // ─── SSE ─────────────────────────────────────────────────────────
  useEffect(() => {
    const source = new EventSource("/api/assistant/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (frame) => {
      let event: AssistantStreamEvent;
      try { event = JSON.parse(frame.data) as AssistantStreamEvent; } catch { return; }

      switch (event.type) {
        case "hello":
          setConnected(true);
          setThinking(event.thinking);
          break;

        case "message":
          // While viewing history, ignore live appends to the active session.
          if (pinnedRef.current && event.message.sessionId !== pinnedRef.current) return;
          setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
          break;

        case "message-deleted":
          setMessages((prev) => prev.filter((m) => m.id !== event.id));
          break;

        case "delivery":
          setMessages((prev) => prev.map((m) => (m.id === event.id ? { ...m, delivery: event.delivery } : m)));
          break;

        case "thinking":
          setThinking(event.active);
          // A run starting clears the previous run's reasoning; chunks that
          // arrive while active accumulate.
          if (event.chunk) {
            setThoughtChunks((prev) => [...prev, event.chunk!].slice(-MAX_THOUGHT_CHUNKS));
          } else if (event.active) {
            setThoughtChunks([]);
          }
          break;

        case "session":
          // Following the active session? Adopt it (a new chat / resume switched
          // us) and reload the transcript for the new session.
          if (!pinnedRef.current) {
            setSession((prev) => {
              if (prev && prev.id !== event.session.id) refresh();
              return event.session;
            });
          }
          break;
      }
    };

    return () => source.close();
  }, [refresh]);

  return { session, messages, chatAgent, thinking, thoughts: thoughtChunks.join(""), connected, refresh };
}

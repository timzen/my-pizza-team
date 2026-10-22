// Session transcript wiring: ONE code path for every agent's live watch view
//
// The web UI's terminal view of a Pi session — a teammate's page (/teammates/:id)
// and, in `assistant.chatMode: "terminal"`, the assistant dock — is fed by a
// TranscriptMirror (runtime/transcript.ts). This module is the only place its Pi
// events are wired, and the only place a web-composer message is handed to Pi, so
// the teammate and the leader cannot drift apart: same entry kinds, same clipping,
// same watch semantics, same origin/delivery tags (my-pizza-team docs/DESIGN.md
// "Watching and Pairing with a Teammate" and "Assistant Chat Model").
//
// It lives outside runtime/ because it is Pi-specific (it registers pi.on
// handlers); runtime/ stays harness-agnostic. Type-only imports, so the tests can
// load it under Node's type stripping and drive it with a fake `pi`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TranscriptMirror } from "./runtime/transcript.js";

/** How a web-composer message lands on a run in flight: after it (Pi followUp), or at the next tool step. */
export type WebSendMode = "queue" | "steer";

/**
 * Wire `transcript` to this Pi session's events and start it (it then polls the
 * daemon's watch bit and mirrors only while watched). Stopped on session_shutdown.
 * Called from both the teammate setup (index.ts) and the leader setup
 * (leader.ts). Its own pi.on registrations, separate from the work loop's and
 * the chat mirror's, so those concerns never share a handler.
 */
export function attachTranscriptMirror(pi: ExtensionAPI, transcript: TranscriptMirror): TranscriptMirror {
  pi.on("input", async (event) => { transcript.onInput(event.text, event.source, event.streamingBehavior); });
  pi.on("agent_start", async () => { transcript.onAgentStart(); });
  pi.on("agent_end", async () => { transcript.onAgentEnd(); });
  pi.on("message_start", async (event) => { transcript.onMessageStart(event.message as any); });
  pi.on("message_update", async (event) => { transcript.onMessageUpdate(event.message as any); });
  pi.on("message_end", async (event) => { transcript.onMessageEnd(event.message as any); });
  pi.on("tool_execution_start", async (event) => { transcript.onToolStart(event.toolCallId, event.toolName, event.args); });
  pi.on("tool_execution_end", async (event) => {
    transcript.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
  });
  pi.on("session_shutdown", async () => { transcript.stop(); });
  transcript.start().catch(() => {});
  return transcript;
}

/**
 * Hand a message from the web UI to Pi: tagged `web` in the transcript (Pi reports
 * it as source "extension", like the work prompt — see expectWebInput), and, when
 * a run is in flight, delivered as `steer` or `followUp` per `mode`. When idle it
 * just starts a run. The teammate's pairing channel and the leader's assistant
 * inbox both deliver through here.
 */
export function deliverWebMessage(
  pi: ExtensionAPI,
  transcript: TranscriptMirror,
  text: string,
  mode: WebSendMode,
  agentRunning: boolean,
): void {
  transcript.expectWebInput(text);
  pi.sendUserMessage(text, agentRunning ? { deliverAs: mode === "steer" ? "steer" : "followUp" } : undefined);
}

/**
 * daemon/store/assistant-snapshots.ts — Markdown snapshots of assistant chats.
 *
 * A chat session is never destroyed: when it ends (new chat, persona swap,
 * resume of another session, daemon shutdown) its transcript is written to
 * `<teamDir>/assistant/sessions/<id>.md` as frontmatter + readable markdown.
 * That file is the durable, human-readable record — SQLite stays the runtime
 * engine, exactly as it is for stories (see DESIGN.md).
 *
 * Snapshots are also refreshed opportunistically while a session is active so a
 * crash can't lose the transcript. Reasoning ("thoughts") is deliberately NOT
 * included — it is ephemeral peek-only state (see docs/ASSISTANT_CHAT_V2.md §3.4).
 *
 * Pure IO over a team directory — no database, no shared state.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR } from "../../shared/types.ts";

/** The session fields a snapshot needs. Mirrors the stored session row. */
export interface SnapshotSession {
  id: string;
  personaId: string | null;
  personaTitle: string | null;
  title: string;
  piSessionPath: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** The message fields a snapshot needs. */
export interface SnapshotMessage {
  role: "user" | "assistant" | "system";
  content: string;
  origin: string;
  createdAt: string;
}

/** `<teamDir>/assistant/sessions/` — created on demand. */
export function sessionsDir(teamDir: string): string {
  return path.join(teamDir, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR);
}

/** Absolute path of a session's snapshot file (whether or not it exists yet). */
export function snapshotPath(teamDir: string, sessionId: string): string {
  return path.join(sessionsDir(teamDir), `${sessionId}.md`);
}

/** Read a snapshot back, or null when it was never written. */
export function readSnapshot(teamDir: string, sessionId: string): string | null {
  const file = snapshotPath(teamDir, sessionId);
  if (!existsSync(file)) return null;
  try {
    return Deno.readTextFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) a session's snapshot. Returns the file path.
 *
 * The body is optimized for reading, not round-tripping: each message is a bold
 * speaker line with a local time, then the content verbatim (markdown intact).
 */
export function writeSnapshot(
  teamDir: string,
  session: SnapshotSession,
  messages: SnapshotMessage[],
): string {
  const dir = sessionsDir(teamDir);
  Deno.mkdirSync(dir, { recursive: true });
  const file = snapshotPath(teamDir, session.id);
  Deno.writeTextFileSync(file, renderSnapshot(session, messages));
  return file;
}

/** Serialize a session + transcript to the snapshot markdown format. */
export function renderSnapshot(session: SnapshotSession, messages: SnapshotMessage[]): string {
  const fm: string[] = ["---"];
  fm.push(`id: ${quote(session.id)}`);
  fm.push(`persona: ${session.personaId ? quote(session.personaId) : "default"}`);
  if (session.personaTitle) fm.push(`personaTitle: ${quote(session.personaTitle)}`);
  if (session.piSessionPath) fm.push(`piSession: ${quote(session.piSessionPath)}`);
  fm.push(`startedAt: ${quote(session.startedAt)}`);
  if (session.endedAt) fm.push(`endedAt: ${quote(session.endedAt)}`);
  fm.push(`messages: ${messages.length}`);
  fm.push("---");

  const speaker = session.personaTitle || "Assistant";
  const body: string[] = ["", `# Chat — ${session.title || "(untitled)"}`, ""];
  for (const m of messages) {
    if (m.role === "system") {
      // Session markers read as italic asides rather than dialogue.
      body.push(`_${m.content.trim()}_`, "");
      continue;
    }
    const who = m.role === "user" ? (m.origin === "tui" ? "You (terminal)" : "You") : speaker;
    body.push(`**${who}** · ${clockTime(m.createdAt)}`, "", m.content.trim(), "");
  }

  return `${fm.join("\n")}\n${body.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** `HH:MM` for a snapshot speaker line; falls back to the raw value if unparsable. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Quote a frontmatter scalar when it could otherwise break parsing. */
function quote(value: string): string {
  return /[:#[\]"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

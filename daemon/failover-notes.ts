/**
 * daemon/failover-notes.ts — What a team-wide model failover tells the people
 * watching (docs/DESIGN.md "Model Failover", "What you see"): the episode's
 * **Inbox note**, and the thread comments on the work it touched.
 *
 * daemon/failover.ts emits a `FailoverEvent` for each trip, escalation,
 * exhaustion and end (one per event, never one per agent); the Store hands
 * each to `FailoverNotes.record`, which keeps **one note per episode** — the
 * episode being named by when it first tripped — and adds a line to it for
 * each event. A new line marks the note unread again, so it shows in the Inbox
 * and counts toward its badge (`/api/status` `unreadInboxCount`).
 *
 * The notes live in the `settings` table (`failover.notes`, JSON, newest
 * first, the latest `MAX_NOTES` kept): like the failover state they are
 * daemon-local, not team history, and an old episode is of no use.
 *
 * `failoverComment` is the thread side: the one-line comment for a retry that
 * moved to the substitute, and for the probe that ended a failover.
 */

import type { FailoverEvent } from "./failover.ts";
import type { FailoverNoteView } from "../shared/protocol.ts";

/** The `settings` key the notes are persisted under. */
export const FAILOVER_NOTES_KEY = "failover.notes";

/** How many episodes' notes are kept. */
const MAX_NOTES = 20;

/** "1 throttle failure", "2 5xx failures". */
function failuresText(n: number, kind: string): string {
  return `${n} ${kind} failure${n === 1 ? "" : "s"}`;
}

/** The line an episode event adds to its note, or null for one that adds none (`retried`). */
export function failoverNoteLine(event: FailoverEvent): string | null {
  switch (event.type) {
    case "tripped":
      return event.escalated
        ? `Escalated: ${event.from} → ${event.to} after ${failuresText(event.failures, event.kind)}.`
        : `Failover: the team switched from ${event.from} to ${event.to} after ${failuresText(event.failures, event.kind)}.`;
    case "exhausted":
      return `${event.model} is failing too (${event.kind}): it is the end of the chain, so the team stays on it.`;
    case "ended":
      return event.probeWorkItemId
        ? `Reverted: ${event.primary} works again (probe ${event.probeWorkItemId}); the team is back on it.`
        : `Ended: the team is back on ${event.primary} — ${event.reason}.`;
    case "retried":
      return null;
  }
}

/**
 * The thread comment an event posts, and on which WorkItem: a retry that
 * moved to the substitute, or the probe that ended the failover. Null for
 * events that comment on no thread.
 */
export function failoverComment(event: FailoverEvent): { workItemId: string; body: string } | null {
  if (event.type === "retried") {
    return { workItemId: event.workItemId, body: `[failover] retried on ${event.to} after ${event.kind} on ${event.from}` };
  }
  if (event.type === "ended" && event.probeWorkItemId) {
    return { workItemId: event.probeWorkItemId, body: `[failover] reverted: ${event.primary} works again on this run (the probe), so the team is back on it` };
  }
  return null;
}

/** The Inbox's failover notes: one per episode (see the file header). */
export class FailoverNotes {
  private readonly load: () => string | null;
  private readonly save: (value: string | null) => void;

  constructor(deps: { load(): string | null; save(value: string | null): void }) {
    this.load = deps.load;
    this.save = deps.save;
  }

  /** Add an episode event's line to its note (creating the note), and mark it unread. */
  record(event: FailoverEvent): void {
    const text = failoverNoteLine(event);
    if (text === null || event.type === "retried") return;
    const id = `failover-${event.episode}`;
    const at = new Date(event.at).toISOString();
    const notes = this.read();
    let note = notes.find((n) => n.id === id);
    if (!note) {
      note = { id, startedAt: new Date(event.episode).toISOString(), updatedAt: at, lines: [], read: false, ended: false };
      notes.unshift(note);
    }
    note.lines.push({ at, text });
    note.updatedAt = at;
    note.read = false;
    if (event.type === "ended") note.ended = true;
    this.write(notes.slice(0, MAX_NOTES));
  }

  /** The notes, newest first; only the unread ones with `unreadOnly`. */
  list(unreadOnly = false): FailoverNoteView[] {
    const notes = this.read();
    return unreadOnly ? notes.filter((n) => !n.read) : notes;
  }

  /** How many are unread (they count toward the Inbox badge). */
  unreadCount(): number {
    return this.read().filter((n) => !n.read).length;
  }

  /** Mark a note read (or unread). False when there is no such note. */
  markRead(id: string, read = true): boolean {
    const notes = this.read();
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    note.read = read;
    this.write(notes);
    return true;
  }

  private read(): FailoverNoteView[] {
    try {
      const raw = this.load();
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(parsed) ? parsed as FailoverNoteView[] : [];
    } catch {
      return [];
    }
  }

  private write(notes: FailoverNoteView[]): void {
    this.save(notes.length ? JSON.stringify(notes) : null);
  }
}

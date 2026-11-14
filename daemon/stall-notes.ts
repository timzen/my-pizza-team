/**
 * daemon/stall-notes.ts — What a stalled teammate tells the people watching
 * (docs/DESIGN.md "Stalled Teammates"): **one Inbox note per stall episode**,
 * and one comment on the work item's thread when it starts.
 *
 * Stalled is computed on read (Store.getMemberStall, shared/stall.ts
 * `stallOf`), so nothing fires when a teammate stalls. The Store's 30-second
 * check (`Store.checkStalls`, beside the reaper) hands `StallNotes.sync` the
 * stalls it sees now, and `sync` keeps the notes in step:
 *
 *   - an episode is named by the teammate and when its progress stopped
 *     (`stall-<memberId>-<since ms>`): however long it stays stalled, and
 *     however many checks see it, it is one note — and one thread comment,
 *     which the Store posts for each note `sync` reports as opened;
 *   - an open note whose stall is no longer seen (progress resumed, the run
 *     ended, the teammate went offline) is marked `ended` — resolved, like a
 *     failover note's end. Its read state is kept: a stall that cleared by
 *     itself asks nothing more of anyone;
 *   - an ended note seen stalled again (a restarted daemon hearing the same
 *     stuck tool again once its heartbeats resume) is reopened quietly — same
 *     episode, no second comment.
 *
 * The notes live in the `settings` table (`stall.notes`, JSON, newest first,
 * the latest `MAX_NOTES` kept), like the failover notes (daemon/failover-notes.ts):
 * daemon-local, not team history.
 */

import { activityText, formatStallDuration } from "../shared/stall.ts";
import type { AgentStall, StallNoteView } from "../shared/protocol.ts";
import type { WorkDefParent } from "../shared/types.ts";

/** The `settings` key the notes are persisted under. */
export const STALL_NOTES_KEY = "stall.notes";

/** How many episodes' notes are kept. */
const MAX_NOTES = 50;

/** One stalled teammate, as the Store's check sees it now. */
export interface StallObservation {
  memberId: string;
  memberName: string;
  stall: AgentStall;
  /** The stuck work item's title and WorkDef, when known (the note's link). */
  workItemTitle: string | null;
  workDefId: string | null;
  /** That WorkDef's parent, for the link. */
  parent?: WorkDefParent;
}

/** An episode's note id: the teammate and when its progress stopped. */
export function stallNoteId(memberId: string, since: number): string {
  return `stall-${memberId}-${since}`;
}

/** The thread comment for a stall's start: ``[stalled] no progress for 30m: bash `node --test …` ``. */
export function stallComment(stall: AgentStall, now: number): string {
  return `[stalled] no progress for ${formatStallDuration(now - stall.since)}: ${activityText(stall.activity)}`;
}

/** The Inbox's stall notes: one per episode (see the file header). */
export class StallNotes {
  private readonly load: () => string | null;
  private readonly save: (value: string | null) => void;

  constructor(deps: { load(): string | null; save(value: string | null): void }) {
    this.load = deps.load;
    this.save = deps.save;
  }

  /**
   * Bring the notes in step with the stalls seen now (`now`, epoch ms): a note
   * for each new episode (unread), ended for each one no longer seen. Returns
   * the notes opened by this call — the Store comments on their threads once.
   */
  sync(observations: StallObservation[], now: number): StallNoteView[] {
    const notes = this.read();
    const at = new Date(now).toISOString();
    const seen = new Set<string>();
    const opened: StallNoteView[] = [];
    let changed = false;
    for (const o of observations) {
      const id = stallNoteId(o.memberId, o.stall.since);
      seen.add(id);
      const existing = notes.find((n) => n.id === id);
      if (existing) {
        // The same episode: keep it current (what it is doing may have moved
        // from one hung call to another without progress in between).
        if (existing.ended) { existing.ended = false; existing.endedAt = null; changed = true; }
        if (o.stall.activity && JSON.stringify(existing.activity) !== JSON.stringify(o.stall.activity)) { existing.activity = o.stall.activity; changed = true; }
        continue;
      }
      const note: StallNoteView = {
        id,
        memberId: o.memberId,
        memberName: o.memberName,
        workItemId: o.stall.workItemId,
        workItemTitle: o.workItemTitle,
        workDefId: o.workDefId,
        ...(o.parent ? { parent: o.parent } : {}),
        since: new Date(o.stall.since).toISOString(),
        notedAt: at,
        activity: o.stall.activity,
        stallMinutes: o.stall.stallMinutes,
        read: false,
        ended: false,
        endedAt: null,
      };
      notes.unshift(note);
      opened.push(note);
      changed = true;
    }
    for (const n of notes) {
      if (!n.ended && !seen.has(n.id)) { n.ended = true; n.endedAt = at; changed = true; }
    }
    if (changed) this.write(notes.slice(0, MAX_NOTES));
    return opened;
  }

  /** The notes, newest first; only the unread ones with `unreadOnly`. */
  list(unreadOnly = false): StallNoteView[] {
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

  private read(): StallNoteView[] {
    try {
      const raw = this.load();
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(parsed) ? parsed as StallNoteView[] : [];
    } catch {
      return [];
    }
  }

  private write(notes: StallNoteView[]): void {
    this.save(notes.length ? JSON.stringify(notes) : null);
  }
}

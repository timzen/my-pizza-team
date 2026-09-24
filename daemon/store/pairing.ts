/**
 * daemon/store/pairing.ts — Pairing with a teammate from the web UI.
 *
 * Phase C of docs/TEAMMATE_CHAT.md. Watching is read-only; **pairing** is how
 * you talk to a teammate: it pauses the teammate's autonomous loop (no new
 * claims, and it won't COMPLETE or reset its session while you're talking), and
 * opens a message channel. **Releasing** hands it back, saying what to do with
 * the work item it holds: `resume` (keep working on it autonomously),
 * `complete` (done — summarized from its last reply), or `fail`.
 *
 * The daemon only holds *intent*; the teammate's extension realizes it. The
 * extension polls `poll()`, which **drains**: queued messages and a pending
 * release are handed over exactly once. In-memory like the transcript — a
 * daemon restart forgets a pairing, but the teammate stays paused (it reports
 * `pairing` in its heartbeat) and a release still reaches it, because a release
 * is recorded whether or not the daemon remembers the pairing.
 */

export type ReleaseAction = "resume" | "complete" | "fail";
/** `queue` lands after the current run (Pi followUp); `steer` at the next tool step. */
export type SendMode = "queue" | "steer";

export interface PairMessage {
  id: string;
  text: string;
  mode: SendMode;
  at: number;
}

interface PairState {
  paired: boolean;
  since: number | null;
  /** A release not yet picked up by the teammate. */
  release: ReleaseAction | null;
  /** Messages not yet picked up by the teammate. */
  outbox: PairMessage[];
}

/** Messages queued per teammate before the oldest are dropped (it isn't polling). */
const MAX_OUTBOX = 50;

export const RELEASE_ACTIONS: readonly ReleaseAction[] = ["resume", "complete", "fail"];

export class TeammatePairing {
  private states = new Map<string, PairState>();
  private counter = 0;

  constructor(private now: () => number = Date.now) {}

  private get(memberId: string): PairState {
    let s = this.states.get(memberId);
    if (!s) {
      s = { paired: false, since: null, release: null, outbox: [] };
      this.states.set(memberId, s);
    }
    return s;
  }

  /** The UI's view: is a web pairing open, and since when? */
  getState(memberId: string): { paired: boolean; since: number | null; pendingRelease: ReleaseAction | null } {
    const s = this.states.get(memberId);
    return { paired: !!s?.paired, since: s?.since ?? null, pendingRelease: s?.release ?? null };
  }

  /** Open a pairing. Idempotent; supersedes an unconsumed release. */
  pair(memberId: string): void {
    const s = this.get(memberId);
    if (!s.paired) s.since = this.now();
    s.paired = true;
    s.release = null;
  }

  /** Queue a message for a paired teammate. Null when not paired. */
  send(memberId: string, text: string, mode: SendMode): PairMessage | null {
    const s = this.states.get(memberId);
    if (!s?.paired) return null;
    const msg: PairMessage = { id: `pm-${this.now()}-${++this.counter}`, text, mode, at: this.now() };
    s.outbox.push(msg);
    if (s.outbox.length > MAX_OUTBOX) s.outbox.splice(0, s.outbox.length - MAX_OUTBOX);
    return msg;
  }

  /**
   * End the pairing with an action. Recorded even if this daemon never saw the
   * pairing (restart), so a teammate paused before the restart can still be
   * released. Unsent messages are dropped: they were for the pairing.
   */
  release(memberId: string, action: ReleaseAction): void {
    const s = this.get(memberId);
    s.paired = false;
    s.since = null;
    s.release = action;
    s.outbox = [];
  }

  /** Agent-facing: current intent, draining messages and any pending release. */
  poll(memberId: string): { paired: boolean; release: ReleaseAction | null; messages: PairMessage[] } {
    const s = this.states.get(memberId);
    if (!s) return { paired: false, release: null, messages: [] };
    const out = { paired: s.paired, release: s.release, messages: s.outbox };
    s.release = null;
    s.outbox = [];
    return out;
  }

  /** Drop a member's state (dismissed / deregistered). */
  forget(memberId: string): void {
    this.states.delete(memberId);
  }
}

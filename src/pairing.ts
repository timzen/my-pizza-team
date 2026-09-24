// Web pairing: talk to this teammate from the browser
//
// Phase C of my-pizza-team docs/TEAMMATE_CHAT.md. Watching (transcript.ts) is
// read-only; *pairing* is how the web UI talks to a teammate. The daemon holds
// the intent, and this class polls it (GET /api/agents/:id/pairing, which
// drains) and hands each change to the handlers index.ts wires up:
//
//   paired: true (was false)  → onPair       pause the work loop; nothing new is claimed,
//                                             and a held item isn't COMPLETEd behind your back
//   messages[]                → onMessage    hand to Pi (queue = followUp, steer = steer)
//   release                   → onRelease    resume / complete / fail the held item
//
// Poll cadence follows the watch view: fast while someone has the page open
// (you can only pair or message from there), slow otherwise — a release can
// still arrive after you navigate away and come back.

import type { PairingPoll, PairReleaseAction } from "./client.js";

/** The slice of DaemonClient this needs (kept narrow so tests can fake it). */
export interface PairingClient {
  getPairing(): Promise<PairingPoll>;
}

export interface PairingHandlers {
  onPair(): void;
  onMessage(text: string, mode: "queue" | "steer"): void;
  onRelease(action: PairReleaseAction): void | Promise<void>;
}

const FAST_POLL_MS = 1000;
const SLOW_POLL_MS = 5000;

export class WebPairing {
  private paired = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private client: PairingClient;
  private handlers: PairingHandlers;
  /** Is the watch view open? Picks the poll cadence. */
  private isWatched: () => boolean;
  private opts: { fastMs?: number; slowMs?: number };

  // Plain fields rather than parameter properties: the tests run under Node's
  // type-stripping, which doesn't support them.
  constructor(
    client: PairingClient,
    handlers: PairingHandlers,
    isWatched: () => boolean,
    opts: { fastMs?: number; slowMs?: number } = {},
  ) {
    this.client = client;
    this.handlers = handlers;
    this.isWatched = isWatched;
    this.opts = opts;
  }

  get isPaired(): boolean {
    return this.paired;
  }

  start(): void {
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One poll: apply the drained intent, in order (pair → messages → release). */
  async tick(): Promise<void> {
    try {
      const poll = await this.client.getPairing();
      if (poll.paired && !this.paired) {
        this.paired = true;
        this.handlers.onPair();
      }
      for (const m of poll.messages) this.handlers.onMessage(m.text, m.mode);
      if (poll.release) {
        this.paired = false;
        await this.handlers.onRelease(poll.release);
      }
    } catch {
      // Daemon unreachable — keep the current state and retry.
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.running) return;
    const ms = this.isWatched() ? (this.opts.fastMs ?? FAST_POLL_MS) : (this.opts.slowMs ?? SLOW_POLL_MS);
    this.timer = setTimeout(() => void this.tick(), ms);
  }
}

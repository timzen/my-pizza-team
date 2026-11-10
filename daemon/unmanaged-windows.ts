/**
 * daemon/unmanaged-windows.ts — the windows in the team's terminal container that MPT
 * doesn't account for, for the Team tab's "Unmanaged windows" section.
 *
 * A terminal's own session restore (herdr relaunching panes after a reboot), a user's
 * bonus tab, or an agent that never registered can leave windows in the team's
 * container that no member owns. They run agents (or shells) that count toward what
 * is running on the machine but not toward MPT's teammates, and nothing used to say
 * they were there. This lists them: every window label in the configured backend's
 * team container (`TeamConfig.tmuxSession`) that is not
 *
 *   - an online member's window (`memberTerminal`: its `terminalWindow` metadata, else
 *     its name) in that backend and container,
 *   - the leader's window (`LEADER_WINDOW`), whether or not a leader is online, or
 *   - reserved by a directive (MemberStore.getReservedWindows): a spawn still pending
 *     or within its registration grace, or a dismiss already closing it.
 *
 * It only *reports*: nothing here closes a window on its own (the user may have
 * opened that tab on purpose). `POST /api/unmanaged-windows/close` closes one when a
 * human asks, and only a label this list currently holds. See docs/DESIGN.md
 * "Unmanaged Windows Are Shown, Never Reaped".
 */

import { LEADER_WINDOW, type Member, type TeamConfig, type UnmanagedWindow } from "../shared/types.ts";
import { memberTerminal } from "./spawner.ts";
import type { TerminalBackend } from "./terminal/backend.ts";

/** What the computation needs: the container's labels and who owns which. */
export interface UnmanagedWindowInputs {
  /** The backend the labels came from; members recorded under another backend never match. */
  terminal: TerminalBackend["kind"];
  /** The team container the labels came from. */
  session: string;
  /** Every window label in it (`TerminalBackend.listWindows`). */
  labels: string[];
  members: Array<Pick<Member, "name" | "status" | "metadata">>;
  config: Pick<TeamConfig, "tmuxSession" | "terminal">;
  /** Labels a directive reserves (MemberStore.getReservedWindows). */
  reserved: string[];
}

/**
 * The labels in `inputs.labels` nothing accounts for, in container order, each once
 * (herdr allows duplicate labels; one entry stands for them all). Pure, so the
 * rules are unit-testable without a terminal.
 */
export function unmanagedWindowLabels(inputs: UnmanagedWindowInputs): string[] {
  const owned = new Set<string>([LEADER_WINDOW, ...inputs.reserved]);
  for (const m of inputs.members) {
    if (m.status === "offline") continue;
    const where = memberTerminal(m, inputs.config);
    if (where.terminal === inputs.terminal && where.session === inputs.session) owned.add(where.window);
  }
  const out: string[] = [];
  for (const label of inputs.labels) {
    if (!owned.has(label) && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Read the team container from `backend` and describe each unmanaged window,
 * including what runs in it (`TerminalBackend.windowActivity`, asked only for the
 * unmanaged ones). Never throws: a backend that can't be read gives an empty list.
 */
export function scanUnmanagedWindows(
  backend: TerminalBackend,
  inputs: Omit<UnmanagedWindowInputs, "terminal" | "session" | "labels">,
): UnmanagedWindow[] {
  const session = inputs.config.tmuxSession || "mpt";
  try {
    const labels = unmanagedWindowLabels({ ...inputs, terminal: backend.kind, session, labels: backend.listWindows(session) });
    return labels.map((window) => {
      let activity: { running: boolean | null; command: string | null } = { running: null, command: null };
      try {
        activity = backend.windowActivity(backend.windowRef(session, window));
      } catch { /* unknown: one odd window doesn't hide the rest */ }
      return { window, session, terminal: backend.kind, running: activity.running, command: activity.command };
    });
  } catch {
    return []; // an unsafe session name, a server that went away mid-read
  }
}

/** How long a scan is reused (`UnmanagedWindowTracker.list`): the Team tab polls every 10s. */
export const UNMANAGED_SCAN_TTL_MS = 10_000;

/** What the tracker reads from the Store on each scan. */
export interface UnmanagedWindowSource {
  /** The configured backend, or null when it can't be used (unprobed, unreachable) — then nothing is listed. */
  backend(): TerminalBackend | null;
  members(): Array<Pick<Member, "name" | "status" | "metadata">>;
  config(): Pick<TeamConfig, "tmuxSession" | "terminal">;
  reserved(): string[];
}

/** Why `UnmanagedWindowTracker.close` didn't close a window. */
export type CloseUnmanagedResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The unmanaged-window list, computed lazily and cached for `ttlMs` so polling
 * clients never turn into a terminal scan per request (each herdr read is several
 * process spawns), and the close action that is only allowed on it.
 */
export class UnmanagedWindowTracker {
  private cache: { at: number; windows: UnmanagedWindow[] } | null = null;
  private readonly source: UnmanagedWindowSource;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(source: UnmanagedWindowSource, ttlMs = UNMANAGED_SCAN_TTL_MS, now: () => number = Date.now) {
    this.source = source;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** The current list: the cached scan when fresh, else a new one. `fresh` forces a scan. */
  list(fresh = false): UnmanagedWindow[] {
    if (!fresh && this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.windows;
    const backend = this.source.backend();
    const windows = backend
      ? scanUnmanagedWindows(backend, { members: this.source.members(), config: this.source.config(), reserved: this.source.reserved() })
      : [];
    this.cache = { at: this.now(), windows };
    return windows;
  }

  /** Drop the cached scan, so the next `list` reads the terminal (the backend changed). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Close one unmanaged window — only when a fresh scan still lists it, so a label
   * that has since become a member's (or the leader's, or a spawn's) is refused
   * rather than closed. 404 when it isn't unmanaged; 409 when the backend couldn't
   * close it. Refreshes the cache either way.
   */
  close(window: string): CloseUnmanagedResult {
    const backend = this.source.backend();
    const target = this.list(true).find((w) => w.window === window);
    if (!backend || !target) return { ok: false, status: 404, error: `"${window}" is not an unmanaged window in the team's terminal` };
    let closed = false;
    let why = "";
    try {
      closed = backend.closeWindow(backend.windowRef(target.session, target.window));
    } catch (e) {
      why = `: ${(e as Error).message}`; // e.g. a tmux window name tmux can't target
    }
    this.cache = null;
    if (!closed) return { ok: false, status: 409, error: `${backend.displayName} could not close window ${target.session}:${target.window}${why}` };
    return { ok: true };
  }
}

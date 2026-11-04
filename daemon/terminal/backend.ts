/**
 * daemon/terminal/backend.ts — the `TerminalBackend` interface: what mpt needs from a
 * terminal multiplexer.
 *
 * The daemon is the only component that runs a terminal (docs/DESIGN.md "The Daemon
 * Is the Supervisor"): it opens the leader's and each teammate's window, types the
 * harness command into it, sends Ctrl-C on dismiss, closes it, and brings it to the
 * front for `/ppt-hop`. The CLI additionally attaches the user's terminal to the
 * leader (`mpt assistant`), and `mpt doctor` reports which server it talks to. This
 * interface is exactly that set and no more, so a second backend (herdr, docs/herdr.md)
 * is one more implementation rather than a branch in every caller. tmux
 * (daemon/terminal/tmux.ts) is the default; herdr (daemon/terminal/herdr.ts) the
 * alternative. `getTerminalBackend` (daemon/terminal/index.ts) picks the one the
 * team's `terminal` config names.
 *
 * Windows are addressed by **label** — `(session, window)`, the names the user sees
 * and agents report as `terminalSession`/`terminalWindow` metadata (before herdr,
 * `tmuxSession`/`tmuxWindow`; shared/types.ts `TERMINAL_METADATA_KEYS`) — never by a backend's
 * own IDs. herdr's pane/tab IDs are server-assigned and can change, so a backend
 * resolves the labels on each operation (docs/herdr.md "Finding a window again: by
 * label, every time"). A `WindowRef` is therefore an opaque handle a caller gets from
 * `windowRef`/`openWindow`/`findWindow` and hands back; it may carry a backend's ID as
 * a hint, but the labels are the source of truth.
 */

import type { TerminalKind } from "../../shared/types.ts";

/** Which terminal implementation a backend is (`TeamConfig.terminal`). */
export type TerminalBackendKind = TerminalKind;

/**
 * A handle on one window. Opaque to callers: get one from the backend, store its
 * labels (`session`, `window`) in agent metadata, and rebuild it with `windowRef`.
 */
export interface WindowRef {
  /** The team container's label (tmux session; herdr workspace). */
  readonly session: string;
  /** The window's label (tmux window; herdr tab). */
  readonly window: string;
  /** A backend-specific ID, as a display/debug hint only — never used to find the window. */
  readonly id?: string;
}

/** What `openWindow` needs: where the window lives, what it runs, and its environment. */
export interface OpenWindowOptions {
  session: string;
  window: string;
  /** The directory the command runs in. */
  cwd: string;
  /** A shell command line (a filled harness template, daemon/terminal/template.ts). */
  command: string;
  /**
   * Variables the window's processes get (the agent env file, shared/env-file.ts),
   * given to the window at creation — never typed into its shell.
   */
  env?: Record<string, string>;
}

/** The result of `openWindow`: the window's handle, and whether it was just created. */
export interface OpenedWindow {
  /**
   * False when a live window with that label already existed; nothing was run then.
   * (herdr: an existing tab whose pane runs only its shell — restored by a server
   * restart without its process — gets the command run into it, and counts as created.)
   */
  created: boolean;
  ref: WindowRef;
}

/**
 * Why a backend can't be used from this process: absent, not allowed to run, a
 * version mpt doesn't support (herdr older than its minimum, or a server
 * incompatible with its CLI), or a setting the backend can't take (an invalid
 * herdr session name).
 */
export type TerminalUnavailableReason = "none" | "not-installed" | "not-permitted" | "unsupported-version" | "misconfigured";

/** A control key that must be sent as a key, not typed as text. */
export type ControlKey = "C-c";

/**
 * A terminal multiplexer the daemon runs agents in.
 *
 * Every method is synchronous and argv-only (no shell between mpt and the
 * backend's CLI); only `OpenWindowOptions.command` and `sendLine`'s text are shell
 * strings, because they are typed into a shell.
 */
export interface TerminalBackend {
  readonly kind: TerminalBackendKind;
  /** The name users see in messages ("tmux"). */
  readonly displayName: string;

  // ─── Availability ────────────────────────────────────────────────
  /** Can this process run the backend at all? */
  available(): boolean;
  /** Why not, when it can't: "not installed" and "not permitted" need different fixes. */
  unavailableReason(): TerminalUnavailableReason;
  /** The same, as a user-facing reason and fix; null when the backend is usable. */
  unavailable(): { reason: string; fix: string } | null;
  /**
   * Which server this process reaches (tmux: its socket path), or null when the
   * backend can't run. Reported on `/health` so `mpt doctor` can compare it with the
   * CLI's own. Never starts a server.
   */
  identity(): string | null;

  // ─── Windows ─────────────────────────────────────────────────────
  /** Ensure the team container exists; true when it was just created. `env` goes to its first window. */
  ensureContainer(session: string, env?: Record<string, string>): boolean;
  /** Window labels in a container; empty when it doesn't exist (or the server isn't running). */
  listWindows(session: string): string[];
  /** The window with that label, or null when there is none. */
  findWindow(session: string, window: string): WindowRef | null;
  /** A handle for a window known only by its labels (e.g. from agent metadata). Does not check it exists. */
  windowRef(session: string, window: string): WindowRef;
  /**
   * Open a window running `command` in `cwd` with `env`. Idempotent by label: when the
   * window exists, nothing is run and `created` is false. Throws when it can't.
   */
  openWindow(opts: OpenWindowOptions): OpenedWindow;
  /** Type a line into the window, as if at the keyboard, and press Enter. Throws on failure. */
  sendLine(ref: WindowRef, line: string): void;
  /** Send a control key (e.g. Ctrl-C). Best effort. */
  sendControl(ref: WindowRef, key: ControlKey): void;
  /** Close the window; false when it couldn't (e.g. already gone). */
  closeWindow(ref: WindowRef): boolean;
  /** Make the window its container's current one (the daemon's `/ppt-hop`); false when it couldn't. */
  focusWindow(ref: WindowRef): boolean;

  // ─── The user's terminal (CLI only; the daemon has no client) ────
  /** Is this process running inside one of the backend's windows (tmux: `$TMUX`)? */
  insideClient(env?: NodeJS.ProcessEnv): boolean;
  /**
   * Show the window in the calling client, from inside the backend (tmux:
   * select-window, then switch-client). Returns the error text when it failed, else null.
   */
  focusClient(ref: WindowRef): string | null;
  /** Hand this process's terminal to the backend, showing the window. True when the attach succeeded. */
  attach(ref: WindowRef): boolean;
}

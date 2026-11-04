// The terminal-location flags the daemon passes a Pi agent, and the registration
// metadata they become.
//
// The daemon opens every agent's window (my-pizza-team docs/DESIGN.md "The Daemon
// Is the Supervisor") and fills the harness template's `{terminal}`,
// `{terminalSession}`, `{terminalWindow}` (and optionally `{terminalHandle}`)
// placeholders into `--ppt-terminal*` flags. The agent reports them back verbatim
// at registration, which is how the daemon later addresses the right window —
// closing it on dismiss, focusing it for /ppt-hop — in the backend it was started
// under. The harness only relays these values: it never interprets them and never
// runs a terminal itself.
//
// `--ppt-tmux-session`/`--ppt-tmux-window` are the older names (before herdr was a
// choice), still registered so a team's own `harnesses.pi` templates keep working;
// the neutral flags win when both are given.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { terminalMetadata } from "./shared/agent-protocol.js";

/** Flag name → description; all strings, all defaulting to "". */
const TERMINAL_FLAGS: Record<string, string> = {
  "ppt-terminal": "terminal backend the window is in (set by the daemon on spawn)",
  "ppt-terminal-session": "terminal session/container name (set by the daemon on spawn)",
  "ppt-terminal-window": "terminal window name (set by the daemon on spawn)",
  "ppt-terminal-handle": "the terminal's own window ID, if any (set by the daemon on spawn)",
  "ppt-tmux-session": "older name of --ppt-terminal-session",
  "ppt-tmux-window": "older name of --ppt-terminal-window",
};

/** Register the terminal-location flags (once, at extension load). */
export function registerTerminalFlags(pi: ExtensionAPI): void {
  for (const [name, description] of Object.entries(TERMINAL_FLAGS)) {
    pi.registerFlag(name, { description, type: "string", default: "" });
  }
}

/**
 * This agent's window as opaque registration metadata (`terminal`,
 * `terminalSession`, `terminalWindow`, `terminalHandle`), from whichever flags it
 * was started with. Empty when started by hand with none.
 */
export function readTerminalMetadata(pi: ExtensionAPI): Record<string, unknown> {
  const get = (name: string) => (pi.getFlag(name) as string | undefined) || "";
  return terminalMetadata({
    terminal: get("ppt-terminal"),
    session: get("ppt-terminal-session"),
    window: get("ppt-terminal-window"),
    handle: get("ppt-terminal-handle"),
    legacySession: get("ppt-tmux-session"),
    legacyWindow: get("ppt-tmux-window"),
  });
}

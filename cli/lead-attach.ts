/**
 * cli/lead-attach.ts — how `mpt assistant` (alias `mpt lead`) hands the user's terminal
 * to the assistant's window, per terminal backend.
 *
 * After the leader's window is open (daemon/leader-start.ts), the CLI either attaches
 * this terminal to it, moves the client it is already running in, or — where either
 * would nest one terminal multiplexer inside another — prints the command to run
 * instead. Which one is a pure function of the backend and the environment
 * (`attachPlan`), kept here so it is testable without a terminal:
 *
 *   - **Inside the backend's own client** (tmux: `$TMUX`; herdr: a pane of the team's
 *     herdr server, `HERDR_ENV=1` with its socket): move that client to the leader
 *     (`focusClient` — tmux `switch-client`, herdr `tab focus`), never nest.
 *   - **tmux, anywhere else:** attach, as it always has (a tmux client inside a herdr
 *     pane works).
 *   - **herdr, inside tmux or inside another herdr server's pane:** print the attach
 *     command. herdr refuses a nested launch, and a herdr client inside a tmux window
 *     is a terminal inside a terminal the user didn't ask for (docs/herdr.md
 *     "Ensuring a server, attaching, and 'inside herdr'").
 *   - **herdr, in a plain terminal:** focus the leader tab, then attach.
 *
 * `--no-attach` prints `noAttachHints` — the backend's attach and switch commands.
 */

import type { TerminalBackend, WindowRef } from "../daemon/terminal/backend.ts";

/** What `mpt assistant` does with the user's terminal once the leader's window is open. */
export type AttachPlan =
  | { action: "focus" }
  | { action: "attach" }
  | { action: "print"; why: string };

/**
 * Attach, move the current client, or print the command? See the header for the
 * rules. `env` is this process's environment.
 */
export function attachPlan(
  terminal: Pick<TerminalBackend, "kind" | "insideClient">,
  env: NodeJS.ProcessEnv = process.env,
): AttachPlan {
  if (terminal.insideClient(env)) return { action: "focus" };
  if (terminal.kind === "herdr") {
    if (env["TMUX"]) {
      return { action: "print", why: "You're inside tmux, and this team's terminal is herdr — attaching here would nest herdr inside tmux" };
    }
    if (env["HERDR_ENV"] === "1") {
      return { action: "print", why: "You're inside a pane of a different herdr server than the team's — herdr won't nest" };
    }
  }
  return { action: "attach" };
}

/** The lines `--no-attach` prints: how to attach from a plain terminal, and how to get there from inside the backend. */
export function noAttachHints(terminal: Pick<TerminalBackend, "displayName" | "attachCommand" | "switchHint">, leader: WindowRef): string[] {
  return [
    `Attach with: ${terminal.attachCommand(leader)}`,
    `From inside ${terminal.displayName}: ${terminal.switchHint(leader)}`,
  ];
}

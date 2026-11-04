/**
 * daemon/terminal/index.ts — `getTerminalBackend`: the one place that decides which
 * terminal the daemon (and the CLI) drives.
 *
 * Every caller that opens, types into, closes, focuses or attaches to a window —
 * the spawner, the leader start, the focus route, `mpt assistant`, `mpt doctor`,
 * daemon startup — gets its backend here rather than importing tmux directly, so a
 * second backend (docs/herdr.md) is a choice made in one place.
 *
 * Two entry points, because there are two questions:
 *
 *   - `getTerminalBackend(config)` — where do *new* windows open? The team's
 *     `terminal` setting (shared/types.ts `resolveTerminal`; unset = tmux).
 *   - `createTerminalBackend(kind)` — where is *this* window? An existing agent's
 *     window lives in the backend it was started under (its `terminal` metadata,
 *     daemon/spawner.ts `memberTerminal`), which may not be the configured one any
 *     more: switching the setting applies to new windows only, and dismiss/focus
 *     of the old ones still go to the old backend.
 *
 * tmux is the only backend implemented. herdr is accepted in config but is, for
 * now, a backend that is never available (daemon/terminal/unavailable.ts), so
 * selecting it refuses spawns and the assistant start with a clear "not available
 * yet" reason instead of silently opening tmux windows.
 */

import { resolveTerminal, type TeamConfig, type TerminalKind } from "../../shared/types.ts";
import type { TerminalBackend } from "./backend.ts";
import { createTmuxBackend, realTmux, type TmuxExec } from "./tmux.ts";
import { createUnavailableBackend, type UnavailableBackendReason } from "./unavailable.ts";

export type * from "./backend.ts";

/** Overrides for tests: a fake `TmuxExec` instead of the real `tmux`. */
export interface TerminalBackendOptions {
  tmuxExec?: TmuxExec;
}

/**
 * Why a terminal kind can't be driven by this version of mpt at all (as opposed to
 * a backend that is implemented but not installed), or null when it can. Today:
 * herdr, until its backend lands.
 */
export function terminalNotImplemented(kind: TerminalKind): UnavailableBackendReason | null {
  if (kind === "herdr") {
    return {
      reason: "the herdr terminal backend is not available yet in this version of mpt",
      fix: 'set Terminal back to "tmux" in Config → General (or remove "terminal" from the team\'s config.json)',
    };
  }
  return null;
}

/** The backend for one terminal kind — for a window recorded under it, or for new windows. */
export function createTerminalBackend(kind: TerminalKind, opts: TerminalBackendOptions = {}): TerminalBackend {
  const missing = terminalNotImplemented(kind);
  if (missing) return createUnavailableBackend(kind, kind, missing);
  return createTmuxBackend(opts.tmuxExec ?? realTmux);
}

/**
 * The terminal backend a team's *new* windows open in: the one its `terminal`
 * config names (unset = tmux). For an existing window, use
 * `createTerminalBackend` with the kind it was started under.
 */
export function getTerminalBackend(
  config?: Partial<TeamConfig>,
  opts: TerminalBackendOptions = {},
): TerminalBackend {
  return createTerminalBackend(resolveTerminal(config), opts);
}

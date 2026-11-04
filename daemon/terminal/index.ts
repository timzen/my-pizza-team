/**
 * daemon/terminal/index.ts — `getTerminalBackend`: the one place that decides which
 * terminal the daemon (and the CLI) drives.
 *
 * Every caller that opens, types into, closes, focuses or attaches to a window —
 * the spawner, the leader start, the focus route, `mpt assistant`, `mpt doctor`,
 * daemon startup — gets its backend here rather than importing tmux directly, so a
 * second backend (docs/herdr.md) is a choice made in one function. Today it is
 * always tmux.
 */

import type { TeamConfig } from "../../shared/types.ts";
import type { TerminalBackend } from "./backend.ts";
import { createTmuxBackend, realTmux, type TmuxExec } from "./tmux.ts";

export type * from "./backend.ts";

/** Overrides for tests: a fake `TmuxExec` instead of the real `tmux`. */
export interface TerminalBackendOptions {
  tmuxExec?: TmuxExec;
}

/**
 * The terminal backend for a team. `config` is accepted (and ignored) so callers
 * already pass what the choice will be made from; for now every team gets tmux.
 */
export function getTerminalBackend(
  _config?: Partial<TeamConfig>,
  opts: TerminalBackendOptions = {},
): TerminalBackend {
  return createTmuxBackend(opts.tmuxExec ?? realTmux);
}

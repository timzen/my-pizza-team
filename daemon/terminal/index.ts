/**
 * daemon/terminal/index.ts — `getTerminalBackend`: the one place that decides which
 * terminal the daemon (and the CLI) drives.
 *
 * Every caller that opens, types into, closes, focuses or attaches to a window —
 * the spawner, the leader start, the focus route, `mpt assistant`, `mpt doctor`,
 * daemon startup — gets its backend here rather than importing tmux or herdr
 * directly, so the choice is made in one place.
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
 * tmux (daemon/terminal/tmux.ts) is the default; herdr (daemon/terminal/herdr.ts,
 * docs/herdr.md) talks to the herdr session `TeamConfig.herdrSession` names.
 */

import { resolveTerminal, type TeamConfig, type TerminalKind } from "../../shared/types.ts";
import type { TerminalBackend, TerminalStatus } from "./backend.ts";
import { createHerdrBackend, type HerdrExec, type HerdrLaunch } from "./herdr.ts";
import { createTmuxBackend, realTmux, type TmuxExec } from "./tmux.ts";

export type * from "./backend.ts";

/** Which herdr server to use, and fakes for tests (a `TmuxExec` / `HerdrExec` instead of the real CLIs). */
export interface TerminalBackendOptions {
  tmuxExec?: TmuxExec;
  herdrExec?: HerdrExec;
  /** How the herdr backend starts a server (tests: record instead of spawning). */
  herdrLaunch?: HerdrLaunch;
  /** The herdr session (`TeamConfig.herdrSession`); unset = herdr's default session. */
  herdrSession?: string;
}

/** The backend for one terminal kind — for a window recorded under it, or for new windows. */
export function createTerminalBackend(kind: TerminalKind, opts: TerminalBackendOptions = {}): TerminalBackend {
  if (kind === "herdr") {
    return createHerdrBackend({ session: opts.herdrSession, exec: opts.herdrExec, launch: opts.herdrLaunch });
  }
  return createTmuxBackend(opts.tmuxExec ?? realTmux);
}

/**
 * The options a team's config implies (its herdr session), with `opts` on top —
 * what every caller with a config passes to `createTerminalBackend`.
 */
export function terminalOptions(
  config: Partial<Pick<TeamConfig, "herdrSession">> | undefined,
  opts: TerminalBackendOptions = {},
): TerminalBackendOptions {
  const herdrSession = opts.herdrSession ?? config?.herdrSession;
  return herdrSession ? { ...opts, herdrSession } : opts;
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
  return createTerminalBackend(resolveTerminal(config), terminalOptions(config, opts));
}

/**
 * One line naming a terminal and its state, as the daemon's startup log and `mpt
 * doctor` print it: `herdr 0.9.5 — session "default", server running (socket …)`,
 * `tmux 3.4 — server not running (socket …)`, or the reason it can't be used.
 * `fallback` names the backend when there is no status at all.
 */
export function formatTerminalStatus(status: TerminalStatus | null, fallback: string): string {
  if (!status) return `${fallback} (status unknown)`;
  const name = status.version ? `${status.displayName} ${status.version}` : status.displayName;
  if (!status.available) return `${name} — unavailable: ${status.reason ?? "unknown reason"}`;
  const parts: string[] = [];
  if (status.session) parts.push(`session "${status.session}"`);
  if (status.serverRunning !== null) parts.push(status.serverRunning ? "server running" : "server not running");
  const where = status.identity ? ` (socket ${status.identity})` : "";
  return parts.length > 0 ? `${name} — ${parts.join(", ")}${where}` : `${name}${where}`;
}

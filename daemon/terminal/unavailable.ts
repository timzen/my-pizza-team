/**
 * daemon/terminal/unavailable.ts — a `TerminalBackend` that is never available:
 * what a team gets for a terminal this version of mpt accepts in config but can't
 * drive yet (herdr, until its backend lands — docs/herdr.md).
 *
 * Why a stand-in rather than a special case in each caller: every caller already
 * handles an unavailable backend — the startup probe, `probeTerminalCapability`,
 * the spawn and assistant-start capability checks, doctor — so a backend that
 * answers `unavailable()` with "not available yet" and its fix reaches the user
 * through the same paths a missing `tmux` binary does. Window operations throw that
 * same message, so anything that gets past the capability checks (a dismiss of a
 * window recorded under this backend, a `/ppt-hop` to one) fails with it rather
 * than touching some other terminal.
 */

import type { TerminalBackend, TerminalBackendKind } from "./backend.ts";

/** A user-facing reason the backend can't be used, and what to do about it. */
export interface UnavailableBackendReason {
  reason: string;
  fix: string;
}

/**
 * A backend of `kind` that is never available. `unavailable()` returns `why`;
 * window operations throw it as one line ("<reason> — fix: <fix>").
 */
export function createUnavailableBackend(
  kind: TerminalBackendKind,
  displayName: string,
  why: UnavailableBackendReason,
): TerminalBackend {
  const message = `${why.reason} — fix: ${why.fix}`;
  const refuse = (): never => {
    throw new Error(message);
  };
  return {
    kind,
    displayName,
    available: () => false,
    unavailableReason: () => "not-implemented",
    unavailable: () => ({ ...why }),
    identity: () => null,
    ensureContainer: refuse,
    listWindows: refuse,
    findWindow: refuse,
    // A handle is just labels; building one touches nothing, so it never throws.
    windowRef: (session, window) => ({ session, window }),
    openWindow: refuse,
    sendLine: refuse,
    sendControl: refuse,
    closeWindow: refuse,
    focusWindow: refuse,
    insideClient: () => false,
    focusClient: () => message,
    attach: () => false,
  };
}

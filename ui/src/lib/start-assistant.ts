/**
 * lib/start-assistant.ts — The rules behind "Start the assistant", the button the
 * UI offers wherever it used to tell a new user to run `mpt lead`
 * (components/assistant/StartAssistant.tsx renders it).
 *
 * The daemon is the one that starts it — `POST /api/assistant/start`, the only
 * component that drives tmux (docs/DESIGN.md "The Daemon Is the Supervisor") —
 * and says beforehand whether it can (`/health`'s `assistantStartable`). This
 * module turns those two answers into what the button shows: whether to offer it
 * at all (`startAvailability`), and what a click led to (`startOutcome`):
 * "Starting…" until the leader registers, or the daemon's reason and fix.
 *
 * Only type imports, so it's unit-tested directly (tests/start-assistant-ui.test.ts).
 */

/** The slice of `/health` the button reads. */
export interface StartHealth {
  /** Can the assistant be started from the UI? Absent from a daemon that predates the button. */
  assistantStartable?: { ok: true } | { ok: false; reason?: string; fix?: string };
}

/** Whether to offer the button, and if not, why (the daemon's reason and fix). */
export type StartAvailability =
  | { canStart: true }
  | { canStart: false; reason: string; fix: string };

/**
 * Should the button be offered? Yes unless the daemon said it can't start the
 * assistant — then its reason and fix are shown instead of a button that would
 * only fail. Before `/health` answers, nothing claims the daemon can't (as with
 * lib/empty-states.ts `spawnState`), so the button doesn't flicker in.
 */
export function startAvailability(health: StartHealth | null | undefined): StartAvailability {
  const s = health?.assistantStartable;
  if (!s || s.ok) return { canStart: true };
  return {
    canStart: false,
    reason: s.reason || "the daemon can't start the assistant",
    fix: s.fix || "run `mpt doctor` to see why",
  };
}

/** The body of `POST /api/assistant/start` (201 started, 200 already running, 409 refused). */
export interface StartResponse {
  success?: boolean;
  status?: "started" | "already-running" | "error";
  /** Where it runs (on success): the tmux session and window. */
  session?: string;
  window?: string;
  /** On a refusal: what went wrong and how to fix it. */
  reason?: string;
  fix?: string;
  error?: string;
}

/** What a click led to. */
export type StartOutcome =
  | {
    kind: "starting";
    /** `session:window`, so the "Starting…" note can say where to look; null if unknown. */
    where: string | null;
    /** True when it was already running (a window existed, or a leader was connected). */
    already: boolean;
  }
  | { kind: "error"; message: string };

/**
 * What the daemon's answer means for the button. Started, or already running,
 * is "Starting…" — either way the leader registers soon and the screen's own
 * presence data takes over. A refusal is its reason and fix, as one sentence the
 * user can act on; a malformed answer still says something.
 */
export function startOutcome(res: StartResponse | null | undefined): StartOutcome {
  if (res?.success && (res.status === "started" || res.status === "already-running")) {
    return {
      kind: "starting",
      where: res.session && res.window ? `${res.session}:${res.window}` : null,
      already: res.status === "already-running",
    };
  }
  if (res?.reason) {
    return { kind: "error", message: `Couldn't start the assistant: ${res.reason}.${res.fix ? ` To fix it, ${res.fix}.` : ""}` };
  }
  return { kind: "error", message: `Couldn't start the assistant${res?.error ? `: ${res.error}` : ""}.` };
}

/** The error when the request itself failed (the daemon is down or unreachable). */
export const START_UNREACHABLE = "Couldn't reach the daemon to start the assistant. Is `mpt start` still running?";

/**
 * How long "Starting…" waits before it adds a hint about where to look: a
 * leader normally registers in seconds, so a minute means something's wrong in
 * its window (a prompt, a crash) that the user needs to see.
 */
export const START_SLOW_MS = 60_000;

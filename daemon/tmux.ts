/**
 * daemon/tmux.ts — tmux session and window control, owned by the daemon.
 *
 * Moved here from the Pi extension (docs/DESIGN.md "The Daemon Is the Supervisor", P3-1). The
 * point of the move: while tmux lived in the extension, adding a harness meant
 * shipping extension code. With the daemon driving tmux, a non-Pi teammate needs no
 * in-process code at all — the daemon creates its window, types the prompt, and
 * watches it (Tier 0, DESIGN.md "Harness Tiers, and Why Not MCP").
 *
 * Two deliberate differences from the extension's version:
 *
 *   1. **No shell.** Every tmux call goes through `spawnSync` with an argv array,
 *      so nothing is interpolated into a command line. The extension sanitised
 *      arguments with `s.replace(/[^a-zA-Z0-9._~/:@-]/g, "")`, which *strips*
 *      offending characters rather than quoting them — so a project at
 *      `/Users/t/My Project` silently became `/Users/t/MyProject` and the teammate
 *      span up in the wrong directory, or none. argv arrays remove the class.
 *   2. **Quoting only where a shell is genuinely involved.** `send-keys` types
 *      characters into an interactive shell, so the *inner* command really is a
 *      shell string; `shellQuote` wraps it in single quotes properly instead of
 *      deleting characters from it.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Result of one tmux invocation. */
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs `tmux <args>`. Injectable so the logic is testable without tmux installed. */
export type TmuxExec = (args: string[]) => ExecResult;

/** The real thing: `tmux` with an argv array, never a shell. */
export const realTmux: TmuxExec = (args) => {
  const out = spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity });
  // tmux missing entirely, or not executable.
  if (out.error) return { ok: false, stdout: "", stderr: out.error.message };
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
};

/** Is tmux available at all? Reported by `mpt doctor`. */
export function tmuxAvailable(exec: TmuxExec = realTmux): boolean {
  return exec(["-V"]).ok;
}

/**
 * Why tmux couldn't be reached, when it couldn't.
 *
 * Distinguishes "not installed" from "not allowed to look", because the two need
 * different answers and look identical otherwise. This existed as a bug for one
 * commit: the integration tests gated on `tmuxAvailable()` and silently skipped when
 * the test runner wasn't allowed to start processes — reporting green while testing
 * nothing. "Not permitted" is tmux not executable by us (EACCES/EPERM) or Node's
 * permission model refusing child processes (ERR_ACCESS_DENIED).
 */
export function tmuxUnavailableReason(exec: TmuxExec = realTmux): "none" | "not-installed" | "not-permitted" {
  const res = exec(["-V"]);
  if (res.ok) return "none";
  return /EACCES|EPERM|ERR_ACCESS_DENIED|Access to this API has been restricted/.test(res.stderr) ? "not-permitted" : "not-installed";
}

/**
 * The socket of the tmux server this process talks to, or null when tmux can't run.
 *
 * Plain `tmux` (no `-L`/`-S`) means "the user's default server" — which is why
 * `tmux attach -t mpt` finds the team — but *which* socket that is depends on the
 * environment: `$TMUX` (inside tmux) names it, else `$TMUX_TMPDIR` (or /tmp) holds
 * `tmux-<uid>/default`. A daemon started by launchd/systemd can resolve a different
 * one than the user's shell, and then its windows open on a server nobody attaches
 * to. Reported by /health so `mpt doctor` can compare it with its own
 * (docs/DESIGN.md "The Daemon Is the Supervisor").
 *
 * Asks tmux first (`#{socket_path}`, exact when a server runs; with none running, its
 * "no server running on <path>" error names the path), then resolves it the way tmux
 * does. Never starts a server.
 */
export function tmuxSocketPath(exec: TmuxExec = realTmux, env: NodeJS.ProcessEnv = process.env): string | null {
  const res = exec(["display-message", "-p", "#{socket_path}"]);
  const asked = res.stdout.trim();
  if (res.ok && asked) return asked;
  const named = /(?:no server running on|error connecting to) (\S+)/.exec(res.stderr);
  if (named) return named[1]!;
  if (!tmuxAvailable(exec)) return null;
  return defaultTmuxSocketPath(env);
}

/** tmux's own default-socket resolution: `$TMUX`'s socket, else `<TMUX_TMPDIR or /tmp>/tmux-<uid>/default`. */
export function defaultTmuxSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const inside = env["TMUX"]?.split(",")[0];
  if (inside) return inside;
  // tmux resolves the directory (on macOS /tmp is /private/tmp), and falls back to
  // /tmp when TMUX_TMPDIR doesn't exist.
  let real = "/tmp";
  for (const dir of [env["TMUX_TMPDIR"], "/tmp"]) {
    if (!dir) continue;
    try { real = fs.realpathSync(dir); break; } catch { /* try the next */ }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return path.join(real, `tmux-${uid}`, "default");
}

/**
 * Quote a string for a POSIX shell.
 *
 * Needed only for text typed *into* a shell via `send-keys`. Single quotes protect
 * everything except a single quote, which is closed, escaped, and reopened — the
 * standard `'\''` dance.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Reject a tmux session or window name that tmux itself would misread.
 *
 * tmux targets are `session:window`, so a name containing `:` or `.` changes which
 * pane is addressed. Rather than silently rewriting the name — the old behaviour,
 * which produced a window nobody could find again — this refuses it.
 */
export function assertSafeName(kind: "session" | "window", name: string): void {
  if (name.length === 0) throw new Error(`tmux ${kind} name must not be empty`);
  if (/[:.\s]/.test(name)) {
    throw new Error(
      `tmux ${kind} name ${JSON.stringify(name)} must not contain ':', '.', or whitespace — ` +
        "tmux reads those as target separators",
    );
  }
}

export function hasSession(session: string, exec: TmuxExec = realTmux): boolean {
  assertSafeName("session", session);
  return exec(["has-session", "-t", session]).ok;
}

/**
 * `-e KEY=VALUE` pairs for `new-window` / `new-session`, in key order.
 *
 * Each pair is its own argv element, so a value with spaces, quotes or `$` reaches
 * the window exactly as written — nothing here is a shell string (the header's
 * point 1). This is how the agent env file (shared/env-file.ts) gets into a window:
 * the tmux server's own environment may be weeks stale, and `-e` overrides it for
 * this one window. Needs tmux ≥ 3.0 (`new-window -e`) / 3.2 (`new-session -e`).
 */
export function envArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).sort().flatMap((k) => ["-e", `${k}=${env[k]}`]);
}

/**
 * Ensure a session exists. Returns true when it was just created.
 *
 * `env` is given to the session's first window (`new-session -e`), which
 * `spawnWindow` reuses — so a freshly created session's first window gets the
 * same variables a `new-window -e` would have given it.
 */
export function ensureSession(session: string, exec: TmuxExec = realTmux, env?: Record<string, string>): boolean {
  if (hasSession(session, exec)) return false;
  const res = exec(["new-session", "-d", "-s", session, ...envArgs(env)]);
  if (!res.ok) throw new Error(`could not create tmux session ${session}: ${res.stderr.trim()}`);
  return true;
}

/** Window names in a session, or an empty list when the session doesn't exist. */
export function listWindows(session: string, exec: TmuxExec = realTmux): string[] {
  assertSafeName("session", session);
  const res = exec(["list-windows", "-t", session, "-F", "#{window_name}"]);
  if (!res.ok) return [];
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function windowExists(session: string, window: string, exec: TmuxExec = realTmux): boolean {
  return listWindows(session, exec).includes(window);
}

/**
 * Create a window and run `command` in it, `cd`-ed into `cwd`.
 *
 * Idempotent by window name: `new-window -n <name>` would happily create a second
 * window with the same name, and then two agents would answer to one label. A
 * freshly created session starts with one window, which is renamed rather than
 * left as a stray.
 *
 * `env` (the agent env file's variables, shared/env-file.ts) is passed with `-e`
 * to whichever tmux command creates the window — `new-window`, or `new-session`
 * for a fresh session's reused first window — never typed into its shell.
 */
export function spawnWindow(
  opts: { session: string; window: string; cwd: string; command: string; env?: Record<string, string> },
  exec: TmuxExec = realTmux,
): { created: boolean } {
  assertSafeName("session", opts.session);
  assertSafeName("window", opts.window);

  const justCreated = ensureSession(opts.session, exec, opts.env);
  const env = envArgs(opts.env);

  if (!justCreated && windowExists(opts.session, opts.window, exec)) return { created: false };

  if (justCreated) {
    // Reuse the session's initial window instead of leaving it empty beside ours.
    const renamed = exec(["rename-window", "-t", opts.session, opts.window]);
    if (!renamed.ok) {
      const made = exec(["new-window", "-n", opts.window, "-t", opts.session, ...env]);
      if (!made.ok) throw new Error(`could not create tmux window ${opts.window}: ${made.stderr.trim()}`);
    }
  } else {
    const made = exec(["new-window", "-n", opts.window, "-t", opts.session, ...env]);
    if (!made.ok) throw new Error(`could not create tmux window ${opts.window}: ${made.stderr.trim()}`);
  }

  // The one place a shell is involved: this is typed into the window's shell.
  sendKeys(opts.session, opts.window, `cd ${shellQuote(opts.cwd)} && ${opts.command}`, exec);
  return { created: true };
}

/** Type a line into a window, as if at the keyboard, and press Enter. */
export function sendKeys(session: string, window: string, line: string, exec: TmuxExec = realTmux): void {
  assertSafeName("session", session);
  assertSafeName("window", window);
  const res = exec(["send-keys", "-t", `${session}:${window}`, line, "Enter"]);
  if (!res.ok) throw new Error(`could not send keys to ${session}:${window}: ${res.stderr.trim()}`);
}

/** Send a literal control key (e.g. `C-c`), which must not be typed as text. */
export function sendControl(session: string, window: string, key: string, exec: TmuxExec = realTmux): void {
  assertSafeName("session", session);
  assertSafeName("window", window);
  exec(["send-keys", "-t", `${session}:${window}`, key]);
}

export function killWindow(session: string, window: string, exec: TmuxExec = realTmux): boolean {
  assertSafeName("session", session);
  assertSafeName("window", window);
  return exec(["kill-window", "-t", `${session}:${window}`]).ok;
}

export function selectWindow(session: string, window: string, exec: TmuxExec = realTmux): boolean {
  assertSafeName("session", session);
  assertSafeName("window", window);
  return exec(["select-window", "-t", `${session}:${window}`]).ok;
}

/**
 * Move the calling tmux client to `session:window`.
 *
 * `select-window` only changes which window is current *in that session*; a user
 * whose client is showing another session (say `mpt-services`) sees nothing happen.
 * `switch-client` moves the client itself. With no `-c`, tmux picks the client from
 * the caller's `$TMUX` — the terminal the command was typed in — so this is for
 * commands run from inside tmux (`mpt lead`), not for the daemon, which has no
 * client of its own.
 */
export function switchClient(session: string, window: string, exec: TmuxExec = realTmux): ExecResult {
  assertSafeName("session", session);
  assertSafeName("window", window);
  return exec(["switch-client", "-t", `${session}:${window}`]);
}

/**
 * Show `session:window` in the calling client: select it, then switch the client to it.
 *
 * Both, in that order. `select-window` makes it the session's current window
 * (which is what a later plain `tmux attach -t <session>` lands on); `switch-client`
 * moves the client, which matters when it is in another session. Returns the
 * switch's error text when it failed (e.g. tmux found no client to move), null on
 * success.
 */
export function focusClient(session: string, window: string, exec: TmuxExec = realTmux): string | null {
  selectWindow(session, window, exec);
  const switched = switchClient(session, window, exec);
  return switched.ok ? null : (switched.stderr.trim() || "switch-client failed");
}

// ─── Harness command templates ───────────────────────────────────────

/** Placeholders a harness spawn template may use. */
export interface TemplateVars {
  /** `{mpt}`: how to run this mpt (daemon/self.ts), for `mpt agent` teammates. Left unfilled if absent. */
  mpt?: string[];
  name: string;
  url: string;
  cwd: string;
  session: string;
  window: string;
}

/**
 * Fill a harness spawn template.
 *
 * Templates live in team config (`TeamConfig.harnesses`) rather than in extension
 * code, which is what makes adding a harness a config change instead of a release
 * (DESIGN.md "The Daemon Is the Supervisor"). Substitution is literal: the result is typed into a shell by `send-keys`,
 * and values that need quoting are quoted by the caller.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const filled = vars.mpt ? template.replaceAll("{mpt}", vars.mpt.map(shellQuote).join(" ")) : template;
  return filled
    .replaceAll("{name}", vars.name)
    .replaceAll("{url}", vars.url)
    .replaceAll("{cwd}", shellQuote(vars.cwd))
    .replaceAll("{session}", vars.session)
    .replaceAll("{window}", vars.window);
}

/** Unfilled placeholders, so a typo in config is reported instead of run. */
export function unresolvedPlaceholders(rendered: string): string[] {
  return [...rendered.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[0]);
}

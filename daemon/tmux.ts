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
 *   1. **No shell.** Every tmux call goes through `Deno.Command` with an argv array,
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
  try {
    const out = new Deno.Command("tmux", { args, stdout: "piped", stderr: "piped" }).outputSync();
    return {
      ok: out.success,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    // tmux missing entirely, or not executable.
    return { ok: false, stdout: "", stderr: (e as Error).message };
  }
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
 * commit: the integration tests gated on `tmuxAvailable()` and silently skipped under
 * a test task without `--allow-run` — reporting green while testing nothing.
 */
export function tmuxUnavailableReason(exec: TmuxExec = realTmux): "none" | "not-installed" | "not-permitted" {
  const res = exec(["-V"]);
  if (res.ok) return "none";
  return /PermissionDenied|Requires run access|--allow-run/i.test(res.stderr) ? "not-permitted" : "not-installed";
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

/** Ensure a session exists. Returns true when it was just created. */
export function ensureSession(session: string, exec: TmuxExec = realTmux): boolean {
  if (hasSession(session, exec)) return false;
  const res = exec(["new-session", "-d", "-s", session]);
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
 */
export function spawnWindow(
  opts: { session: string; window: string; cwd: string; command: string },
  exec: TmuxExec = realTmux,
): { created: boolean } {
  assertSafeName("session", opts.session);
  assertSafeName("window", opts.window);

  const justCreated = ensureSession(opts.session, exec);

  if (!justCreated && windowExists(opts.session, opts.window, exec)) return { created: false };

  if (justCreated) {
    // Reuse the session's initial window instead of leaving it empty beside ours.
    const renamed = exec(["rename-window", "-t", opts.session, opts.window]);
    if (!renamed.ok) {
      const made = exec(["new-window", "-n", opts.window, "-t", opts.session]);
      if (!made.ok) throw new Error(`could not create tmux window ${opts.window}: ${made.stderr.trim()}`);
    }
  } else {
    const made = exec(["new-window", "-n", opts.window, "-t", opts.session]);
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

// ─── Harness command templates ───────────────────────────────────────

/** Placeholders a harness spawn template may use. */
export interface TemplateVars {
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
  return template
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

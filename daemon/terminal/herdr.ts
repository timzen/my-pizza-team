/**
 * daemon/terminal/herdr.ts — herdr (https://herdr.dev) as a `TerminalBackend`
 * (daemon/terminal/backend.ts): the alternative to tmux a team picks with
 * `"terminal": "herdr"`.
 *
 * Everything here follows the contract the herdr spike verified against herdr
 * 0.9.5 (docs/herdr.md, tests/e2e/herdr-contract.test.ts, tests/fixtures/herdr/):
 *
 *   - **One server, named by `--session`.** Every call is `herdr --session <s> …`
 *     (`TeamConfig.herdrSession`, default `default` — the server plain `herdr`
 *     attaches to). `--session` beats an inherited `HERDR_SOCKET_PATH`, which herdr
 *     puts in every pane, so a daemon started from inside a herdr pane still reaches
 *     the configured server. The server is started on demand (`herdr server`,
 *     detached, since it doesn't daemonize) and never stopped: agents outlive a
 *     daemon restart, as with tmux.
 *   - **(session, window) → (workspace label, tab label).** The team container is a
 *     workspace labelled with `tmuxSession`; each agent is a tab labelled with its
 *     window name, whose root pane runs the command. herdr's IDs (`w1`, `w1:t2`,
 *     `w1:p2`) are server-assigned and can change, so every operation resolves the
 *     labels again (`workspace list`, `tab list`, `pane list`) and IDs are taken from
 *     responses, never predicted. A `WindowRef.id` is the pane ID, as a hint only.
 *   - **Argv only, JSON out.** Like `TmuxExec`, `HerdrExec` is `spawnSync` with an
 *     argv array — never a shell. herdr answers with JSON on stdout, or exit 1 and
 *     `{"error":{"code","message"}}` on stderr; both are parsed into typed results
 *     here, and a response missing a field mpt reads is a clear error, not an
 *     `undefined` further down.
 *   - **Env at creation.** A pane's environment is the server's plus `--env`, so the
 *     agent env file's variables go in `--env` on `workspace create`/`tab create`,
 *     never typed into the shell (docs/DESIGN.md "The Agent Environment Is a File").
 *   - **A label is not a live agent.** A server restart restores tabs but not their
 *     processes, so an existing tab whose pane runs only its shell gets the command
 *     run into it rather than counted as running (docs/herdr.md "Restart").
 *   - **mpt's restore, not herdr's.** Every command runs with `HERDR_ENV=0`
 *     (`herdrLaunchLine`), so herdr's agent integrations never report an mpt pane's
 *     session and herdr's native restore never relaunches it without mpt's flags.
 *
 * Version gate: herdr ≥ `MIN_HERDR_VERSION`, read from `herdr status --json` (works
 * with no server), and a running server must report itself compatible with the CLI.
 */

import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ControlKey,
  OpenedWindow,
  OpenWindowOptions,
  TerminalBackend,
  TerminalStatus,
  TerminalUnavailableReason,
  WindowActivity,
  WindowRef,
} from "./backend.ts";
import { shellQuote } from "./template.ts";
import type { ExecResult } from "./tmux.ts";

/** The oldest herdr this backend supports: the version its contract was verified on (docs/herdr.md). */
export const MIN_HERDR_VERSION = "0.9.5";

/** The herdr session used when the team names none: herdr's own default, which plain `herdr` attaches to. */
export const DEFAULT_HERDR_SESSION = "default";

/** How long `ensureServer` waits for a freshly started server to answer. */
export const HERDR_SERVER_TIMEOUT_MS = 10_000;

/** Runs `herdr <args>` (args include `--session`). Injectable so the logic is testable without herdr. */
export type HerdrExec = (args: string[]) => ExecResult;

/** Starts a long-running `herdr <args>` (the server) in the background, not waiting for it. */
export type HerdrLaunch = (args: string[]) => void;

/**
 * The environment herdr runs with: this process's, minus the variables that would
 * point it at some other server (`HERDR_SOCKET_PATH`, `HERDR_SESSION`, and the
 * pane markers a daemon started inside a herdr pane inherits). `--session` already
 * wins over them; stripping them keeps a launched server's panes from inheriting
 * another server's identity. `HERDR_CONFIG_PATH` is kept: it is the user's choice
 * of config.toml.
 */
export function herdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith("HERDR_") && k !== "HERDR_CONFIG_PATH") continue;
    out[k] = v;
  }
  return out;
}

/** The real thing: `herdr` with an argv array, never a shell. */
export const realHerdr: HerdrExec = (args) => {
  const out = spawnSync("herdr", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Infinity,
    env: herdrEnv(),
    // A wedged server must not hang the daemon's spawn pass forever.
    timeout: 20_000,
  });
  // herdr missing entirely, not executable, or timed out.
  if (out.error) return { ok: false, stdout: "", stderr: out.error.message };
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
};

/**
 * Start `herdr <args>` detached: `herdr server` stays in the foreground
 * (`detached_server_daemon` is false in 0.9.5) and must outlive the daemon, so it
 * gets its own process group, no stdio, and is not waited for.
 */
export const realHerdrLaunch: HerdrLaunch = (args) => {
  const child = spawn("herdr", args, { detached: true, stdio: "ignore", env: herdrEnv() });
  child.on("error", () => { /* reported by ensureServer's timeout */ });
  child.unref();
};

/** Block this thread for `ms` (the backend interface is synchronous; only server start-up waits). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A herdr call that failed: herdr's own error code (`tab_not_found`, `server_not_running`, …) and message. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** Compare dotted numeric versions (`0.9.5`, `0.10.0-rc1`): negative, zero or positive like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** herdr's session-name rule (docs/herdr.md): letters, digits, `.`, `_`, `-`. */
export function isValidHerdrSession(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * The socket herdr uses for `session`, resolved the way herdr does: from
 * `$XDG_CONFIG_HOME` (else `$HOME/.config`) — *not* `HERDR_CONFIG_PATH`, which only
 * moves config.toml — then `herdr/herdr.sock` for the default session or
 * `herdr/sessions/<name>/herdr.sock` for a named one. The fallback for `identity()`
 * when `status --json` can't answer.
 */
export function defaultHerdrSocketPath(session: string, env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(env["HOME"] || os.homedir(), ".config");
  const dir = path.join(configHome, "herdr");
  return session === DEFAULT_HERDR_SESSION
    ? path.join(dir, "herdr.sock")
    : path.join(dir, "sessions", session, "herdr.sock");
}

// ─── JSON responses ──────────────────────────────────────────────────

type Json = Record<string, unknown>;

function parseObject(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
  } catch {
    return null;
  }
}

/** Walk `path` (dot-separated) in `obj`; undefined when any step is missing. */
function at(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

/** `at`, required to be a non-empty string; otherwise a `bad_response` error naming the call and field. */
function str(obj: unknown, dotted: string, what: string): string {
  const v = at(obj, dotted);
  if (typeof v !== "string" || !v) throw new HerdrError("bad_response", `herdr ${what}: the response has no ${dotted}`);
  return v;
}

/** `at`, required to be an array of objects. */
function list(obj: unknown, dotted: string, what: string): Json[] {
  const v = at(obj, dotted);
  if (!Array.isArray(v)) throw new HerdrError("bad_response", `herdr ${what}: the response has no ${dotted} list`);
  return v.filter((x): x is Json => Boolean(x) && typeof x === "object");
}

/** A workspace, tab or pane as mpt reads it from herdr's responses. */
interface HerdrWorkspace { id: string; label: string }
interface HerdrTab { id: string; label: string; workspaceId: string }
interface HerdrPane { id: string; tabId: string }

function toWorkspace(w: Json, what: string): HerdrWorkspace {
  return { id: str(w, "workspace_id", what), label: typeof w["label"] === "string" ? w["label"] : "" };
}
function toTab(t: Json, what: string): HerdrTab {
  return { id: str(t, "tab_id", what), label: typeof t["label"] === "string" ? t["label"] : "", workspaceId: str(t, "workspace_id", what) };
}
function toPane(p: Json, what: string): HerdrPane {
  return { id: str(p, "pane_id", what), tabId: str(p, "tab_id", what) };
}

/** What `herdr status --json` says about the CLI and the session's server. */
export interface HerdrStatus {
  /** The CLI's version (`client.version`). */
  version: string;
  /** Is the session's server running? */
  running: boolean;
  /** The running server's version, when it runs. */
  serverVersion: string | null;
  /** False when a running server says it can't talk to this CLI. Null when unknown / not running. */
  compatible: boolean | null;
  /** The session's socket (reported whether or not the server runs). */
  socket: string | null;
}

/** Why herdr can't be used, as a backend reports it (`TerminalBackend.unavailable`). */
type HerdrProbe =
  | { ok: true; status: HerdrStatus | null }
  | { ok: false; kind: TerminalUnavailableReason; reason: string; fix: string };

// ─── The backend ─────────────────────────────────────────────────────

/** How to build a herdr backend: which server, and fakes for tests. */
export interface HerdrBackendOptions {
  /** The herdr session (server) to use (`TeamConfig.herdrSession`). Default: `default`. */
  session?: string;
  exec?: HerdrExec;
  launch?: HerdrLaunch;
  /** How long to wait for a started server (default `HERDR_SERVER_TIMEOUT_MS`). */
  serverTimeoutMs?: number;
  /** Sleep between server-readiness polls; injectable so tests don't wait. */
  sleep?: (ms: number) => void;
  /** The environment for `identity()`'s fallback and `insideClient()`. */
  env?: NodeJS.ProcessEnv;
}

/** A label herdr can take: non-empty, no control characters. */
function assertLabel(kind: "session" | "window", name: string): void {
  // eslint-disable-next-line no-control-regex
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`herdr ${kind} label ${JSON.stringify(name)} must be non-empty text without control characters`);
  }
}

/**
 * `--env KEY=VALUE` pairs for `workspace create` / `tab create`, in key order. Each
 * pair is its own argv element, so values reach the pane verbatim (verified with
 * spaces and quotes in docs/herdr.md "Environment").
 */
export function herdrEnvArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).sort().flatMap((k) => ["--env", `${k}=${env[k]}`]);
}

/**
 * The line an agent's pane runs: `command`, after opting the pane out of herdr's
 * native agent-session restore (docs/herdr.md "Restart"). herdr's official agent
 * integrations (Pi's `herdr-agent-state.ts`, Claude's hook, …) report a pane's
 * session only when `HERDR_ENV` is `1`, and on a server restart herdr types
 * `pi --session <file>` into every pane that reported one — dropping mpt's flags,
 * so the Pi comes back as a ghost (a bare Pi in the team directory is the leader).
 * herdr has no per-pane opt-out, and keeps its own `HERDR_*` authoritative over
 * `--env`, so the override goes on the command line: the agent then runs with
 * `HERDR_ENV=0` and no integration reports for it, while mpt's own restore
 * (`openWindow` re-running the command into an idle restored tab) stays in charge.
 * `export …;` works in sh, bash, zsh and fish, and a shell without `export` still
 * runs the command after the `;`. `cwd`, when given, is `cd`ed into first — a
 * restored pane's cwd is herdr's best guess.
 */
export function herdrLaunchLine(command: string, cwd?: string): string {
  return `export HERDR_ENV=0; ${cwd ? `cd ${shellQuote(cwd)} && ` : ""}${command}`;
}

/**
 * herdr as a `TerminalBackend`. Every method is a handful of `herdr --session <s> …`
 * calls; see the header for the mapping.
 */
export function createHerdrBackend(opts: HerdrBackendOptions = {}): TerminalBackend {
  const session = opts.session || DEFAULT_HERDR_SESSION;
  const exec = opts.exec ?? realHerdr;
  const launch = opts.launch ?? realHerdrLaunch;
  const sleep = opts.sleep ?? sleepSync;
  const serverTimeoutMs = opts.serverTimeoutMs ?? HERDR_SERVER_TIMEOUT_MS;
  const env = opts.env ?? process.env;
  const sessionArgs = ["--session", session];

  /** Run one herdr call and parse its JSON answer. Empty stdout (e.g. `pane run`) is `{}`. Throws `HerdrError`. */
  const call = (args: string[]): Json => {
    const what = args.slice(0, 2).join(" ");
    const res = exec([...sessionArgs, ...args]);
    if (!res.ok) {
      const err = parseObject(res.stderr);
      const code = typeof at(err, "error.code") === "string" ? at(err, "error.code") as string : "failed";
      const message = typeof at(err, "error.message") === "string"
        ? at(err, "error.message") as string
        : (res.stderr.trim() || "no output");
      throw new HerdrError(code, `herdr ${what} failed: ${message}`);
    }
    if (!res.stdout.trim()) return {};
    const parsed = parseObject(res.stdout);
    if (!parsed) throw new HerdrError("bad_response", `herdr ${what} printed something that isn't JSON: ${res.stdout.trim().slice(0, 200)}`);
    return parsed;
  };

  /** `herdr status --json`, or null when this build can't answer it. */
  const status = (): HerdrStatus | null => {
    const res = exec([...sessionArgs, "status", "--json"]);
    const json = res.ok ? parseObject(res.stdout) : null;
    const version = at(json, "client.version");
    if (!json || typeof version !== "string") return null;
    const running = at(json, "server.running") === true;
    const serverVersion = at(json, "server.version");
    const compatible = at(json, "server.compatible");
    const socket = at(json, "server.socket");
    return {
      version,
      running,
      serverVersion: typeof serverVersion === "string" ? serverVersion : null,
      compatible: typeof compatible === "boolean" ? compatible : null,
      socket: typeof socket === "string" ? socket : null,
    };
  };

  /** Can herdr be used: installed, runnable, new enough, a compatible server (when one runs), a valid session? */
  const probe = (): HerdrProbe => {
    if (!isValidHerdrSession(session)) {
      return {
        ok: false, kind: "misconfigured",
        reason: `the team's herdr session ${JSON.stringify(session)} is not a valid herdr session name (letters, digits, ".", "_", "-")`,
        fix: 'fix "herdrSession" in the team\'s config.json, or remove it to use herdr\'s default session',
      };
    }
    const v = exec(["--version"]);
    if (!v.ok) {
      if (/EACCES|EPERM|ERR_ACCESS_DENIED|Access to this API has been restricted/.test(v.stderr)) {
        return {
          ok: false, kind: "not-permitted",
          reason: "this process is not permitted to run herdr",
          fix: "make herdr executable by this user, or (if Node runs with --permission) add --allow-child-process",
        };
      }
      return {
        ok: false, kind: "not-installed",
        reason: "herdr is not on this process's PATH",
        fix: `install herdr ≥ ${MIN_HERDR_VERSION} (https://herdr.dev), or restart the daemon from a shell that has it on PATH (\`mpt stop && mpt start\`; for the login service, \`mpt install\` again from that shell) — or set Terminal back to tmux in Config → General`,
      };
    }
    const st = status();
    // A build whose `status --json` fails: fall back to `herdr X.Y.Z` from --version.
    const installed = st?.version ?? /herdr (\d+\.\d+\.\d+\S*)/.exec(v.stdout)?.[1] ?? null;
    if (!installed || compareVersions(installed, MIN_HERDR_VERSION) < 0) {
      return {
        ok: false, kind: "unsupported-version",
        reason: `herdr ${installed ?? `(unrecognised version: ${v.stdout.trim().slice(0, 60)})`} is older than ${MIN_HERDR_VERSION}, the oldest mpt supports`,
        fix: `upgrade herdr to ${MIN_HERDR_VERSION} or later (\`herdr update\`), then restart its server — or set Terminal back to tmux in Config → General`,
      };
    }
    if (st?.running && st.compatible === false) {
      return {
        ok: false, kind: "unsupported-version",
        reason: `the running herdr server for session "${session}" (${st.serverVersion ?? "unknown version"}) is not compatible with the herdr CLI (${installed})`,
        fix: `restart it — \`herdr --session ${session} server stop\` (this ends the agents running in it); mpt starts a new one on the next spawn`,
      };
    }
    return { ok: true, status: st };
  };

  /** Is the session's server answering? */
  const serverRunning = (): boolean => {
    // `status server --json` exits 0 either way and never starts a server.
    const res = exec([...sessionArgs, "status", "server", "--json"]);
    return at(parseObject(res.stdout), "running") === true;
  };

  /**
   * Make sure the session's server runs: start `herdr server` detached when it
   * doesn't, and wait (up to `serverTimeoutMs`) until it answers. Throws when it
   * doesn't come up. Called only by operations that create windows — a read never
   * starts a server.
   */
  const ensureServer = (): void => {
    if (serverRunning()) return;
    launch([...sessionArgs, "server"]);
    const deadline = Date.now() + serverTimeoutMs;
    while (Date.now() < deadline) {
      sleep(100);
      if (serverRunning()) return;
    }
    throw new Error(`the herdr server for session "${session}" did not start within ${Math.round(serverTimeoutMs / 1000)}s (try \`herdr --session ${session} server\` by hand to see why)`);
  };

  /** The team's workspace (the first with that label — labels aren't unique), or null. No server = none. */
  const findWorkspace = (label: string): HerdrWorkspace | null => {
    let res: Json;
    try {
      res = call(["workspace", "list"]);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "server_not_running") return null;
      throw e;
    }
    const found = list(res, "result.workspaces", "workspace list").map((w) => toWorkspace(w, "workspace list"));
    return found.find((w) => w.label === label) ?? null;
  };

  const tabsOf = (ws: HerdrWorkspace): HerdrTab[] =>
    list(call(["tab", "list", "--workspace", ws.id]), "result.tabs", "tab list").map((t) => toTab(t, "tab list"));

  /** The tab's root pane: its first in `pane list`. */
  const paneOf = (tab: HerdrTab): HerdrPane => {
    const panes = list(call(["pane", "list", "--workspace", tab.workspaceId]), "result.panes", "pane list")
      .map((p) => toPane(p, "pane list"));
    const pane = panes.find((p) => p.tabId === tab.id);
    if (!pane) throw new HerdrError("pane_not_found", `herdr tab ${tab.id} has no pane`);
    return pane;
  };

  /** The tab labelled `window` in the workspace labelled `sessionLabel`, or null. */
  const findTab = (sessionLabel: string, window: string): HerdrTab | null => {
    const ws = findWorkspace(sessionLabel);
    if (!ws) return null;
    return tabsOf(ws).find((t) => t.label === window) ?? null;
  };

  /**
   * Does the pane run only its shell (no agent)? True after a server restart, which
   * restores tabs but not processes (docs/herdr.md "Restart"). Unknown = false, so
   * a live agent is never typed over.
   */
  const paneIdle = (pane: HerdrPane): boolean => {
    try {
      const info = call(["pane", "process-info", "--pane", pane.id]);
      const fg = at(info, "result.process_info.foreground_process_group_id");
      const shell = at(info, "result.process_info.shell_pid");
      return typeof fg === "number" && typeof shell === "number" && fg === shell;
    } catch {
      return false;
    }
  };

  /**
   * What runs in the pane's foreground (`TerminalBackend.windowActivity`), from the
   * same `pane process-info` `paneIdle` reads: running when the foreground process
   * group isn't the shell's, and the first foreground process's name. Unknown when
   * herdr can't say.
   */
  const paneActivity = (pane: HerdrPane): WindowActivity => {
    const info = call(["pane", "process-info", "--pane", pane.id]);
    const fg = at(info, "result.process_info.foreground_process_group_id");
    const shell = at(info, "result.process_info.shell_pid");
    const procs = at(info, "result.process_info.foreground_processes");
    const first = Array.isArray(procs) ? (procs[0] as unknown) : undefined;
    const name = at(first, "name");
    const running = typeof fg === "number" && typeof shell === "number" ? fg !== shell : null;
    return { running, command: typeof name === "string" && name ? name : null };
  };

  /**
   * Type `line` into the pane and press Enter (`pane run`: text + Enter at once).
   * herdr joins `pane run`'s arguments and would read a leading `-` as a flag, so
   * such a line gets a leading space — harmless to a shell.
   */
  const run = (pane: HerdrPane | string, line: string): void => {
    const id = typeof pane === "string" ? pane : pane.id;
    call(["pane", "run", id, line.startsWith("-") ? ` ${line}` : line]);
  };

  const ref = (sessionLabel: string, window: string, id?: string): WindowRef =>
    id ? { session: sessionLabel, window, id } : { session: sessionLabel, window };

  const locate = (w: WindowRef): { tab: HerdrTab; pane: HerdrPane } => {
    const tab = findTab(w.session, w.window);
    if (!tab) throw new HerdrError("tab_not_found", `no herdr window ${w.session}:${w.window}`);
    return { tab, pane: paneOf(tab) };
  };

  /** Create the team's workspace (its first tab is labelled "1" by herdr). Returns herdr's answer. */
  const createWorkspace = (label: string, cwd: string | undefined, vars?: Record<string, string>): Json =>
    call(["workspace", "create", "--label", label, ...(cwd ? ["--cwd", cwd] : []), ...herdrEnvArgs(vars), "--no-focus"]);

  const openWindow = (o: OpenWindowOptions): OpenedWindow => {
    assertLabel("session", o.session);
    assertLabel("window", o.window);
    ensureServer();
    const ws = findWorkspace(o.session);

    if (!ws) {
      // A fresh container: reuse its first tab (as tmux's first window is renamed)
      // rather than leave a stray "1" beside the agent.
      const made = createWorkspace(o.session, o.cwd, o.env);
      const tabId = str(made, "result.tab.tab_id", "workspace create");
      const paneId = str(made, "result.root_pane.pane_id", "workspace create");
      call(["tab", "rename", tabId, o.window]);
      run(paneId, herdrLaunchLine(o.command));
      return { created: true, ref: ref(o.session, o.window, paneId) };
    }

    // Idempotent by label: herdr allows duplicate labels, so look before creating.
    const existing = tabsOf(ws).find((t) => t.label === o.window);
    if (existing) {
      const pane = paneOf(existing);
      if (!paneIdle(pane)) return { created: false, ref: ref(o.session, o.window, pane.id) };
      // Restored after a server restart: the tab is there, its agent isn't. The
      // pane's cwd was restored with it (the cd makes it certain); its `--env`
      // variables were not (docs/herdr.md "Restart").
      run(pane, herdrLaunchLine(o.command, o.cwd));
      return { created: true, ref: ref(o.session, o.window, pane.id) };
    }

    const made = call(["tab", "create", "--workspace", ws.id, "--label", o.window, "--cwd", o.cwd, ...herdrEnvArgs(o.env), "--no-focus"]);
    const paneId = str(made, "result.root_pane.pane_id", "tab create");
    // No command argument on `tab create`; `pane run` straight after works (verified).
    run(paneId, herdrLaunchLine(o.command));
    return { created: true, ref: ref(o.session, o.window, paneId) };
  };

  /** Run `fn`, mapping any failure to false (for the best-effort, boolean-returning methods). */
  const attempt = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };

  const focusWindow = (w: WindowRef): boolean => attempt(() => { call(["tab", "focus", locate(w).tab.id]); });

  const identity = (): string | null => {
    const p = probe();
    if (!p.ok) return null;
    return p.status?.socket ?? defaultHerdrSocketPath(session, env);
  };

  /** The probe, the version, the server and its socket at once (doctor, `/health`). Never starts a server. */
  const describe = (): TerminalStatus => {
    const base = { kind: "herdr" as const, displayName: "herdr", session };
    const p = probe();
    if (!p.ok) {
      // Too old or incompatible still has a version worth reporting.
      const st = p.kind === "unsupported-version" ? status() : null;
      return {
        ...base, available: false, reason: p.reason, fix: p.fix,
        version: st?.version ?? null, serverRunning: st ? st.running : null, identity: null,
      };
    }
    return {
      ...base,
      available: true,
      version: p.status?.version ?? null,
      serverRunning: p.status ? p.status.running : serverRunning(),
      identity: p.status?.socket ?? defaultHerdrSocketPath(session, env),
    };
  };

  /** The plain-terminal command that attaches to this server: plain `herdr` is the default session. */
  const attachCommand = (): string =>
    session === DEFAULT_HERDR_SESSION ? "herdr" : `herdr session attach ${session}`;

  return {
    kind: "herdr",
    displayName: "herdr",
    available: () => probe().ok,
    unavailableReason: () => {
      const p = probe();
      return p.ok ? "none" : p.kind;
    },
    unavailable: () => {
      const p = probe();
      return p.ok ? null : { reason: p.reason, fix: p.fix };
    },
    identity,
    describe,
    ensureContainer: (sessionLabel, vars) => {
      assertLabel("session", sessionLabel);
      ensureServer();
      if (findWorkspace(sessionLabel)) return false;
      createWorkspace(sessionLabel, undefined, vars);
      return true;
    },
    listWindows: (sessionLabel) => {
      const ws = findWorkspace(sessionLabel);
      return ws ? tabsOf(ws).map((t) => t.label) : [];
    },
    findWindow: (sessionLabel, window) => {
      const tab = findTab(sessionLabel, window);
      return tab ? ref(sessionLabel, window, paneOf(tab).id) : null;
    },
    windowRef: (sessionLabel, window) => ref(sessionLabel, window),
    openWindow,
    sendLine: (w, line) => run(locate(w).pane, line),
    // herdr's key name; it accepts tmux's `C-c` too, but say what we mean.
    sendControl: (w, key: ControlKey) => { attempt(() => { call(["pane", "send-keys", locate(w).pane.id, key === "C-c" ? "ctrl+c" : key]); }); },
    closeWindow: (w) => attempt(() => { call(["tab", "close", locate(w).tab.id]); }),
    windowActivity: (w) => {
      try {
        return paneActivity(locate(w).pane);
      } catch {
        return { running: null, command: null };
      }
    },
    focusWindow,
    // Inside one of *this* server's panes: herdr marks them, and names the socket.
    insideClient: (e = env) => e["HERDR_ENV"] === "1" && Boolean(e["HERDR_SOCKET_PATH"]) && e["HERDR_SOCKET_PATH"] === identity(),
    // `tab focus` is server-wide, so the calling client follows it; there is no
    // per-client switch to make (docs/herdr.md "What doesn't map cleanly").
    focusClient: (w) => (focusWindow(w) ? null : `no herdr window ${w.session}:${w.window}`),
    // Focus the tab, then hand our tty to the herdr client (it needs a real terminal).
    attach: (w) => {
      focusWindow(w);
      return spawnSync("herdr", sessionArgs, { stdio: "inherit", env: herdrEnv() }).status === 0;
    },
    attachCommand: () => attachCommand(),
    // No per-client switch command: inside herdr, the user picks the tab.
    switchHint: (w) => `switch to the "${w.window}" tab in herdr's "${w.session}" workspace`,
  };
}

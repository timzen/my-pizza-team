/**
 * tests/e2e/_herdr.ts — an isolated herdr server for end-to-end tests.
 *
 * herdr (https://herdr.dev) is the candidate alternative to tmux as the terminal the
 * daemon runs agents in (docs/herdr.md). Like `_sandbox.ts` does for tmux, this gives
 * each test a herdr world the user's real one cannot see:
 *
 *   - its own **config directory**: herdr derives every socket and session directory
 *     from `$XDG_CONFIG_HOME` (else `$HOME/.config`) — *not* from `HERDR_CONFIG_PATH`,
 *     which only moves `config.toml`. So all three point into a temp dir, along with
 *     `XDG_STATE_HOME` (agent-detection manifests);
 *   - its own **named session**, so even a mistake in the above would address
 *     `sessions/<random>/herdr.sock`, never the default `herdr.sock`;
 *   - a **config.toml** with `/bin/sh` as the pane shell (a host's zsh first-run
 *     wizard would swallow typed commands, as it did for tmux) and herdr's background
 *     version / manifest checks off, so a test makes no network calls;
 *   - an environment built here, with every inherited `HERDR_*` stripped, so a test
 *     run from inside a herdr pane can't inherit a handle to the real server.
 *
 * Teardown (`await using`) stops the server via its socket, then kills the process
 * if it is still there, then removes the directory — a failing assertion still leaves
 * no server behind.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The herdr this contract was verified against (docs/herdr.md "Version gating"). */
export const MIN_HERDR_VERSION = "0.9.5";

/** One herdr CLI invocation: exit code, raw streams, and stdout parsed as JSON when it is JSON. */
export interface HerdrResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout (or, for a failed call, stderr) parsed as JSON; null when neither is JSON. */
  json: Record<string, unknown> | null;
}

export interface HerdrSandbox extends AsyncDisposable {
  /** The temp directory everything lives under. */
  root: string;
  /** `$XDG_CONFIG_HOME/herdr` — where herdr puts sessions and sockets. */
  configDir: string;
  /** The named session this sandbox's server runs as. */
  session: string;
  /** The environment every call runs with (no inherited `HERDR_*`). */
  env: Record<string, string>;
  /** Run `herdr --session <session> <args>`. `extraEnv` is layered on `env`. */
  herdr(args: string[], extraEnv?: Record<string, string>): HerdrResult;
  /** Start `herdr server` for the session in the background and wait until it answers. */
  startServer(extraEnv?: Record<string, string>): Promise<void>;
  /** Stop the server (`server stop`) and wait for its process to exit. */
  stopServer(): Promise<void>;
  /** Poll until `check` is true or the timeout passes. Returns whether it became true. */
  waitFor(check: () => boolean, timeoutMs?: number): Promise<boolean>;
}

/** Is herdr installed and runnable? Tests needing it skip only when it isn't. */
export function hasHerdr(): boolean {
  try {
    return spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** `herdr --version` → "0.9.5", or null when herdr can't run or prints something else. */
export function herdrVersion(): string | null {
  const out = spawnSync("herdr", ["--version"], { encoding: "utf8" });
  if (out.error || out.status !== 0) return null;
  return /^herdr (\d+\.\d+\.\d+)/.exec(out.stdout.trim())?.[1] ?? null;
}

/** Compare dotted numeric versions: negative, zero or positive like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The process environment minus anything that could point herdr (or tmux) at the user's servers. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("HERDR_") || k === "TMUX" || k === "TMUX_PANE") continue;
    env[k] = v;
  }
  return env;
}

export async function herdrSandbox(): Promise<HerdrSandbox> {
  // Short on purpose: herdr's sockets live at <root>/c/herdr/sessions/<name>/herdr-client.sock,
  // and Unix socket paths are limited to ~104 bytes.
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mh-"));
  const home = path.join(root, "h");
  const configHome = path.join(root, "c");
  const configDir = path.join(configHome, "herdr");
  await fs.promises.mkdir(home, { recursive: true });
  await fs.promises.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.toml");
  await fs.promises.writeFile(
    configPath,
    [
      "[terminal]",
      'default_shell = "/bin/sh"',
      "[update]",
      "version_check = false",
      "manifest_check = false",
      "",
    ].join("\n"),
  );

  const session = `mpt-${crypto.randomUUID().slice(0, 8)}`;
  const env: Record<string, string> = {
    ...baseEnv(),
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(root, "s"),
    HERDR_CONFIG_PATH: configPath,
    SHELL: "/bin/sh",
    NO_COLOR: "1",
  };

  let server: ChildProcess | null = null;
  const alive = () => server !== null && server.exitCode === null && server.signalCode === null;

  const sb: HerdrSandbox = {
    root,
    configDir,
    session,
    env,

    herdr(args, extraEnv = {}) {
      // `--session` first, on every call: the belt to the XDG braces above.
      const out = spawnSync("herdr", ["--session", session, ...args], {
        env: { ...env, ...extraEnv },
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      });
      if (out.error) return { code: 127, stdout: "", stderr: out.error.message, json: null };
      const code = out.status ?? 1;
      return { code, stdout: out.stdout, stderr: out.stderr, json: parseJson(out.stdout) ?? parseJson(out.stderr) };
    },

    async startServer(extraEnv = {}) {
      // `herdr server` stays in the foreground (status reports
      // `detached_server_daemon: false`), so it is spawned detached — the way the daemon
      // would — and reaped by teardown.
      server = spawn("herdr", ["--session", session, "server"], {
        env: { ...env, ...extraEnv },
        cwd: root,
        stdio: "ignore",
        detached: true,
      });
      server.unref();
      const up = await sb.waitFor(() => {
        const st = sb.herdr(["status", "server", "--json"]);
        return st.json?.["running"] === true;
      }, 15_000);
      if (!up) throw new Error(`herdr server for session ${session} did not come up`);
    },

    async stopServer() {
      sb.herdr(["server", "stop"]);
      if (alive()) {
        const exited = new Promise((r) => server!.once("exit", r));
        const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
        if (!gone && alive()) {
          try { server!.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }
    },

    async waitFor(check, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return check();
    },

    async [Symbol.asyncDispose]() {
      // Each step is independent: one failing must not strand the others.
      try { await sb.stopServer(); } catch { /* none running */ }
      try { await fs.promises.rm(root, { recursive: true, force: true }); } catch { /* */ }
    },
  };
  return sb;
}

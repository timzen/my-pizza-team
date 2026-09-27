/**
 * tests/e2e/_sandbox.ts — an isolated world for end-to-end tests (P5-1).
 *
 * Phases 2 and 3 were verified by driving the real CLI by hand in throwaway
 * directories. This makes that repeatable. Each sandbox gets:
 *
 *   - its own **home** (`HOME`, `MPT_HOME`), so nothing reads or writes `~`;
 *   - its own **Pi config** (`PI_CODING_AGENT_DIR`), so the user's `settings.json` and
 *     `trust.json` are never touched;
 *   - its own **project and team directory**;
 *   - its own **tmux server**, via `TMUX_TMPDIR`.
 *
 * The last one is the non-obvious one. Earlier e2e runs used uniquely *named* sessions
 * on the user's real tmux server — so a stray `kill-server`, or a name collision,
 * would have taken out their actual sessions. A private socket directory gives a
 * separate server that the real one cannot see, and that can be killed outright.
 *
 * **Isolation is by construction, not by care.** The CLI only ever runs as a
 * subprocess with an environment built here, and `TMUX` is stripped so a test run
 * from inside tmux can't inherit a handle to the real server.
 *
 * Teardown is guaranteed via `await using`, so a failing assertion still leaves no
 * daemon, no tmux server, and no temp directory behind.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { TmuxExec } from "../../daemon/tmux.ts";
import { TESTED_PI_VERSION } from "../../cli/doctor.ts";

const REPO = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli", "main.ts");
/** The source entry point `deno task dev` / `start` run. */
const DAEMON_MAIN = path.join(REPO, "daemon", "main.ts");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for assertions that don't care which stream. */
  output: string;
}

export interface Sandbox extends AsyncDisposable {
  root: string;
  home: string;
  piAgentDir: string;
  projectDir: string;
  teamDir: string;
  tmuxDir: string;
  /** A tmux session name unique to this sandbox. */
  session: string;
  port: number;
  env: Record<string, string>;

  /** Run the real `mpt` CLI with this sandbox's environment. */
  mpt(...args: string[]): Promise<RunResult>;
  /** Run `tmux` against this sandbox's private server. */
  tmux(...args: string[]): Promise<RunResult>;
  /**
   * A `TmuxExec` bound to this sandbox's private server, for calling daemon/tmux.ts
   * directly. Without it, those calls would reach the user's real server.
   */
  tmuxExec: TmuxExec;
  /** Write Pi's settings.json. */
  writePiSettings(settings: Record<string, unknown>): void;
  readPiSettings(): Record<string, unknown>;
  /** Write the team's config.json (creating the team directory). */
  writeTeamConfig(config: Record<string, unknown>): void;
  /**
   * Start the daemon in the background and wait until it answers /health — via
   * `mpt start` (default), or via daemon/main.ts as `deno task dev` runs it.
   */
  startDaemon(entry?: "cli" | "source"): Promise<void>;
  /** Poll until `check` is true or the timeout passes. Returns whether it became true. */
  waitFor(check: () => boolean | Promise<boolean>, timeoutMs?: number): Promise<boolean>;
}

/**
 * Deno's real cache directory, asked of Deno rather than assumed.
 *
 * The sandbox replaces HOME, which would otherwise send the CLI subprocess to an empty
 * cache and re-download every dependency per test. This was first hardcoded to
 * `~/Library/Caches/deno` — the macOS location — which on a Linux CI runner would have
 * quietly meant a cold cache for every sandbox.
 */
function denoCacheDir(): string {
  const explicit = Deno.env.get("DENO_DIR");
  if (explicit) return explicit;
  try {
    const out = new Deno.Command(Deno.execPath(), { args: ["info", "--json"], stdout: "piped", stderr: "null" }).outputSync();
    const dir = JSON.parse(new TextDecoder().decode(out.stdout)).denoDir;
    if (typeof dir === "string" && dir) return dir;
  } catch { /* fall through */ }
  return path.join(Deno.env.get("HOME") ?? ".", ".cache", "deno");
}

const DENO_CACHE_DIR = denoCacheDir();

/** An unused TCP port, so parallel sandboxes don't collide. */
function freePort(): number {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

async function run(cmd: string, args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  const out = await new Deno.Command(cmd, {
    args,
    env,
    cwd,
    // A fresh environment rather than the parent's: nothing leaks in that the test
    // didn't choose. PATH is passed explicitly in `env` so tools still resolve.
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  return { code: out.code, stdout, stderr, output: stdout + stderr };
}

/** Is tmux installed? Tests needing it skip when it isn't — and only then. */
export function hasTmux(): boolean {
  try {
    return new Deno.Command("tmux", { args: ["-V"], stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
}

export interface SandboxOptions {
  /**
   * What `pi` looks like on PATH. Defaults to a stub reporting the tested version.
   *
   * Chosen by the test, never inherited from the host. The first CI run proved why:
   * "doctor passes after setup" passed on a laptop with Pi installed and failed on a
   * runner without it — a test of the machine, not of mpt. `false` makes Pi
   * deterministically absent (a stub that exits 127), so a host's real Pi can't mask it.
   */
  pi?: string | false;
}

export async function sandbox(label = "e2e", opts: SandboxOptions = {}): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: `mpt-${label}-` });
  const home = path.join(root, "home");
  const piAgentDir = path.join(home, ".pi", "agent");
  const projectDir = path.join(root, "project");
  const teamDir = path.join(projectDir, ".my-pizza-team");
  // Short on purpose: tmux sockets live under this path, and Unix socket paths are
  // limited to ~104 bytes. A long temp prefix can push them over.
  const tmuxDir = await Deno.makeTempDir({ prefix: "mt-" });
  await Deno.mkdir(piAgentDir, { recursive: true });
  await Deno.mkdir(projectDir, { recursive: true });

  // Tools the test controls, placed ahead of the host's PATH.
  const bin = path.join(root, "bin");
  await Deno.mkdir(bin, { recursive: true });
  const pi = opts.pi === undefined ? TESTED_PI_VERSION : opts.pi;
  await Deno.writeTextFile(
    path.join(bin, "pi"),
    pi === false ? "#!/bin/sh\nexit 127\n" : `#!/bin/sh\necho ${pi}\n`,
    { mode: 0o755 },
  );

  const session = `mpt-${crypto.randomUUID().slice(0, 8)}`;
  const port = freePort();

  const env: Record<string, string> = {
    PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
    HOME: home,
    MPT_HOME: home,
    PI_CODING_AGENT_DIR: piAgentDir,
    TEAM_DIR: teamDir,
    PORT: String(port),
    TMUX_TMPDIR: tmuxDir,
    // Point the CLI at the real cache so it doesn't re-download per sandbox.
    DENO_DIR: DENO_CACHE_DIR,
    NO_COLOR: "1",
  };

  let daemon: Deno.ChildProcess | null = null;

  const sb: Sandbox = {
    root,
    home,
    piAgentDir,
    projectDir,
    teamDir,
    tmuxDir,
    session,
    port,
    env,

    mpt: (...args) => run(Deno.execPath(), ["run", "--allow-all", CLI, ...args], env, projectDir),
    tmux: (...args) => run("tmux", args, env, projectDir),
    tmuxExec: (args) => {
      try {
        const out = new Deno.Command("tmux", { args, env, clearEnv: true, stdout: "piped", stderr: "piped" }).outputSync();
        return {
          ok: out.success,
          stdout: new TextDecoder().decode(out.stdout),
          stderr: new TextDecoder().decode(out.stderr),
        };
      } catch (e) {
        return { ok: false, stdout: "", stderr: (e as Error).message };
      }
    },

    writePiSettings(settings) {
      Deno.mkdirSync(piAgentDir, { recursive: true });
      Deno.writeTextFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify(settings, null, 2));
    },
    readPiSettings() {
      return JSON.parse(Deno.readTextFileSync(path.join(piAgentDir, "settings.json")));
    },
    writeTeamConfig(config) {
      Deno.mkdirSync(teamDir, { recursive: true });
      Deno.writeTextFileSync(path.join(teamDir, "config.json"), JSON.stringify({ tmuxSession: session, ...config }, null, 2));
    },

    async startDaemon(entry = "cli") {
      daemon = new Deno.Command(Deno.execPath(), {
        args: entry === "source" ? ["run", "--allow-all", DAEMON_MAIN] : ["run", "--allow-all", CLI, "start"],
        env,
        clearEnv: true,
        cwd: projectDir,
        stdout: "null",
        stderr: "null",
        stdin: "null",
      }).spawn();
      const up = await sb.waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          return false;
        }
      }, 20_000);
      if (!up) throw new Error(`daemon did not come up on port ${port}`);
    },

    async waitFor(check, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await check();
    },

    async [Symbol.asyncDispose]() {
      // Each step is independent: one failing must not strand the others.
      if (daemon) {
        try { daemon.kill("SIGTERM"); } catch { /* already gone */ }
        try { await daemon.status; } catch { /* */ }
      }
      // Kill the *private* server — never the user's. Safe precisely because
      // TMUX_TMPDIR points only at this sandbox's socket directory.
      if (hasTmux()) {
        try { await run("tmux", ["kill-server"], env, projectDir); } catch { /* none running */ }
      }
      for (const dir of [root, tmuxDir]) {
        try { await Deno.remove(dir, { recursive: true }); } catch { /* */ }
      }
    },
  };

  return sb;
}

/** Everything a sandbox leaves on disk, so tests can prove teardown happened. */
export function sandboxLeftovers(sb: Pick<Sandbox, "root" | "tmuxDir">): string[] {
  return [sb.root, sb.tmuxDir].filter((d) => existsSync(d));
}

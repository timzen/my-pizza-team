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

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { TmuxExec } from "../../daemon/tmux.ts";
import { TESTED_PI_VERSION } from "../../cli/doctor.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli", "main.ts");
/** The daemon's source entry point, as `node daemon/main.ts` runs it. */
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
   * `mpt start` (default), or via daemon/main.ts directly.
   */
  startDaemon(entry?: "cli" | "source"): Promise<void>;
  /** Poll until `check` is true or the timeout passes. Returns whether it became true. */
  waitFor(check: () => boolean | Promise<boolean>, timeoutMs?: number): Promise<boolean>;
}

/** An unused TCP port, so parallel sandboxes don't collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function run(cmd: string, args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    // A fresh environment rather than the parent's: nothing leaks in that the test
    // didn't choose. PATH is passed explicitly in `env` so tools still resolve.
    const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => stdout += d);
    child.stderr.setEncoding("utf8").on("data", (d: string) => stderr += d);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1), stdout, stderr, output: stdout + stderr });
    });
  });
}

/** Is tmux installed? Tests needing it skip when it isn't — and only then. */
export function hasTmux(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `mpt-${label}-`));
  const home = path.join(root, "home");
  const piAgentDir = path.join(home, ".pi", "agent");
  const projectDir = path.join(root, "project");
  const teamDir = path.join(projectDir, ".my-pizza-team");
  // Short on purpose: tmux sockets live under this path, and Unix socket paths are
  // limited to ~104 bytes. A long temp prefix can push them over.
  const tmuxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mt-"));
  await fs.promises.mkdir(piAgentDir, { recursive: true });
  await fs.promises.mkdir(projectDir, { recursive: true });

  // Tools the test controls, placed ahead of the host's PATH.
  const bin = path.join(root, "bin");
  await fs.promises.mkdir(bin, { recursive: true });
  const pi = opts.pi === undefined ? TESTED_PI_VERSION : opts.pi;
  await fs.promises.writeFile(
    path.join(bin, "pi"),
    pi === false ? "#!/bin/sh\nexit 127\n" : `#!/bin/sh\necho ${pi}\n`,
    { mode: 0o755 },
  );

  const session = `mpt-${crypto.randomUUID().slice(0, 8)}`;
  const port = await freePort();

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    MPT_HOME: home,
    PI_CODING_AGENT_DIR: piAgentDir,
    TEAM_DIR: teamDir,
    PORT: String(port),
    TMUX_TMPDIR: tmuxDir,
    // The shell tmux starts in each window. Left unset, tmux falls back to the login
    // shell from passwd — on a host whose shell is zsh with no ~/.zshrc (the sandbox's
    // HOME has none), zsh's first-run wizard swallows the command typed into the window.
    SHELL: "/bin/sh",
    NO_COLOR: "1",
  };

  let daemon: ChildProcess | null = null;

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

    mpt: (...args) => run(process.execPath, [CLI, ...args], env, projectDir),
    tmux: (...args) => run("tmux", args, env, projectDir),
    tmuxExec: (args) => {
      try {
        const out = spawnSync("tmux", args, { env, encoding: "utf8" });
        if (out.error) throw out.error;
        return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
      } catch (e) {
        return { ok: false, stdout: "", stderr: (e as Error).message };
      }
    },

    writePiSettings(settings) {
      fs.mkdirSync(piAgentDir, { recursive: true });
      fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify(settings, null, 2));
    },
    readPiSettings() {
      return JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8"));
    },
    writeTeamConfig(config) {
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ tmuxSession: session, ...config }, null, 2));
    },

    async startDaemon(entry = "cli") {
      daemon = spawn(process.execPath, entry === "source" ? [DAEMON_MAIN] : [CLI, "start"], {
        env,
        cwd: projectDir,
        stdio: "ignore",
      });
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
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise((r) => daemon!.once("exit", r));
        try { daemon.kill("SIGTERM"); } catch { /* already gone */ }
        await exited;
      }
      // Kill the *private* server — never the user's. Safe precisely because
      // TMUX_TMPDIR points only at this sandbox's socket directory.
      if (hasTmux()) {
        try { await run("tmux", ["kill-server"], env, projectDir); } catch { /* none running */ }
      }
      for (const dir of [root, tmuxDir]) {
        try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* */ }
      }
    },
  };

  return sb;
}

/** Everything a sandbox leaves on disk, so tests can prove teardown happened. */
export function sandboxLeftovers(sb: Pick<Sandbox, "root" | "tmuxDir">): string[] {
  return [sb.root, sb.tmuxDir].filter((d) => existsSync(d));
}

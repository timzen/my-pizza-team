/**
 * daemon/readiness.ts — the readiness probe, run by the daemon.
 *
 * Readiness answers "can this machine work right now?" Its motivating case is a cloud
 * desktop whose credentials expire: every claimed WorkItem then fails, so an overnight
 * cron piles up FAILED runs. A not-ready team *holds* scheduled enqueues instead, and
 * the held Schedule re-fires exactly once on recovery (docs/ARCHITECTURE.md
 * "Scheduler readiness gating").
 *
 * Moved here from the leader (docs/DESIGN.md "The Daemon Is the Supervisor", P3-2), which fixes an
 * inversion that was exactly backwards. While an *agent* reported readiness:
 *
 *   - nothing reported means "ready" (it has to — a fresh daemon knows nothing), so
 *   - a machine too wedged for the leader to even start was treated as **healthy**,
 *   - and work kept being scheduled into it.
 *
 * The daemon is already running whenever it matters, so it can answer with zero agents
 * connected — which is precisely when the answer counts.
 */

import { spawn } from "node:child_process";
import type { TeamConfig } from "../shared/types.ts";

export interface ProbeResult {
  ready: boolean;
  /** Human-readable reason when not ready. */
  reason?: string;
}

/** Runs a shell command with a timeout. Injectable so tests need no subprocesses. */
export type ProbeRunner = (command: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default probe timeout. A probe is a quick check, not a build. */
export const PROBE_TIMEOUT_MS = 10_000;

/** How often the daemon re-probes. Matches the old per-heartbeat cadence. */
export const PROBE_INTERVAL_MS = 30_000;

export const shellRunner: ProbeRunner = async (command, timeoutMs) => {
  // A probe is user-supplied config, and the point is to run it as they wrote it —
  // pipes, `&&` and all — so this is the one place a shell is intentional.
  const child = spawn("sh", ["-c", command], { stdio: ["inherit", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (b: Buffer) => stdout.push(b));
  child.stderr?.on("data", (b: Buffer) => stderr.push(b));
  // Resolves when the process exits *and* its pipes close ("close", not "exit"), so
  // all output is in; a spawn failure ("error", e.g. sh itself unavailable) resolves
  // with code -1 and the error message.
  const finished = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child.once("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
    child.once("close", (code) => resolve({
      code: code ?? 1, // null means killed by a signal
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });

  // Race the probe against the deadline, and on timeout *stop waiting* rather than
  // waiting for the pipes to close.
  //
  // That distinction is the bug this fixes. The earlier version passed an
  // AbortSignal to the output wait, which kills `sh` — but on Linux `sh` is dash, which
  // doesn't exec its last command, so a child like `sleep` survives, keeps stdout
  // open, and the output wait blocks on it regardless. A probe that hung would stall the
  // readiness loop forever, freezing the team's readiness at its last value. On
  // macOS the shell happened to exec the command, so the bug only showed on Linux —
  // found by running the e2e suite in an Ubuntu container.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const winner = await Promise.race([finished, timedOut]);
  clearTimeout(timer);

  if (winner === "timeout") {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    // Don't await `finished`: an orphaned grandchild may hold the pipes for as long
    // as it likes. Drop our ends of the pipes so they can't keep the process alive.
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    return { code: -1, stdout: "", stderr: `readiness probe timed out after ${Math.round(timeoutMs / 1000)}s` };
  }
  return winner;
};

const firstLine = (s: string): string | undefined => s.split("\n").map((l) => l.trim()).find((l) => l.length > 0);

/**
 * Run the probe once.
 *
 * Never throws: a probe that cannot be launched is itself "not ready", because the
 * point is to confirm the machine *can* work and an unrunnable probe confirms nothing.
 * Treating that as ready would disable gating exactly when something is already wrong.
 */
export async function runProbe(
  command: string,
  opts: { timeoutMs?: number; runner?: ProbeRunner } = {},
): Promise<ProbeResult> {
  const runner = opts.runner ?? shellRunner;
  const { code, stdout, stderr } = await runner(command, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (code === 0) return { ready: true };
  // Prefer the probe's own message — it was written to be read by a human.
  const reason = firstLine(stdout) ?? firstLine(stderr) ?? `probe exited ${code}`;
  return { ready: false, reason };
}

/** What the readiness loop needs from the store. */
export interface ReadinessStore {
  getConfig(): TeamConfig;
  setTeamReadiness(ready: boolean, reason?: string): void;
}

/**
 * Start probing on an interval. Returns a stop function.
 *
 * No probe configured means readiness is never reported, and an unreported team counts
 * as ready — the common case, and the right default: a team with no probe has nothing
 * to be unready about.
 */
export function startReadinessLoop(
  store: ReadinessStore,
  opts: { runner?: ProbeRunner; intervalMs?: number } = {},
): (() => void) | null {
  const command = (store.getConfig().readinessProbe ?? "").trim();
  if (!command) return null;

  let running = false;
  const tick = async () => {
    // Skip rather than queue: a probe slower than the interval would otherwise pile up.
    if (running) return;
    running = true;
    try {
      const result = await runProbe(command, { runner: opts.runner });
      store.setTeamReadiness(result.ready, result.reason);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? PROBE_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}

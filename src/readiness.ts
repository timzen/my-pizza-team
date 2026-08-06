// Readiness probe: an optional, host-local check that decides whether this
// teammate can currently take work.
//
// Motivating case: on a cloud desktop, credentials (e.g. `mwinit`) expire on a
// schedule. A teammate whose creds are stale can't actually do work — every
// claimed WorkItem fails. Instead of piling up failed scheduled runs overnight,
// the teammate runs a small user-supplied command each heartbeat; a non-zero
// exit means "not ready", which it reports to the daemon. The daemon then holds
// scheduled enqueues destined for this agent until it recovers (see the daemon's
// docs/ARCHITECTURE.md "Scheduler readiness gating").
//
// The probe is a *machine/host* concern (which host's credentials are valid),
// not a team concern, so it's configured per-process via the `--ppt-readiness-probe`
// flag or the `PPT_READINESS_PROBE` env var — never in the shared team config.
// The contract is deliberately minimal: run a command via the shell, exit 0 =
// ready, non-zero = not ready. Stdout (trimmed, first line) becomes the reason
// shown in the UI. No probe configured → always ready (fully backward compatible).

import { exec } from "node:child_process";

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
}

export interface ReadinessProbeConfig {
  /** Shell command to run. Exit 0 = ready; non-zero = not ready. */
  command: string;
  /** Max time to wait before treating the probe as not-ready (default 10s). */
  timeoutMs: number;
}

/**
 * Resolve the readiness probe from flags/env. Returns null when no probe is
 * configured (the common case — the agent is then always considered ready).
 */
export function resolveReadinessProbe(flagCommand: string): ReadinessProbeConfig | null {
  const command = (flagCommand || process.env.PPT_READINESS_PROBE || "").trim();
  if (!command) return null;
  const envTimeout = parseInt(process.env.PPT_READINESS_PROBE_TIMEOUT_MS || "", 10);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10_000;
  return { command, timeoutMs };
}

/**
 * Run the probe once. Never throws — any failure to launch/execute the command
 * is itself treated as "not ready" (with the error as the reason), since we
 * can't confirm the agent can work.
 */
export function runReadinessProbe(probe: ReadinessProbeConfig): Promise<ReadinessResult> {
  return new Promise((resolve) => {
    exec(probe.command, { timeout: probe.timeoutMs }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ready: true });
        return;
      }
      // Prefer the probe's own message (stdout first line), then stderr, then
      // the launch error — whatever is most human-readable in the UI.
      const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      const reason = firstLine(stdout || "") || firstLine(stderr || "") || err.message || "readiness probe failed";
      resolve({ ready: false, reason });
    });
  });
}

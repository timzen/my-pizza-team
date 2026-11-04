/**
 * daemon/start.ts — Start the daemon in-process: the one startup routine.
 *
 * Every way of running the daemon comes through here — `mpt start` (foreground,
 * and the background child `--daemon` launches), the launchd/systemd
 * service, and `npm run dev`/`start` via daemon/main.ts — so they all get the same daemon:
 * the HTTP server, the PID file and signal handling, daemon-driven spawning, and
 * the readiness probe. (daemon/main.ts used to be a separate, older copy that
 * skipped the last two, so the dev daemon behaved differently from the real one.)
 */

import { createApp } from "./app.ts";
import {
  writePidFile,
  isAlreadyRunning,
  registerSignalHandlers,
  type DaemonContext,
} from "./lifecycle.ts";
import { resolveToken, validateBindSafety } from "./auth.ts";
import { probeTerminalCapability, realizePending } from "./spawner.ts";
import { createTerminalBackend, formatTerminalStatus } from "./terminal/index.ts";
import { startReadinessLoop } from "./readiness.ts";
import { mptInvocation } from "./self.ts";
import { findPreCutoffLayout, formatPreCutoffMessage } from "./layout-check.ts";
import { resolveTerminal, TEAM_DIR } from "../shared/types.ts";
import { readTeamConfigFile } from "../shared/team-config.ts";
import { serve } from "@hono/node-server";
import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";

/**
 * The team directory from the environment: `TEAM_DIR` names the directory itself
 * or its parent; unset means `.my-pizza-team` in the current directory.
 */
export function resolveTeamDir(env: string | undefined = process.env["TEAM_DIR"], cwd: string = process.cwd()): string {
  if (env) {
    if (env.endsWith(TEAM_DIR)) return env;
    if (existsSync(path.join(env, TEAM_DIR))) return path.join(env, TEAM_DIR);
    return env;
  }
  return path.join(cwd, TEAM_DIR);
}

/**
 * Refuse a team last run on a version older than 0.36.0 (daemon/layout-check.ts):
 * print what was found and the upgrade path, and exit non-zero. Returns only when
 * the team dir is in the current layout (or doesn't exist yet).
 */
export function refusePreCutoffLayout(teamDir: string): void {
  const findings = findPreCutoffLayout(teamDir);
  if (findings.length === 0) return;
  console.error(`❌ ${formatPreCutoffMessage(teamDir, findings)}`);
  process.exit(1);
}

/**
 * Start the daemon server in the current process.
 * This is what foreground CLI mode, the background child and the service all use.
 */
export async function startDaemonInProcess(
  teamDir: string,
  port: number,
  hostname: string,
): Promise<void> {
  // Before anything is created or opened: a pre-0.36.0 team is refused, not
  // migrated (docs/DESIGN.md "Upgrading from before 0.36.0").
  refusePreCutoffLayout(teamDir);

  // Ensure team directory exists
  if (!existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true });
  }

  // Check if another daemon is already running
  const existing = isAlreadyRunning(teamDir);
  if (existing.running) {
    console.error(
      `❌ Daemon already running (PID ${existing.pid}). Stop it first or remove ${teamDir}/daemon.pid`,
    );
    process.exit(1);
  }

  // Create the app and store
  let app, store;
  try {
    const ctx = await createApp(teamDir);
    app = ctx.app;
    store = ctx.store;
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`❌ Failed to initialize daemon: ${msg}`);
    console.error(`   Team dir: ${teamDir}`);
    if (msg.includes("Cannot read properties") || msg.includes("undefined")) {
      console.error(`   This likely means config.json is missing required fields or is malformed. Check ${teamDir}/config.json.`);
    } else {
      console.error(`   This often means SQLite failed to load. Ensure libsqlite3 is available.`);
    }
    process.exit(1);
  }

  // Validate bind safety: refuse 0.0.0.0 without a token
  const configToken = readTeamConfigFile(teamDir)?.apiToken as string | undefined;
  const token = resolveToken(configToken);
  const bindCheck = validateBindSafety(hostname, token);
  if (!bindCheck.safe) {
    console.error(`❌ ${bindCheck.reason}`);
    process.exit(1);
  }

  // ─── tmux capability ───────────────────────────────────────────────
  //
  // Probed before the server listens, so /health never reports an unprobed answer
  // and no spawn is created against one. Once: whether this process can reach tmux
  // is a property of how it was launched (under launchd/systemd it may have no tmux
  // on PATH). The socket is the tmux server the daemon's windows open on, which
  // `mpt doctor` compares with the user's.
  // `store` is null only in health-only mode, which has no team to spawn into.
  // tmux specifically, whatever `terminal` config says: the setting changes live
  // (Store.getSpawnCapability re-checks it on every use), tmux is the only backend
  // that needs a launch-time probe, and windows started under tmux still need
  // closing after a switch.
  const terminal = store ? createTerminalBackend("tmux") : null;
  const tmuxCapability = terminal ? probeTerminalCapability(terminal) : null;
  if (store && terminal && tmuxCapability) {
    store.setTmuxCapability(tmuxCapability);
    const tmuxStatus = terminal.describe();
    store.setTmuxStatus(tmuxStatus);
    store.setTmuxSocket(tmuxCapability.canSpawn ? tmuxStatus.identity : null);
    // The `{url}` a leader started from the web UI is given (POST /api/assistant/start).
    store.setDaemonUrl(`http://localhost:${port}`);
  }

  // Start the HTTP server, and wait until it is listening: a bind failure (port in
  // use, address unavailable) surfaces here as a thrown error, before the PID file
  // is written, rather than as an uncaught event later.
  const server = serve({ fetch: app.fetch, port, hostname });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));

  // Write PID file
  const pidFile = writePidFile(teamDir);

  // Set up graceful shutdown context
  const ctx: DaemonContext = { store, server, teamDir, pidFile };
  registerSignalHandlers(ctx);

  // ─── Spawn realization (P3-1) ──────────────────────────────────────
  //
  // The daemon turns `spawn`/`dismiss` directives into tmux windows itself, so a
  // harness is a config entry rather than extension code, and so a teammate can be
  // started with no leader connected. It is the only realizer: when it can't reach
  // tmux, the pass fails every spawn/dismiss with the reason and fix (shown in the
  // Team tab), rather than leaving them pending for a leader as it once did.
  // Whether the config's default harness is spawnable is re-checked on every use
  // (Store.getSpawnCapability), since the Config page changes it live.
  let spawnTimer: ReturnType<typeof setInterval> | undefined;
  if (store && tmuxCapability) {
    const spawnCapability = store.getSpawnCapability();
    // Name the backend new windows open in (it can change live; this is at startup).
    const status = store.getTerminalStatus();
    console.log(`   Terminal: ${formatTerminalStatus(status, resolveTerminal(store.getConfig()))}`);
    if (spawnCapability.canSpawn) {
      console.log(`   Spawning: daemon-driven (${status?.displayName ?? resolveTerminal(store.getConfig())} server ${status?.identity ?? "unknown"})`);
    } else {
      console.error(`⚠️  Spawning: unavailable — ${spawnCapability.reason}`);
      console.error(`     ${spawnCapability.fix}`);
    }
    const realize = () => {
      try {
        const { failed, warnings } = realizePending(store, {
          config: store.getConfig(),
          daemonUrl: `http://localhost:${port}`,
          fallbackCwd: path.dirname(teamDir),
          teamDir,
          mpt: mptInvocation(),
          tmux: tmuxCapability,
        });
        for (const f of failed) console.error(`⚠️  Directive ${f.id} failed: ${f.error}`);
        // A bad agent env file doesn't fail the spawn; it is said here (and by doctor).
        for (const w of warnings) console.error(`⚠️  ${w}`);
      } catch (e) {
        // Never let a spawn problem take the daemon down with it.
        console.error(`⚠️  Spawn pass failed: ${(e as Error).message}`);
      }
    };
    // 2s: a directive is usually realized before anyone notices.
    spawnTimer = setInterval(realize, 2000);
    realize();
  }

  // ─── Readiness probe (P3-2) ────────────────────────────────────────
  //
  // Run here rather than by an agent. While the leader reported it, a machine too
  // wedged for the leader to start was treated as *healthy* — nothing reported means
  // ready — and work kept being scheduled into it. The daemon is running whenever it
  // matters, so it can answer with zero agents connected.
  const stopReadiness = store ? startReadinessLoop(store) : null;
  if (stopReadiness) console.log("   Readiness: daemon-probed");

  console.log(`🍕 my-pizza-team daemon listening on http://localhost:${port}`);
  console.log(`   PID: ${process.pid} (${pidFile})`);
  console.log(`   Team dir: ${teamDir}`);
  console.log(`   Press Ctrl+C to stop.`);

  // Keep alive — wait for server to close
  try {
    await closed;
  } finally {
    if (spawnTimer !== undefined) clearInterval(spawnTimer);
    stopReadiness?.();
  }
}

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
import { harnessCapability, probeTmuxCapability, realizePending } from "./spawner.ts";
import { startReadinessLoop } from "./readiness.ts";
import { mptInvocation } from "./self.ts";
import { TEAM_DIR } from "../shared/types.ts";
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
 * Start the daemon server in the current process.
 * This is what foreground CLI mode, the background child and the service all use.
 */
export async function startDaemonInProcess(
  teamDir: string,
  port: number,
  hostname: string,
): Promise<void> {
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
    const ctx = createApp(teamDir);
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
  const configPath = path.join(teamDir, "config.json");
  const configToken = existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, "utf8")).apiToken as string | undefined)
    : undefined;
  const token = resolveToken(configToken);
  const bindCheck = validateBindSafety(hostname, token);
  if (!bindCheck.safe) {
    console.error(`❌ ${bindCheck.reason}`);
    process.exit(1);
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
  // started with no leader connected. Probed once: whether this process can reach tmux
  // is a property of how it was launched, and under launchd/systemd it may have no
  // tmux on PATH. When it can't, directives stay pending and the leader realizes them
  // exactly as before — the path `mpt doctor` reports.
  // `store` is null only in health-only mode, which has no team to spawn into.
  // tmux reachability is probed once; whether the config's default harness is
  // spawnable is re-checked every pass, since the Config page changes it live.
  const tmuxCapability = store ? probeTmuxCapability() : { canSpawn: false as const, reason: "no team directory", fix: "run `mpt setup`" };
  const spawnCapability = store && tmuxCapability.canSpawn ? harnessCapability(store.getConfig()) : tmuxCapability;
  store?.setSpawnCapability(spawnCapability);

  let spawnTimer: ReturnType<typeof setInterval> | undefined;
  if (store && tmuxCapability.canSpawn) {
    if (spawnCapability.canSpawn) console.log("   Spawning: daemon-driven (tmux reachable)");
    else console.log(`   Spawning: leader-driven until the config is fixed — ${spawnCapability.reason}\n     ${spawnCapability.fix}`);
    const realize = () => {
      try {
        // A config-level problem (an experimental default harness without the
        // opt-in) leaves directives pending for the leader, as at startup.
        const capability = harnessCapability(store.getConfig());
        store.setSpawnCapability(capability);
        if (!capability.canSpawn) return;
        const { failed } = realizePending(store, {
          config: store.getConfig(),
          daemonUrl: `http://localhost:${port}`,
          fallbackCwd: path.dirname(teamDir),
          mpt: mptInvocation(),
        });
        for (const f of failed) console.error(`⚠️  Spawn ${f.id} failed: ${f.error}`);
      } catch (e) {
        // Never let a spawn problem take the daemon down with it.
        console.error(`⚠️  Spawn pass failed: ${(e as Error).message}`);
      }
    };
    // 2s: a directive is usually realized before anyone notices, and faster than the
    // leader's 5s poll it replaces.
    spawnTimer = setInterval(realize, 2000);
    realize();
  } else if (!tmuxCapability.canSpawn) {
    console.log(`   Spawning: leader-driven — ${tmuxCapability.reason}`);
    console.log(`     ${tmuxCapability.fix}`);
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

/**
 * daemon/start.ts — Start the daemon in-process: the one startup routine.
 *
 * Every way of running the daemon comes through here — `mpt start` (foreground,
 * and the background child `--daemon` launches), the compiled binary, and
 * `deno task dev`/`start` via daemon/main.ts — so they all get the same daemon:
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
import { probeSpawnCapability, realizePending } from "./spawner.ts";
import { startReadinessLoop } from "./readiness.ts";
import { mptInvocation } from "./self.ts";
import { TEAM_DIR } from "../shared/types.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";

/**
 * The team directory from the environment: `TEAM_DIR` names the directory itself
 * or its parent; unset means `.my-pizza-team` in the current directory.
 */
export function resolveTeamDir(env: string | undefined = Deno.env.get("TEAM_DIR"), cwd: string = Deno.cwd()): string {
  if (env) {
    if (env.endsWith(TEAM_DIR)) return env;
    if (existsSync(path.join(env, TEAM_DIR))) return path.join(env, TEAM_DIR);
    return env;
  }
  return path.join(cwd, TEAM_DIR);
}

/**
 * Start the daemon server in the current process.
 * This is what both foreground CLI mode and the compiled binary use.
 */
export async function startDaemonInProcess(
  teamDir: string,
  port: number,
  hostname: string,
): Promise<void> {
  // Ensure team directory exists
  if (!existsSync(teamDir)) {
    Deno.mkdirSync(teamDir, { recursive: true });
  }

  // Check if another daemon is already running
  const existing = isAlreadyRunning(teamDir);
  if (existing.running) {
    console.error(
      `❌ Daemon already running (PID ${existing.pid}). Stop it first or remove ${teamDir}/daemon.pid`,
    );
    Deno.exit(1);
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
    Deno.exit(1);
  }

  // Validate bind safety: refuse 0.0.0.0 without a token
  const configPath = path.join(teamDir, "config.json");
  const configToken = existsSync(configPath)
    ? (JSON.parse(Deno.readTextFileSync(configPath)).apiToken as string | undefined)
    : undefined;
  const token = resolveToken(configToken);
  const bindCheck = validateBindSafety(hostname, token);
  if (!bindCheck.safe) {
    console.error(`❌ ${bindCheck.reason}`);
    Deno.exit(1);
  }

  // Start the HTTP server
  const server = Deno.serve({ port, hostname }, app.fetch);

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
  const spawnCapability = store ? probeSpawnCapability(store.getConfig()) : { canSpawn: false as const, reason: "no team directory", fix: "run `mpt setup`" };
  store?.setSpawnCapability(spawnCapability);

  let spawnTimer: ReturnType<typeof setInterval> | undefined;
  if (store && spawnCapability.canSpawn) {
    console.log("   Spawning: daemon-driven (tmux reachable)");
    const realize = () => {
      try {
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
  } else if (!spawnCapability.canSpawn) {
    console.log(`   Spawning: leader-driven — ${spawnCapability.reason}`);
    console.log(`     ${spawnCapability.fix}`);
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
  console.log(`   PID: ${Deno.pid} (${pidFile})`);
  console.log(`   Team dir: ${teamDir}`);
  console.log(`   Press Ctrl+C to stop.`);

  // Keep alive — wait for server to close
  try {
    await server.finished;
  } finally {
    if (spawnTimer !== undefined) clearInterval(spawnTimer);
    stopReadiness?.();
  }
}

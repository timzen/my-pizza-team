/**
 * daemon/app.ts — Hono application setup and route registration.
 *
 * Creates the Hono app by wiring the Store to the server routes.
 * For standalone use (e.g., testing without a full store), the health
 * endpoint is always available.
 */

import { Hono } from "hono";
import { buildApp } from "./server.ts";
import { Store } from "./store.ts";
import { FixtureSource } from "./sources/fixture.ts";
import { loadPlugins } from "./plugins/loader.ts";
import { installMissingPackages, type PluginRunner, pluginInstallTimeoutMs, runPluginCommand } from "./plugins/install.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";

export interface AppContext {
  app: Hono;
  store: Store | null;
}

export interface CreateAppOptions {
  /** How install-on-start runs npm/git (default: real processes; tests stub it). */
  pluginRunner?: PluginRunner;
  /** Per-command limit of install-on-start (default `MPT_PLUGIN_INSTALL_TIMEOUT_MS`, else 10 min). */
  pluginInstallTimeoutMs?: number;
}

/**
 * Create the full app with store, or a minimal app for health-only mode.
 * Async because plugin packages (`config.packages`) are loaded with `import()`
 * before the timers start; a failing plugin is logged, never thrown. Configured
 * npm/git packages that aren't installed are installed first (pi-style), each
 * on its own: one that fails is reported in its load status and skipped.
 */
export async function createApp(teamDir?: string, opts: CreateAppOptions = {}): Promise<AppContext> {
  if (teamDir && existsSync(teamDir)) {
    const configFile = path.join(teamDir, "config.json");
    const userConfig = existsSync(configFile)
      ? JSON.parse(fs.readFileSync(configFile, "utf8"))
      : {};

    // Merge with defaults so missing fields don't crash
    const config: TeamConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      autosave: { ...DEFAULT_CONFIG.autosave, ...(userConfig.autosave || {}) },
      teammates: { ...DEFAULT_CONFIG.teammates, ...(userConfig.teammates || {}) },
    };

    const store = new Store(teamDir, config);
    registerDevSources(store, config, teamDir);
    // Plugin sources register after the built-ins (so they can't take a built-in's
    // id) and before loadFromDisk/startTimers, so they reconcile and sync with the rest.
    const installErrors = installMissingPackages(config, {
      teamDir,
      run: opts.pluginRunner ?? runPluginCommand,
      log: (m) => console.warn(`[plugins] ${m}`),
      timeoutMs: opts.pluginInstallTimeoutMs ?? pluginInstallTimeoutMs(),
    });
    store.setPluginStatuses(await loadPlugins(store, config, teamDir, { installErrors }));
    // Work Source personas (docs/DESIGN.md "Work Source personas"), once every
    // source and package persona is registered: seed a triage plugin's triage
    // persona (migration step 3), then warn about declared ids that don't resolve.
    store.seedSourceTriagePersonas();
    store.checkDeclaredSourcePersonas();
    store.loadFromDisk();
    store.startTimers();

    return { app: buildApp(store, config, teamDir), store };
  }

  // Minimal app (no store) — just health check
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));
  return { app, store: null };
}

/**
 * Register the development-only Work Sources the config asks for: today the
 * markdown-folder fixture source (`config.dev.fixtureSource`; daemon/sources/fixture.ts),
 * the stand-in for an external source while package loading is deferred. Before
 * `startTimers`, so its sync timer starts with the rest.
 */
export function registerDevSources(store: Store, config: TeamConfig, teamDir: string): void {
  const fixture = config.dev?.fixtureSource;
  if (!fixture?.dir) return;
  try {
    store.registerWorkSource(new FixtureSource({
      dir: path.resolve(teamDir, fixture.dir),
      id: fixture.id,
      label: fixture.label,
      syncEveryMs: fixture.intervalSeconds ? fixture.intervalSeconds * 1000 : undefined,
      mode: fixture.mode === "triage" ? "triage" : undefined,
      defaultPersona: fixture.defaultPersona,
      triagePersona: fixture.triagePersona,
    }));
  } catch (e) {
    // A bad dev config must not stop the daemon.
    console.warn(`[sources] fixture source not registered: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Export a default minimal app for simple test imports (no store, basic health only)
export const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));

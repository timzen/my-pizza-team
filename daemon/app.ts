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
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "node:path";
import { existsSync } from "node:fs";

export interface AppContext {
  app: Hono;
  store: Store | null;
}

/** Create the full app with store, or a minimal app for health-only mode */
export function createApp(teamDir?: string): AppContext {
  if (teamDir && existsSync(teamDir)) {
    const configFile = path.join(teamDir, "config.json");
    const userConfig = existsSync(configFile)
      ? JSON.parse(Deno.readTextFileSync(configFile))
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
    }));
  } catch (e) {
    // A bad dev config must not stop the daemon.
    console.warn(`[sources] fixture source not registered: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Export a default minimal app for simple test imports (no store, basic health only)
export const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));

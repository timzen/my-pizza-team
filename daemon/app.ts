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
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";

export interface AppContext {
  app: Hono;
  store: Store | null;
}

/** Create the full app with store, or a minimal app for health-only mode */
export function createApp(teamDir?: string): AppContext {
  if (teamDir && existsSync(teamDir)) {
    const configFile = path.join(teamDir, "config.json");
    const config: TeamConfig = existsSync(configFile)
      ? JSON.parse(Deno.readTextFileSync(configFile))
      : DEFAULT_CONFIG;

    const store = new Store(teamDir, config);
    store.loadFromDisk();
    store.startTimers();

    return { app: buildApp(store, config, teamDir), store };
  }

  // Minimal app (no store) — just health check
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));
  return { app, store: null };
}

// Export a default minimal app for simple test imports
export const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));

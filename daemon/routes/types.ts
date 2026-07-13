/**
 * daemon/routes/types.ts — Shared context type for route modules.
 *
 * Each route module receives this context to access the store, config,
 * team directory, and shared utilities without importing them individually.
 */

import type { Hono } from "hono";
import type { Store } from "../store.ts";
import type { TeamConfig } from "../../shared/types.ts";

/** Shared context passed to each route module */
export interface RouteContext {
  app: Hono;
  store: Store;
  config: TeamConfig;
  teamDir: string;
  /** Whether task distribution is paused */
  isPaused: () => boolean;
  setPaused: (v: boolean) => void;
  /** Daemon start timestamp (ms) */
  startedAt: number;
}

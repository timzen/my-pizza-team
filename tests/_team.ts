/**
 * tests/_team.ts — the shared harness for suites that need a throwaway team: a temp
 * team directory, a Store over it, and the Hono app, plus small JSON request helpers.
 *
 * Nearly every API/store suite used to carry its own copy of the same `setup()`
 * (mkdtemp, `stories/`, `TEST_CONFIG` + overrides, `new Store`, `buildApp`),
 * `cleanup()` (close the Store, remove the directory) and `post`/`put` wrappers
 * around `app.request`. This is that code, once.
 *
 *   - `makeTeam(cfg?, opts?)` returns `{ app, store, teamDir, config, cleanup }`;
 *     the caller owns `cleanup()`.
 *   - `withTeam(cfg, fn)` runs `fn` with a team and always cleans up, even when an
 *     assertion throws.
 *   - `post` / `put` / `del` / `get` send a request to anything with Hono's
 *     `request(url, init)` and resolve to the `Response`.
 *
 * The config is always `structuredClone(TEST_CONFIG)` with `cfg` spread over it, so a
 * route that writes into the Store's config object can never leak into the next test
 * through a shared nested object. `TEST_CONFIG` (tests/_config.ts) keeps autosave's
 * real git out of the fast suite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import type { TeamConfig } from "../shared/types.ts";

/** The `Content-Type` header every JSON request sends. */
export const JSON_HEADERS = { "Content-Type": "application/json" };

/** The app type `buildApp` returns. */
export type App = ReturnType<typeof buildApp>;

/** Anything requests can be sent to: the Hono app, or a suite's wrapper around it (auth, headers). */
export interface RequestTarget {
  request(url: string, init?: RequestInit): Response | Promise<Response>;
}

/** Extra knobs for `makeTeam`; most suites need none. */
export interface TeamOptions {
  /** `mkdtemp` prefix for the team directory (default `mpt-test-`). */
  prefix?: string;
  /** Runs once the team directory exists, before the Store opens (seed config.json, plugins, legacy files). */
  beforeStore?: (teamDir: string, config: TeamConfig) => void;
  /** Runs once the Store is open, before the app is built (register sources and members, save workflows). */
  beforeApp?: (store: Store, teamDir: string, config: TeamConfig) => void;
}

/** A throwaway team: what `makeTeam` returns and `withTeam` hands to its callback. */
export interface Team {
  /** The Hono app over `store`, built as soon as the Store is set up (after `beforeApp`). */
  app: App;
  store: Store;
  teamDir: string;
  /** The config the Store and app were given (a clone of `TEST_CONFIG` plus `cfg`). */
  config: TeamConfig;
  /** Close the Store and remove the team directory. Safe to call more than once. */
  cleanup(): void;
}

/**
 * Create a temp team directory (with `stories/`), open a Store on `TEST_CONFIG` + `cfg`
 * and return it with its app. Workflows in `cfg.workflows` are also saved to the team's
 * `workflows/`, since the Store loads workflows from disk, not from the config.
 * The caller must call `cleanup()` (or use `withTeam`).
 */
export function makeTeam(cfg: Partial<TeamConfig> = {}, opts: TeamOptions = {}): Team {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? "mpt-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...cfg };
  opts.beforeStore?.(teamDir, config);
  const store = new Store(teamDir, config);
  if (cfg.workflows) {
    for (const [name, wf] of Object.entries(cfg.workflows)) store.saveWorkflow(name, wf);
  }
  opts.beforeApp?.(store, teamDir, config);
  // Built now, not on demand: route registration reads the Store (feature gates for
  // registered sources) and the config (auth token), so a later build could differ.
  const app = buildApp(store, config, teamDir);
  let closed = false;
  return {
    app,
    store,
    teamDir,
    config,
    cleanup() {
      if (closed) return;
      closed = true;
      store.close();
      try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Run `fn` with a fresh team (see `makeTeam`) and clean up afterwards, whether `fn`
 * returns, throws or rejects. Resolves to `fn`'s result.
 */
export async function withTeam<T>(
  cfg: Partial<TeamConfig> | undefined,
  fn: (team: Team) => T | Promise<T>,
  opts: TeamOptions = {},
): Promise<T> {
  const team = makeTeam(cfg, opts);
  try {
    return await fn(team);
  } finally {
    team.cleanup();
  }
}

/** `RequestInit` for a JSON request; an `undefined` body sends none. */
export function jsonInit(method: string, body?: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) };
}

/** POST `body` (default `{}`) as JSON to `url`. */
export async function post(app: RequestTarget, url: string, body: unknown = {}): Promise<Response> {
  return await app.request(url, jsonInit("POST", body));
}

/** PUT `body` as JSON to `url`. */
export async function put(app: RequestTarget, url: string, body: unknown): Promise<Response> {
  return await app.request(url, jsonInit("PUT", body));
}

/** DELETE `url`, with an optional JSON body. */
export async function del(app: RequestTarget, url: string, body?: unknown): Promise<Response> {
  return await app.request(url, jsonInit("DELETE", body));
}

/** GET `url`. */
export async function get(app: RequestTarget, url: string): Promise<Response> {
  return await app.request(url);
}

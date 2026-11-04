/**
 * shared/team-config.ts — The one way to read and write a team's `config.json`.
 *
 * Three entry points, used by the daemon and the CLI alike:
 *
 *   - `readTeamConfigFile` — the file as written (no defaults), for callers that
 *     inspect one field or edit the raw object (`mpt plugins`, doctor).
 *   - `loadTeamConfig` — the file merged over `DEFAULT_CONFIG`, with the nested
 *     `autosave` and `teammates` blocks merged too, so a config that sets one
 *     autosave field keeps the defaults for the rest.
 *   - `saveTeamConfig` — write a config back atomically (temp file + rename).
 *
 * **A save never erases a field.** The writer used to list the fields it kept,
 * so every field missing from the list was erased on the next save (custom
 * harness templates and plugin packages were both lost that way). Now every key
 * of the object is written — including keys this version doesn't know about —
 * except the derived ones (`serializeTeamConfig`): `workflows` (they live in
 * `workflows/`), an unset `minTeammates` (writing the derived "half of
 * maxTeammates" would freeze it; see `resolveMinTeammates`), and optional
 * blocks whose empty value means the same as absent, so config.json stays minimal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CONFIG_FILE, DEFAULT_CONFIG, type TeamConfig } from "./types.ts";

/** The path of a team's config.json. */
export function teamConfigPath(teamDir: string): string {
  return path.join(teamDir, CONFIG_FILE);
}

/**
 * The team's config.json as written — not merged with defaults, so writing it
 * back adds nothing the user didn't have. `undefined` when there is no file.
 * Throws the parse error as is on bad JSON, and an Error("not a JSON object")
 * when the file parses to something other than an object; callers word their
 * own message around it.
 */
export function readTeamConfigFile(teamDir: string): Record<string, unknown> | undefined {
  const file = teamConfigPath(teamDir);
  if (!fs.existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Merge a raw config (as `readTeamConfigFile` returns it) over the defaults, so a
 * missing field can't crash a reader. Keys the daemon doesn't know about are
 * kept, so a later `saveTeamConfig` writes them back.
 */
export function applyTeamConfigDefaults(raw: Record<string, unknown>): TeamConfig {
  const user = raw as Partial<TeamConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    autosave: { ...DEFAULT_CONFIG.autosave, ...(user.autosave || {}) },
    teammates: { ...DEFAULT_CONFIG.teammates, ...(user.teammates || {}) },
  };
}

/**
 * The team's config with defaults applied (`applyTeamConfigDefaults`); just the
 * defaults when there is no config.json. Throws like `readTeamConfigFile` on a
 * malformed file.
 */
export function loadTeamConfig(teamDir: string): TeamConfig {
  return applyTeamConfigDefaults(readTeamConfigFile(teamDir) ?? {});
}

/**
 * Keys that are written in this order first, so a save keeps the layout the
 * daemon has always written (and team-dir git diffs stay small). Every other key
 * follows in the object's own order.
 */
const KEY_ORDER = [
  "port", "tmuxSession", "terminal", "herdrSession", "defaultWorkflow", "autosave", "maxTeammates", "minTeammates",
  "agentTimeoutSeconds", "apiToken", "teammates", "readinessProbe", "agentEnvFile", "harnesses",
  "defaultHarness", "experimental", "triage", "retry", "exclusiveDirectories", "features",
  "assistant", "sourcePersonas", "favoriteDirectories", "packages", "dev",
];

/** Derived, never persisted: workflows live in the workflows/ directory. */
const DERIVED_KEYS = new Set(["workflows"]);

/** Optional values where a falsy one (e.g. `""`) means unset. */
const OMIT_WHEN_FALSY = new Set(["terminal", "herdrSession", "apiToken", "readinessProbe", "agentEnvFile", "harnesses", "defaultHarness", "features"]);

/** Optional blocks where an empty object/array means the same as absent. */
const OMIT_WHEN_EMPTY = new Set([
  "teammates", "experimental", "triage", "retry", "assistant", "sourcePersonas", "favoriteDirectories",
]);

/** Whether `key: value` carries nothing a reload wouldn't reproduce (see the header). */
function isOmitted(key: string, value: unknown): boolean {
  // `undefined` is "not set" for every key; this is also what keeps an unset
  // minTeammates from being frozen at its derived value.
  if (value === undefined || DERIVED_KEYS.has(key)) return true;
  if (OMIT_WHEN_FALSY.has(key)) return !value;
  if (OMIT_WHEN_EMPTY.has(key)) {
    if (!value) return true;
    return Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0;
  }
  return false;
}

/**
 * The on-disk shape of a config: every key of `config` (known or not) except
 * the derived and empty ones (`isOmitted`). Exported for tests and for callers
 * that want the JSON without writing it.
 */
export function serializeTeamConfig(config: TeamConfig | Record<string, unknown>): Record<string, unknown> {
  const src = config as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = [...KEY_ORDER.filter((k) => k in src), ...Object.keys(src).filter((k) => !KEY_ORDER.includes(k))];
  for (const key of keys) {
    if (!isOmitted(key, src[key])) out[key] = src[key];
  }
  return out;
}

/**
 * Write a config to the team's config.json (`serializeTeamConfig`), via a temp
 * file and rename so a crash can't leave it half-written. Takes either a loaded
 * `TeamConfig` (the daemon's) or a raw object from `readTeamConfigFile` (the
 * CLI's); neither adds a default the object doesn't already hold.
 */
export function saveTeamConfig(teamDir: string, config: TeamConfig | Record<string, unknown>): void {
  writeFileAtomic(teamConfigPath(teamDir), JSON.stringify(serializeTeamConfig(config), null, 2) + "\n");
}

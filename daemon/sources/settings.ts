/**
 * daemon/sources/settings.ts — A source's settings as the Config page sees and
 * saves them (`GET /api/sources`, `PUT /api/sources/:id/config`). See
 * docs/DESIGN.md "Plugin settings: configSchema and preview".
 *
 * Two jobs, both pure (no Store, no file system):
 *
 *   - **Showing settings without secrets.** Secrets are never meant to be inline
 *     — a setting names an environment variable (`tokenEnv: "JIRA_TOKEN"`) — but
 *     nothing stops someone pasting a token into config.json. `viewSettings`
 *     replaces any string under a secret-looking key (token, secret, password,
 *     apiKey, credential) with `REDACTED_SETTING` and lists its path; env-var
 *     references are shown by name with whether the variable is set in the
 *     daemon's environment (its value never leaves the daemon).
 *     `restoreRedacted` is the inverse for a Save/Preview: a field still holding
 *     the placeholder keeps its stored value, so a round trip never writes the
 *     placeholder or loses the secret.
 *   - **Writing one package entry's `config`** (`setPackageEntryConfig`): find
 *     the `packages[]` entry by identity (the loader's dedupe rule: the first
 *     declaration wins), replace its `config`, keep every other entry and key —
 *     a bare spec string becomes `{ source, config }`.
 */

import { REDACTED_SETTING, type SourceEnvVarRef } from "../../shared/protocol.ts";
import type { PackageEntry } from "../../shared/types.ts";
import { ENV_VAR_NAME_PATTERN } from "./config-schema.ts";
import type { SourceConfigField, SourceConfigSchema } from "./types.ts";
import { parsePackageEntries } from "../plugins/spec.ts";

/** Keys whose string value is treated as a secret and never shown (unless declared `format: "env-var"`). */
const SECRET_KEY = /(secret|passw(or)?d|token|api[-_]?key|credential|private[-_]?key)/i;

/** A key that by convention holds an env var's *name* (`tokenEnv`, `JIRA_TOKEN_ENV`), not its value. */
const ENV_REF_KEY = /env$/i;

/** The settings block as shown: secrets replaced, env-var references listed. */
export interface SettingsView {
  options: Record<string, unknown>;
  /** Paths (`key`, `group.key`) whose value was replaced by `REDACTED_SETTING`. */
  redacted: string[];
  /** Every env-var reference, by name, and whether the daemon's environment has it. */
  envVars: SourceEnvVarRef[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The schema's field for `key` within `props`, if declared. */
function fieldOf(props: Readonly<Record<string, SourceConfigField>> | undefined, key: string): SourceConfigField | undefined {
  return props && Object.hasOwn(props, key) ? props[key] : undefined;
}

/** Is this string field an env-var reference — declared so, or (undeclared) by key convention? */
function isEnvRef(field: SourceConfigField | undefined, key: string, value: string): boolean {
  if (field?.type === "string") return field.format === "env-var";
  if (field) return false;
  return ENV_REF_KEY.test(key) && ENV_VAR_NAME_PATTERN.test(value);
}

/**
 * A settings block as `GET /api/sources` shows it (see the file header).
 * `env` is the daemon's environment (default `process.env`).
 */
export function viewSettings(
  schema: SourceConfigSchema | undefined,
  block: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SettingsView {
  const redacted: string[] = [];
  const envVars: SourceEnvVarRef[] = [];
  const ref = (path: string, name: string) => envVars.push({ path, name, set: !!env[name] });

  const walk = (props: Readonly<Record<string, SourceConfigField>> | undefined, value: Record<string, unknown>, at: string, depth: number) => {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const path = at ? `${at}.${key}` : key;
      const field = fieldOf(props, key);
      if (typeof v === "string") {
        const declaredRef = field?.type === "string" && field.format === "env-var";
        if (v && isEnvRef(field, key, v) && ENV_VAR_NAME_PATTERN.test(v)) ref(path, v);
        // A secret-looking key, or a declared env-var field holding something that isn't a name (a pasted secret).
        else if (v && (SECRET_KEY.test(key) || declaredRef)) {
          out[key] = REDACTED_SETTING;
          redacted.push(path);
          continue;
        }
        out[key] = v;
      } else if (Array.isArray(v)) {
        if (field?.type === "array" && field.items.format === "env-var") {
          v.forEach((name, i) => typeof name === "string" && name && ref(`${path}[${i}]`, name));
        }
        out[key] = v;
      } else if (isPlainObject(v) && depth === 0) {
        out[key] = walk(field?.type === "object" ? field.properties : undefined, v, path, 1);
      } else if (isPlainObject(v)) {
        // Deeper than the schema language goes: shown only if it holds no secret-looking key.
        const hidden = Object.keys(v).some((k) => SECRET_KEY.test(k) && !ENV_REF_KEY.test(k));
        if (hidden) {
          out[key] = REDACTED_SETTING;
          redacted.push(path);
        } else out[key] = v;
      } else {
        out[key] = v;
      }
    }
    return out;
  };
  const options = walk(schema?.properties, { ...block }, "", 0);
  return { options, redacted, envVars };
}

/**
 * A draft from the Config page with every `REDACTED_SETTING` put back to the
 * stored value at that path (top level, or one object deep); a placeholder
 * with nothing stored behind it is dropped. Everything else is the draft's.
 */
export function restoreRedacted(draft: Readonly<Record<string, unknown>>, stored: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(draft)) {
    if (v === REDACTED_SETTING) {
      if (stored[key] !== undefined) out[key] = stored[key];
    } else if (isPlainObject(v)) {
      const inner = isPlainObject(stored[key]) ? stored[key] as Record<string, unknown> : {};
      out[key] = restoreRedacted(v, inner);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * `packages` with the entry of identity `identity` given `config` (the loader's
 * rule: the first entry with that identity is the one loaded). Other entries,
 * and the entry's own other keys, are kept as they are. Error when no entry has
 * that identity (removed from config.json since the daemon started).
 */
export function setPackageEntryConfig(
  packages: readonly PackageEntry[] | undefined,
  identity: string,
  config: Record<string, unknown>,
  teamDir: string,
): { packages: PackageEntry[] } | { error: string } {
  const list = Array.isArray(packages) ? [...packages] : [];
  const index = list.findIndex((entry) => parsePackageEntries([entry], teamDir).packages[0]?.spec.identity === identity);
  if (index === -1) return { error: `config.json "packages" has no entry for ${identity} any more (restart the daemon to pick up its packages)` };
  const entry = list[index]!;
  list[index] = typeof entry === "string" ? { source: entry, config } : { ...entry, config };
  return { packages: list };
}

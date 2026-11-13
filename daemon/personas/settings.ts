/**
 * daemon/personas/settings.ts — Reading and checking a persona's harness
 * settings: frontmatter `tools`, `skills`, `model`, `requires`
 * (docs/DESIGN.md "Persona settings").
 *
 * The settings are harness-neutral: the daemon only parses, checks and
 * delivers them (the claim's `persona`, the assistant's persona); each harness
 * decides how much it enforces. One function, `readPersonaSettings`, turns a
 * raw value — the frontmatter's YAML subset (shared/frontmatter.ts) or a save
 * request's JSON — into typed `PersonaSettings` *and* the findings about it, so
 * the parser and the linter (daemon/personas/lint.ts) can never disagree on
 * what a field means:
 *
 *  - errors   → a wrong shape (`tools` that isn't a map, a list that isn't a
 *    list of names) or a pattern using glob syntax other than `*`. The offending
 *    field (or pattern) is left out of the typed settings.
 *  - warnings → legal but probably not meant: `deny` cancelling an `allow`
 *    entry, an empty `allow` (no tools at all), an unknown sub-key (ignored).
 *
 * Pure: no I/O.
 */

import type { PersonaRequirements, PersonaSettings, PersonaToolPolicy } from "../../shared/protocol.ts";

/** The raw settings, keyed as in the frontmatter (`PersonaMeta.settings`, or a request body). */
export type RawPersonaSettings = Partial<Record<"tools" | "skills" | "model" | "requires", unknown>>;

/** Typed settings plus what was wrong with the raw ones. */
export interface PersonaSettingsResult {
  settings: PersonaSettings;
  errors: string[];
  warnings: string[];
}

/** Options for `readPersonaSettings`. */
export interface PersonaSettingsOptions {
  /**
   * The model aliases the team config defines. When given, a `model` that
   * names none of them is a warning; when omitted, `model` isn't checked
   * against anything.
   */
  modelAliases?: readonly string[];
}

/** Characters a tool pattern may not contain: glob/regex syntax other than `*`, and spaces. */
const NON_STAR_GLOB = /[?[\]{}()!^$|+\\\s,]/;

/**
 * Turn raw settings into typed `PersonaSettings`, collecting errors and
 * warnings. A field that is absent (or an empty frontmatter value) stays absent.
 */
export function readPersonaSettings(raw: RawPersonaSettings | undefined, opts: PersonaSettingsOptions = {}): PersonaSettingsResult {
  const result: PersonaSettingsResult = { settings: {}, errors: [], warnings: [] };
  if (!raw) return result;
  const tools = readTools(raw.tools, result);
  if (tools) result.settings.tools = tools;
  if (present(raw.skills)) {
    const skills = readNames("skills", raw.skills, result);
    if (skills) {
      result.settings.skills = skills;
      if (skills.length === 0) result.warnings.push("`skills` is empty: the persona may use no skills (leave it out to allow every skill).");
    }
  }
  const model = readModel(raw.model, result, opts);
  if (model) result.settings.model = model;
  const requires = readRequires(raw.requires, result);
  if (requires) result.settings.requires = requires;
  return result;
}

/** Does `text` match `pattern`, where `*` matches any run of characters (and nothing else is special)? */
export function matchesToolPattern(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(text);
}

/** Absent, null, or an empty frontmatter value (`key:` with nothing under it). */
function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A list of non-empty names (trimmed, deduped), or null (with an error) when it isn't one. */
function readNames(field: string, v: unknown, result: PersonaSettingsResult): string[] | null {
  if (!Array.isArray(v)) {
    result.errors.push(`\`${field}\` must be a list of names, e.g. [a, b] (ignored).`);
    return null;
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.trim() === "") {
      result.errors.push(`\`${field}\` must list non-empty names; ${JSON.stringify(item)} is not one (ignored).`);
      continue;
    }
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

function readTools(v: unknown, result: PersonaSettingsResult): PersonaToolPolicy | null {
  if (!present(v)) return null;
  if (!isMap(v)) {
    result.errors.push("`tools` must be a map with `allow` and/or `deny` lists, e.g. { allow: [read], deny: [bash] } (ignored).");
    return null;
  }
  const policy: PersonaToolPolicy = {};
  for (const key of Object.keys(v)) {
    if (key !== "allow" && key !== "deny") result.warnings.push(`\`tools.${key}\` is not a known key (only \`allow\` and \`deny\`); it is ignored.`);
  }
  for (const key of ["allow", "deny"] as const) {
    if (!present(v[key])) continue;
    const names = readNames(`tools.${key}`, v[key], result);
    if (!names) continue;
    policy[key] = names.filter((p) => {
      if (!NON_STAR_GLOB.test(p)) return true;
      result.errors.push(`\`tools.${key}\`: "${p}" — only \`*\` wildcards are supported (no ?, [], {} or spaces); the pattern is ignored.`);
      return false;
    });
  }
  if (!policy.allow && !policy.deny) {
    result.warnings.push("`tools` has neither `allow` nor `deny`: it changes nothing.");
    return null;
  }
  if (policy.allow && policy.allow.length === 0) {
    result.warnings.push("`tools.allow` is empty: the persona may use no tools at all (leave `allow` out to allow every tool).");
  }
  // A deny that covers an allow entry makes that entry dead (deny wins).
  for (const a of policy.allow ?? []) {
    const d = (policy.deny ?? []).find((pattern) => matchesToolPattern(pattern, a));
    if (d !== undefined) result.warnings.push(`\`tools.deny\` "${d}" overrides \`tools.allow\` "${a}" (deny wins), so that allow entry has no effect.`);
  }
  return policy;
}

function readModel(v: unknown, result: PersonaSettingsResult, opts: PersonaSettingsOptions): string | null {
  if (!present(v)) return null;
  if (typeof v !== "string" || /\s/.test(v.trim())) {
    result.errors.push("`model` must be a single model alias (a name without spaces), e.g. strong (ignored).");
    return null;
  }
  const model = v.trim();
  if (opts.modelAliases && !opts.modelAliases.includes(model)) {
    result.warnings.push(`\`model\` "${model}" is not a model alias in the team config; the harness default model is used.`);
  }
  return model;
}

function readRequires(v: unknown, result: PersonaSettingsResult): PersonaRequirements | null {
  if (!present(v)) return null;
  if (!isMap(v)) {
    result.errors.push("`requires` must be a map, e.g. { mcp: [server-name] } (ignored).");
    return null;
  }
  for (const key of Object.keys(v)) {
    if (key !== "mcp") result.warnings.push(`\`requires.${key}\` is not a known key (only \`mcp\`); it is ignored.`);
  }
  if (!present(v.mcp)) return null;
  const mcp = readNames("requires.mcp", v.mcp, result);
  return mcp && mcp.length > 0 ? { mcp } : null;
}

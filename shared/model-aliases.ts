/**
 * shared/model-aliases.ts — Persona model aliases: what a persona's `model`
 * names, and how the daemon turns it into a harness's model id.
 *
 * A persona says *which kind* of model it wants with an alias (frontmatter
 * `model: strong`), never a model id: ids are harness- and machine-specific
 * (`<provider>/<model>` for Pi, something else for another harness), and a
 * persona — often shipped in a package — must stay portable. The team config
 * maps each alias per harness (`TeamConfig.modelAliases`):
 *
 *   "modelAliases": { "pi": { "strong": "<provider>/<model>", "fast": "…" } },
 *   "personaModels": false        // optional: ignore persona models entirely
 *
 * Keyed by harness name, like `harnesses`, but a top-level block of its own
 * rather than `harnesses.<h>.modelAliases`: `harnesses` entries replace the
 * built-in start templates wholesale, so adding aliases there would mean
 * restating a harness's start commands just to name a model.
 *
 * The daemon resolves the alias for the *claiming* harness at claim time
 * (`resolvePersonaModel`) and sends both in the claim's `persona` (`model` +
 * `modelId`); a harness that can switch models applies `modelId` for that
 * work item (docs/DESIGN.md "Persona settings").
 *
 * The team default model lives beside the aliases, keyed by harness the same
 * way (`TeamConfig.defaultModel`, `"defaultModel": { "pi": "<provider>/<model>" }`):
 * `teamDefaultModel` reads it for one harness, `validateDefaultModel` checks a
 * save. The daemon sends it to unpinned agents as a `set-model` with source
 * `default` (daemon/default-model.ts; docs/DESIGN.md "Choosing a Model").
 * Pure: no I/O.
 */

import type { TeamConfig } from "./types.ts";

/** `TeamConfig.modelAliases`: harness name → alias → that harness's model id. */
export type ModelAliases = Record<string, Record<string, string>>;

/** What an alias may look like: a name, no spaces (the persona-lint rule, shared/agent-protocol.ts `PersonaSettings.model`). */
export const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether personas' `model` settings are applied at all (`personaModels`, default on). */
export function personaModelsEnabled(config: Pick<TeamConfig, "personaModels">): boolean {
  return config.personaModels !== false;
}

/**
 * Every alias the team config defines, for any harness, sorted and deduped —
 * what persona lint checks `model` against (an alias unknown to every harness
 * is a typo; one missing for a single harness is reported at claim time).
 */
export function modelAliasNames(config: Pick<TeamConfig, "modelAliases">): string[] {
  const names = new Set<string>();
  for (const map of Object.values(config.modelAliases ?? {})) {
    if (map && typeof map === "object") for (const alias of Object.keys(map)) names.add(alias);
  }
  return [...names].sort();
}

/** The outcome of resolving one persona `model` alias for one harness. */
export interface PersonaModelResolution {
  /** The harness's model id for the alias; null when there is none (unmapped, or persona models are off). */
  modelId: string | null;
  /**
   * Why no model is set although the persona names one — said once on the
   * run's thread. Null when it resolved, and when persona models are switched
   * off (a deliberate choice, not a problem).
   */
  problem: string | null;
}

/**
 * Resolve a persona's `model` alias for `harness` against the team config.
 * Mapped: its model id. Unknown for this harness: no model and a `problem`
 * naming the config key to add. `personaModels: false`: no model, no problem.
 */
export function resolvePersonaModel(
  config: Pick<TeamConfig, "modelAliases" | "personaModels">, alias: string, harness: string,
): PersonaModelResolution {
  if (!personaModelsEnabled(config)) return { modelId: null, problem: null };
  const id = config.modelAliases?.[harness]?.[alias];
  if (typeof id === "string" && id.trim()) return { modelId: id.trim(), problem: null };
  return {
    modelId: null,
    problem: `The persona's model "${alias}" has no mapping for the ${harness} harness in the team config ` +
      `(modelAliases.${harness}.${alias}), so no model was set: this run uses the harness's default model.`,
  };
}

/**
 * Check a `modelAliases` value from a save request: a map of harness → map of
 * alias → non-empty model id, aliases matching `MODEL_ALIAS_PATTERN`. Returns
 * the cleaned map (ids trimmed, empty harness maps dropped) or the first error.
 */
export function validateModelAliases(raw: unknown): { value: ModelAliases } | { error: string } {
  const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isMap(raw)) return { error: "modelAliases must be an object: { \"<harness>\": { \"<alias>\": \"<model id>\" } }" };
  const out: ModelAliases = {};
  for (const [harness, map] of Object.entries(raw)) {
    if (!harness.trim()) return { error: "modelAliases: a harness name can't be empty" };
    if (!isMap(map)) return { error: `modelAliases.${harness} must be an object of alias → model id` };
    const clean: Record<string, string> = {};
    for (const [alias, id] of Object.entries(map)) {
      if (!MODEL_ALIAS_PATTERN.test(alias)) return { error: `modelAliases.${harness}: "${alias}" is not a valid alias (letters, digits, ".", "_", "-"; no spaces)` };
      if (typeof id !== "string" || !id.trim()) return { error: `modelAliases.${harness}.${alias} must be a non-empty model id` };
      clean[alias] = id.trim();
    }
    if (Object.keys(clean).length > 0) out[harness] = clean;
  }
  return { value: out };
}

/** `TeamConfig.defaultModel`: harness name → that harness's default model id. */
export type DefaultModels = Record<string, string>;

/** The team default model for `harness`, or null when none is set (the harness's own default). */
export function teamDefaultModel(config: Pick<TeamConfig, "defaultModel">, harness: string): string | null {
  const id = config.defaultModel?.[harness];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Check a `defaultModel` value from a save request: a map of harness →
 * model id. Ids are trimmed; an empty one drops that harness (no default).
 * Returns the cleaned map or the first error.
 */
export function validateDefaultModel(raw: unknown): { value: DefaultModels } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "defaultModel must be an object: { \"<harness>\": \"<model id>\" }" };
  }
  const out: DefaultModels = {};
  for (const [harness, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!harness.trim()) return { error: "defaultModel: a harness name can't be empty" };
    if (id === null || id === "") continue;
    if (typeof id !== "string") return { error: `defaultModel.${harness} must be a model id (a string)` };
    // The daemon's bound on a model string (daemon/agent-models.ts MAX_MODEL_REF_LENGTH).
    if (id.trim().length > 200) return { error: `defaultModel.${harness} must be at most 200 characters` };
    if (id.trim()) out[harness] = id.trim();
  }
  return { value: out };
}

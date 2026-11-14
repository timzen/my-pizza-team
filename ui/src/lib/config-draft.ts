/**
 * lib/config-draft.ts — The Config page's config.json draft: its shape as the UI
 * edits it, the PUT body built from it, and the small pure rules the tabs apply
 * to it (name-noun normalization, the harness picker's options, the team
 * default model and the persona model alias rows).
 *
 * The draft lives in ConfigPage, above the tabs (components/config/*), so edits
 * on General, Teammates, Models and Triage save together. Kept pure (no React) so the
 * rules are unit-tested (tests/config-draft.test.ts).
 */

import { featuresChanged, type FeatureSourceInfo, type Features } from "./features.ts";

/** The `teammates` block of config.json. */
export interface TeammateConfig {
  nouns?: string[];
}

/** GET /api/config as the Config page edits it (the draft's shape). */
export interface ConfigData {
  port: number;
  /** The terminal container's name (tmux session, herdr workspace) — kept under its old key. */
  tmuxSession: string;
  /** Which terminal backend new windows open in. Unset = tmux; `null` clears it on save. */
  terminal?: "tmux" | "herdr" | null;
  /** Read-only: online agents started under a terminal other than `terminal` (a switch applies to new windows only). */
  agentsOnOtherTerminal?: Array<{ name: string; terminal: string }>;
  defaultWorkflow: string;
  workflows: Record<string, { states: string[] }>;
  autosave: { flushIntervalMinutes: number; commitIntervalHours: number; autoCommit: boolean };
  maxTeammates?: number;
  /** Unset = default (half of maxTeammates); `null` clears an explicit value on save. */
  minTeammates?: number | null;
  teammates?: TeammateConfig;
  defaultNouns?: string[];
  readinessProbe?: string;
  /** The agent env file's path (shared/env-file.ts); "" clears it on save. */
  agentEnvFile?: string;
  /** Auto triage (docs/DESIGN.md "Auto Triage"). Unset = on, hourly, 10 min quiet. */
  triage?: { enabled?: boolean; intervalMinutes?: number; quietMinutes?: number; persona?: string | null };
  /** Opt-ins for unfinished features. `harnesses` allows non-Pi (ACP) teammates. */
  experimental?: { harnesses?: boolean };
  /** Harness spawned when a spawn names none. Unset (or "pi") = Pi. */
  defaultHarness?: string;
  /** Custom harness templates from config.json (read-only here; adds to the picker). */
  harnesses?: Record<string, { teammate: string; leader?: string }>;
  /** The assistant block; only `persona`, edited via PUT /api/assistant/persona, not this draft. */
  assistant?: { persona?: string };
  /** The team default model: harness → model id (shared/model-aliases.ts). `null` clears it on save. */
  defaultModel?: Record<string, string> | null;
  /** Persona model aliases: harness → alias → model id (shared/model-aliases.ts). `null` clears them on save. */
  modelAliases?: Record<string, Record<string, string>> | null;
  /** `false` ignores personas' `model` settings. Unset = on. */
  personaModels?: boolean;
  /** One teammate per directory (exclusive directory leases). Unset = on. */
  exclusiveDirectories?: boolean;
  /** Which work-item kinds are on, defaults applied (docs/DESIGN.md "Feature Toggles"). */
  features?: Features;
  /** Read-only: each kind's active items, which block switching it off. */
  featureUsage?: Record<string, { count: number; description: string }>;
  /** Read-only: each toggle's source, label, and whether it's external (in display order). */
  featureSources?: FeatureSourceInfo[];
}

/** Props every draft-editing card takes: the draft and its setter. */
export interface ConfigDraftProps {
  config: ConfigData;
  setConfig: (c: ConfigData) => void;
}

/**
 * The PUT body for a draft: drops the read-only `featureUsage` and
 * `featureSources`, and sends `features` only when a toggle changed — so
 * saving an unrelated field doesn't write a `features` block into an existing
 * team's config.json (absent = all on).
 */
export function configBody(draft: ConfigData, saved: ConfigData | null): ConfigData {
  const body = { ...draft };
  delete body.featureUsage;
  delete body.featureSources;
  delete body.agentsOnOtherTerminal;
  if (!featuresChanged(draft.features, saved?.features)) delete body.features;
  return body;
}

/**
 * A typed name noun as it's stored: lower-cased, every character outside
 * `[a-z0-9-]` turned into `-`, one leading/trailing `-` trimmed. Empty = nothing
 * to add.
 */
export function normalizeNoun(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "");
}

/** Built-in harnesses, Pi first; config.json may add custom ones (`harnesses.*`). */
export const BUILT_IN_HARNESSES: Array<{ value: string; label: string }> = [
  { value: "pi", label: "Pi" },
  { value: "kiro", label: "Kiro (experimental)" },
  { value: "claude", label: "Claude Code (experimental)" },
];

/**
 * The Default Harness picker's options: the built-ins, then each custom
 * `harnesses.*` entry that defines a teammate command and doesn't shadow a
 * built-in, labelled "(custom)".
 */
export function harnessOptions(harnesses: ConfigData["harnesses"]): Array<{ value: string; label: string }> {
  const custom = Object.keys(harnesses ?? {})
    .filter((h) => !BUILT_IN_HARNESSES.some((b) => b.value === h) && harnesses?.[h]?.teammate)
    .map((h) => ({ value: h, label: `${h} (custom)` }));
  return [...BUILT_IN_HARNESSES, ...custom];
}

/** The terminal backends the Terminal picker offers (shared/types.ts `TERMINAL_KINDS`); tmux first, the default. */
export const TERMINAL_OPTIONS: Array<{ value: "tmux" | "herdr"; label: string }> = [
  { value: "tmux", label: "tmux (default)" },
  { value: "herdr", label: "herdr" },
];

/**
 * The Terminal field's warning, or null: a `terminal` switch applies to new windows
 * only, so say so — when the draft changes it (agents already running stay where
 * they are), and while agents started under another terminal are still online
 * (`agentsOnOtherTerminal`, relative to the saved setting).
 */
export function terminalSwitchWarning(draft: ConfigData, saved: ConfigData | null): string | null {
  const draftTerminal = draft.terminal || "tmux";
  const savedTerminal = saved ? saved.terminal || "tmux" : draftTerminal;
  if (draftTerminal !== savedTerminal) {
    return `Applies to new windows only: agents already running stay in ${savedTerminal}.`;
  }
  const others = saved?.agentsOnOtherTerminal ?? [];
  if (others.length === 0) return null;
  const list = others.map((a) => `${a.name} (${a.terminal})`).join(", ");
  return `${others.length === 1 ? "1 agent is" : `${others.length} agents are`} still running under another terminal: ${list}. New windows open in ${draftTerminal}.`;
}

/** One row of the Persona Models editor: a harness's alias and the model id it maps to. */
export interface ModelAliasRow {
  harness: string;
  alias: string;
  modelId: string;
}

/** The draft's `modelAliases` as editor rows, sorted by harness then alias. */
export function modelAliasRows(aliases: ConfigData["modelAliases"]): ModelAliasRow[] {
  const rows: ModelAliasRow[] = [];
  for (const [harness, map] of Object.entries(aliases ?? {})) {
    for (const [alias, modelId] of Object.entries(map ?? {})) rows.push({ harness, alias, modelId });
  }
  return rows.sort((a, b) => a.harness.localeCompare(b.harness) || a.alias.localeCompare(b.alias));
}

/** An alias as the daemon accepts it (shared/model-aliases.ts MODEL_ALIAS_PATTERN). */
export function isValidModelAlias(alias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias);
}

/**
 * `aliases` with `harness`'s `alias` set to `modelId`, or removed when
 * `modelId` is null. A harness left with no aliases is dropped, and no aliases
 * at all is `null`, which clears the block on save.
 */
export function setModelAlias(
  aliases: ConfigData["modelAliases"], harness: string, alias: string, modelId: string | null,
): Record<string, Record<string, string>> | null {
  const next: Record<string, Record<string, string>> = {};
  for (const [h, map] of Object.entries(aliases ?? {})) next[h] = { ...map };
  if (modelId === null) {
    const map = next[harness];
    if (map) delete map[alias];
  } else {
    next[harness] = { ...next[harness], [alias]: modelId };
  }
  for (const h of Object.keys(next)) if (Object.keys(next[h] ?? {}).length === 0) delete next[h];
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * `defaults` with `harness`'s team default model set to `modelId` (trimmed),
 * or removed when it's null or blank. No defaults at all is `null`, which
 * clears the block on save.
 */
export function setDefaultModel(
  defaults: ConfigData["defaultModel"], harness: string, modelId: string | null,
): Record<string, string> | null {
  const next: Record<string, string> = { ...(defaults ?? {}) };
  const id = modelId?.trim() ?? "";
  if (id) next[harness] = modelId!; // kept as typed while editing; the daemon trims on save
  else delete next[harness];
  return Object.keys(next).length > 0 ? next : null;
}

/** Do two `defaultModel` values name the same models (blank/absent alike)? What "Apply to all teammates now" needs saved first. */
export function sameDefaultModels(a: ConfigData["defaultModel"], b: ConfigData["defaultModel"]): boolean {
  const clean = (m: ConfigData["defaultModel"]) =>
    Object.entries(m ?? {}).map(([h, id]) => [h, id.trim()] as const).filter(([, id]) => id).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

/**
 * The harnesses the Default Model card shows a row for: Pi always, then every
 * harness with a default set or a live agent reporting models, in that order
 * and without repeats.
 */
export function defaultModelHarnesses(defaults: ConfigData["defaultModel"], live: Iterable<string>): string[] {
  const out = ["pi"];
  for (const h of [...Object.keys(defaults ?? {}), ...live]) if (!out.includes(h)) out.push(h);
  return out;
}

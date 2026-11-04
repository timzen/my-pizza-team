/**
 * lib/config-draft.ts — The Config page's config.json draft: its shape as the UI
 * edits it, the PUT body built from it, and the small pure rules the tabs apply
 * to it (name-noun normalization, the harness picker's options).
 *
 * The draft lives in ConfigPage, above the tabs (components/config/*), so edits
 * on General, Teammates and Triage save together. Kept pure (no React) so the
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
  tmuxSession: string;
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
  /** How the user talks to the assistant. Unset (or unknown) chatMode = "chat". */
  assistant?: { chatMode?: "chat" | "terminal"; persona?: string };
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

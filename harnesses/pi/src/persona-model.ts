// The active persona's model (frontmatter `model`, an alias the team config maps).
//
// A persona may ask for a kind of model (my-pizza-team docs/DESIGN.md "Persona
// settings"): `model: strong`. The daemon resolves the alias for this harness
// (team config `modelAliases.pi`) and delivers the model id with the persona —
// `modelId` in the claim for a teammate, in the assistant persona response for
// the leader. This module is how the Pi harness applies it:
//
//   - `PersonaModelSwitch.apply` switches the session's model (`pi.setModel`)
//     once per key — a work item for a teammate, the persona for the leader —
//     so a later `/model` by someone pairing is not fought on every run. A new
//     key first puts the previous model back, so one item's model never leaks
//     into the next.
//   - `restore` puts back the model that was active before the first switch;
//     called when the item ends, and by `apply` when no persona model is held.
//   - What can't be applied is returned as a problem for the caller to report
//     once (a thread comment for a teammate, a UI warning for the leader): an id
//     this Pi doesn't know, an ambiguous bare id, or a model `setModel` refuses
//     (no credentials for its provider). The current model is then kept.
//
// An unmapped alias never reaches here as a model: the daemon sends `modelId:
// null` and comments on the thread itself (the leader gets `modelProblem`).
// The usage ledger and the Team tab need nothing extra: a run's usage carries
// the model its assistant messages record (runtime/usage.ts), and `setModel`
// fires `model_select`, which re-reports the session stats.
//
// Type-only imports on purpose: like persona-scope.ts, this module loads
// standalone under Node's type stripping, which is what lets tests import it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A model as this module needs it: Pi's `Model` has these (and more). */
export interface ModelRef {
  provider: string;
  id: string;
}

/** The slice of Pi's model registry `findModel` reads (`ctx.modelRegistry`). */
export interface ModelLookup {
  find(provider: string, modelId: string): ModelRef | undefined;
  getAll(): ModelRef[];
}

/** The slice of Pi's extension context the switch reads: the live model and the registry. */
export interface ModelContext {
  readonly model: ModelRef | undefined;
  readonly modelRegistry: ModelLookup;
}

/** The slice of a persona this module reads: its id, alias and resolved model id. */
export interface ModelPersona {
  id: string | null;
  model?: string;
  modelId?: string | null;
}

/** `provider/id`, how models are named in reports. */
export function modelName(model: ModelRef | undefined | null): string {
  return model ? `${model.provider}/${model.id}` : "(none)";
}

function sameModel(a: ModelRef | undefined | null, b: ModelRef | undefined | null): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Look a configured model id up in Pi's registry: `<provider>/<model>` (the
 * form `--model` and `/model` use), else a bare model id when exactly one
 * provider has it. Returns the model, or why there is none.
 */
export function findModel(registry: ModelLookup, modelId: string): { model: ModelRef } | { problem: string } {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const model = registry.find(modelId.slice(0, slash), modelId.slice(slash + 1))
      ?? registry.getAll().find((m) => modelName(m) === modelId);
    return model ? { model } : { problem: `"${modelId}" isn't a model this Pi knows` };
  }
  const matches = registry.getAll().filter((m) => m.id === modelId);
  if (matches.length === 1) return { model: matches[0]! };
  if (matches.length > 1) {
    return { problem: `"${modelId}" names a model of several providers (${matches.map(modelName).join(", ")}); map the alias to <provider>/<model>` };
  }
  return { problem: `"${modelId}" isn't a model this Pi knows` };
}

/**
 * Switches the session's model to the held persona's for as long as it is
 * held, and back afterwards. One per session (a fresh session starts on Pi's
 * configured default model anyway).
 */
export class PersonaModelSwitch {
  /** The model active before the persona's, while a persona model is applied. */
  private previous: ModelRef | null = null;
  /** The key `apply` last handled (null: nothing held). */
  private appliedKey: string | null = null;

  private readonly pi: Pick<ExtensionAPI, "setModel">;
  private readonly ctx: ModelContext;

  constructor(pi: Pick<ExtensionAPI, "setModel">, ctx: ModelContext) {
    this.pi = pi;
    this.ctx = ctx;
  }

  /** True while a persona's model is in place of the previous one. */
  get switched(): boolean {
    return this.previous !== null;
  }

  /**
   * Apply `persona`'s model for `key` (a work item id, or the leader's persona
   * id). Idempotent per key: a repeat call does nothing, so a manual model change
   * within the item stands. A different key restores first. No persona model
   * (none held, no `modelId`) restores. Returns a problem to report, or null.
   */
  async apply(key: string | null, persona: ModelPersona | null): Promise<string | null> {
    const modelId = persona?.modelId;
    if (!key || !persona || !modelId) {
      await this.restore();
      return null;
    }
    if (key === this.appliedKey) return null;
    await this.restore();
    this.appliedKey = key;
    const who = `persona ${persona.id ?? "(unnamed)"}`;
    const alias = persona.model ? `model "${persona.model}" (${modelId})` : `model ${modelId}`;
    const current = this.ctx.model;
    const found = findModel(this.ctx.modelRegistry, modelId);
    if ("problem" in found) return `${who}: ${alias} can't be used: ${found.problem}; keeping ${modelName(current)}.`;
    if (sameModel(current, found.model)) return null;
    let ok = false;
    try {
      ok = await this.pi.setModel(found.model as Parameters<ExtensionAPI["setModel"]>[0]);
    } catch {
      ok = false;
    }
    if (!ok) return `${who}: ${alias} can't be used: Pi couldn't switch to it (no credentials for ${found.model.provider}?); keeping ${modelName(current)}.`;
    this.previous = current ?? null;
    return null;
  }

  /** Put back the model that was active before the persona's (if one was switched in). */
  async restore(): Promise<void> {
    this.appliedKey = null;
    const previous = this.previous;
    if (!previous) return;
    this.previous = null;
    if (sameModel(this.ctx.model, previous)) return;
    try {
      await this.pi.setModel(previous as Parameters<ExtensionAPI["setModel"]>[0]);
    } catch {
      // Best-effort: the next fresh session starts on Pi's default model anyway.
    }
  }
}

// The agent's model: which one it should be on, and the `set-model` directive.
//
// my-pizza-team docs/DESIGN.md "Choosing a Model". Model ids are opaque to the
// daemon; this harness reports what it can use and resolves the rest:
//
//   - `availableModels` — the models Pi lists as available (configured, with
//     credentials: `modelRegistry.getAvailable()`), as `AvailableModel`s whose
//     `ref` is `provider/id`, the form Pi accepts back. Sent at registration and
//     again whenever the list changes (`ModelListReporter`).
//   - `ModelPreferences.resolve` — **the one place** the effective model is
//     decided:
//
//         failover ?? pin ?? persona model ?? team default ?? Pi's default
//
//     The pin is the user's choice for this agent (a done `set-model` with
//     source `user`; the daemon keeps it and sends it back as `modelPin` at every
//     registration, so it outlives the session). The persona's model is the
//     claim's `modelId` for a teammate (for that work item only) or the
//     assistant persona's for the leader. The team default and the failover
//     substitute are set by `set-model` with source `default` / `failover`.
//     Null means "Pi's own default": the switch (persona-model.ts) puts back
//     the model it started on.
//   - `SetModelRealizer` — carries out `set-model` directives **between runs**:
//     one arriving while a run is in flight waits for it to settle
//     (`agent_settled`, after Pi's own retries and follow-ups), then the model
//     is checked (`modelProblem`: known and available), the preference set and
//     the effective model re-applied, and the directive marked done — or
//     failed with the reason, the preference left as it was.
//
// Type-only imports on purpose: like persona-model.ts, this module loads
// standalone under Node's type stripping, which is what lets tests import it.

import type { AvailableModel, SetModelSource } from "./shared/agent-protocol.js";
import type { ModelLookup, ModelPersona, ModelRef, ModelTarget } from "./persona-model.js";

/** Where the effective model came from (`ModelPreferences.resolve`). */
export type ModelOrigin = "failover" | "pin" | "persona" | "default";

/** The resolved model, with where it came from. */
export type EffectiveModel = ModelTarget & { origin: ModelOrigin };

/** The preference slot each `set-model` source writes. */
const ORIGIN_OF: Record<SetModelSource, ModelOrigin> = { user: "pin", default: "default", failover: "failover" };

/** A Pi model as the daemon is told about it (`ref` = `provider/id`, what Pi accepts back). */
function toAvailable(m: ModelRef & { name?: string }): AvailableModel {
  return { ref: `${m.provider}/${m.id}`, id: m.id, name: m.name || m.id, provider: m.provider };
}

/**
 * The models this Pi can use now: `getAvailable()` (those with auth/config, not
 * the whole catalogue), sorted by ref so a report only changes when the set
 * does. Empty when the registry can't say.
 */
export function availableModels(registry: ModelLookup | undefined): AvailableModel[] {
  let models: Array<ModelRef & { name?: string }> = [];
  try { models = registry?.getAvailable?.() ?? []; } catch { models = []; }
  return models.map(toAvailable).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Same list (refs and names, in order)? Skips re-sending an unchanged report. */
export function sameModelList(a: AvailableModel[] | null, b: AvailableModel[]): boolean {
  return !!a && a.length === b.length && a.every((m, i) => m.ref === b[i]!.ref && m.name === b[i]!.name);
}

/**
 * Re-sends the available models when they change. `check` is cheap (a registry
 * read), so it runs on every settled run and model switch.
 */
export class ModelListReporter {
  private last: AvailableModel[] | null;
  private readonly send: (models: AvailableModel[]) => unknown;

  /** `initial`: what registration already sent (null: nothing yet). */
  constructor(send: (models: AvailableModel[]) => unknown, initial: AvailableModel[] | null) {
    this.send = send;
    this.last = initial;
  }

  /** Report `registry`'s list if it differs from the last one sent. */
  check(registry: ModelLookup | undefined): void {
    const now = availableModels(registry);
    if (sameModelList(this.last, now)) return;
    this.last = now;
    this.send(now);
  }
}

/**
 * This agent's model preferences, and the effective model they resolve to. One
 * per harness instance; the pin is seeded from the registration reply.
 */
export class ModelPreferences {
  /** The user's pin (source `user`). */
  pin: string | null = null;
  /** The team default (source `default`). */
  teamDefault: string | null = null;
  /** The failover substitute (source `failover`), which wins over everything while set. */
  failover: string | null = null;

  /** The preference a `set-model` source writes. */
  get(source: SetModelSource): string | null {
    const origin = ORIGIN_OF[source];
    return origin === "pin" ? this.pin : origin === "default" ? this.teamDefault : this.failover;
  }

  /** Set (or, with null, clear) the preference a `set-model` source writes. */
  set(source: SetModelSource, model: string | null): void {
    const origin = ORIGIN_OF[source];
    if (origin === "pin") this.pin = model;
    else if (origin === "default") this.teamDefault = model;
    else this.failover = model;
  }

  /**
   * The effective model: failover ?? pin ?? persona model ?? team default, or
   * null for Pi's default. `scope` is what a persona's model is held for — the
   * work item (teammate) or the persona id (leader); null when nothing is held,
   * so the persona's model doesn't apply. The key makes the switch idempotent:
   * the pin's is the same across work items (no switch back and forth between
   * items), the persona's is per scope.
   */
  resolve(scope: string | null, persona: ModelPersona | null): EffectiveModel | null {
    if (this.failover) {
      return { origin: "failover", modelId: this.failover, key: `failover|${this.failover}`, who: "failover", label: `model ${this.failover}` };
    }
    if (this.pin) {
      return { origin: "pin", modelId: this.pin, key: `pin|${this.pin}`, who: "pinned model", label: `model ${this.pin}` };
    }
    const personaModel = persona?.modelId;
    if (scope !== null && persona && personaModel) {
      return {
        origin: "persona",
        modelId: personaModel,
        key: `${scope}|persona|${personaModel}`,
        who: `persona ${persona.id ?? "(unnamed)"}`,
        label: persona.model ? `model "${persona.model}" (${personaModel})` : `model ${personaModel}`,
      };
    }
    if (this.teamDefault) {
      return { origin: "default", modelId: this.teamDefault, key: `default|${this.teamDefault}`, who: "team default", label: `model ${this.teamDefault}` };
    }
    return null;
  }
}

/** A `set-model` directive as the realizer needs it. */
export interface SetModelDirective {
  id: string;
  params: Record<string, unknown>;
}

/** What `SetModelRealizer` is wired to. */
export interface SetModelRealizerDeps {
  prefs: ModelPreferences;
  /** Why this Pi can't use `modelId` now, or null (persona-model.ts `modelProblem`). */
  check(modelId: string): string | null;
  /** Re-apply the effective model; says which origin won and any problem switching to it. */
  apply(): Promise<{ origin: ModelOrigin | null; problem: string | null }>;
  /** Mark the directive done or failed (with the reason). */
  complete(id: string, status: "done" | "failed", error?: string): Promise<unknown>;
  log?(message: string): void;
}

/** A directive's params read as set-model's, or null when they aren't. */
function readParams(params: Record<string, unknown>): { model: string | null; source: SetModelSource } | null {
  const source = params.source === "user" || params.source === "default" || params.source === "failover" ? params.source : null;
  if (!source) return null;
  if (params.model === null) return { model: null, source };
  if (typeof params.model !== "string" || !params.model.trim()) return null;
  return { model: params.model.trim(), source };
}

/**
 * Carries out `set-model` directives between runs. Wire `runStarted` to
 * `agent_start` and `runSettled` to `agent_settled`, and hand every polled
 * set-model to `offer` (repeat offers of one id are ignored, so a poll while it
 * waits is harmless).
 */
export class SetModelRealizer {
  private readonly deps: SetModelRealizerDeps;
  private busy = false;
  private stopped = false;
  private flushing = false;
  private readonly waiting: SetModelDirective[] = [];
  /** Ids offered and not yet reported back (a failed report forgets one, so the next poll retries it). */
  private readonly seen = new Set<string>();

  constructor(deps: SetModelRealizerDeps) {
    this.deps = deps;
  }

  /** Directives waiting for the run in flight to end. */
  get pending(): number {
    return this.waiting.length;
  }

  /** A run started: directives offered from now on wait for it to settle. */
  runStarted(): void {
    this.busy = true;
  }

  /** The run settled (Pi won't continue on its own): realize what waited. */
  async runSettled(): Promise<void> {
    if (this.stopped) return;
    this.busy = false;
    await this.flush();
  }

  /**
   * This harness instance is going away (session_shutdown): realize nothing
   * more. What waited stays pending at the daemon, for the next instance.
   */
  stop(): void {
    this.busy = true;
    this.stopped = true;
    this.waiting.length = 0;
  }

  /** Take a polled `set-model` directive: realized now when idle, else after the run. */
  async offer(directive: SetModelDirective): Promise<void> {
    if (this.stopped || this.seen.has(directive.id)) return;
    this.seen.add(directive.id);
    this.waiting.push(directive);
    if (this.busy) this.deps.log?.(`set-model ${directive.id}: waiting for the run in flight to end`);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.busy && this.waiting.length > 0) await this.realize(this.waiting.shift()!);
    } finally {
      this.flushing = false;
    }
  }

  private async realize(directive: SetModelDirective): Promise<void> {
    const { prefs } = this.deps;
    const params = readParams(directive.params || {});
    let error: string | null = null;
    if (!params) error = "set-model needs { model: string | null, source: \"user\" | \"failover\" | \"default\" }";
    else if (params.model !== null) error = this.deps.check(params.model);
    if (!error && params) {
      const before = prefs.get(params.source);
      prefs.set(params.source, params.model);
      const res = await this.deps.apply();
      // Only a problem with *this* choice fails it (a cleared pin falling back to
      // a persona model this Pi can't use is that persona's problem, reported as such).
      if (res.problem && res.origin === ORIGIN_OF[params.source]) {
        error = res.problem;
        prefs.set(params.source, before);
        await this.deps.apply();
      }
    }
    this.deps.log?.(`set-model ${directive.id}: ${error ? `failed — ${error}` : "done"}`);
    try {
      await (error ? this.deps.complete(directive.id, "failed", error) : this.deps.complete(directive.id, "done"));
    } catch {
      this.seen.delete(directive.id); // unreachable daemon: the next poll offers it again (realizing is idempotent)
    }
  }
}

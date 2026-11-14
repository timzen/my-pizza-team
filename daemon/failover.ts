/**
 * daemon/failover.ts — The team-wide model failover (docs/DESIGN.md "Model
 * Failover"): a chain of models the whole team falls back through when calls
 * to the current one keep being throttled or failing with 5xx, and the
 * automatic revert to the primary.
 *
 * One state for the team (throttling is usually account-wide), persisted in
 * the `settings` table (`failover.state`) so it survives a restart. The policy
 * is `TeamConfig.failover`, read live through `resolveFailover`; with it off
 * (the default) nothing here does anything and the daemon behaves as before.
 *
 *   - **Trip** (`recordFailure`, from the errored-session route): a failure of
 *     an `on` kind on the chain's *current* entry (resolved for the failing
 *     agent's harness through `modelAliases`) is counted; `after` of them within
 *     `windowMinutes`, across all agents, switch the team to the next entry.
 *     A failure on any other model is not counted (an agent still running a
 *     model the team already left, or one outside the chain); one whose model
 *     the daemon can't tell counts against the current entry. `auth` and
 *     `context` never count, whatever `on` says.
 *   - **Substitute**: while active, every failed entry (chain[0 .. current-1])
 *     is replaced by the current one. The agents are told with a `set-model`
 *     (source `failover`, `replaces` = the failed models): a harness that
 *     declared `MODEL_FAILOVER_CAPABILITY` applies it only while the model it
 *     resolves (pin ?? persona ?? default ?? its own) is a failed one, so every
 *     live one of those is sent it; an older set-model harness applies it
 *     unconditionally, so it is sent one only when the daemon's view of its
 *     model (pin ?? team default ?? the session's model) is a failed one. The
 *     claim's persona model is substituted too (`claimModel`), for any harness.
 *   - **Retry now**: on each switch, retries held in backoff after a failure
 *     of an `on` kind are released (QueueStore `releaseRetriesFor`): their
 *     `retryAt` moves to now, nothing else — see that method for the
 *     attempt-count rule.
 *   - **Escalate**: the substitute tripping moves to the next entry; at the end
 *     of the chain the team stays on the last entry (`exhausted`) and the
 *     normal retry and readiness handling carries on.
 *   - **Revert** (half-open): `revertAfterMinutes` after a switch, the next
 *     claim by a failover-capable agent is the probe — it runs on the primary
 *     (`AgentClaimResponse.failoverProbe`). A run whose model call works
 *     (COMPLETE, WAITED, or a FAILED the agent chose) ends the failover; a
 *     failure of an `on` kind re-arms the timer. Any other ending (auth,
 *     context, cancelled) says nothing about the primary: the next claim
 *     probes again.
 *   - **End** (`end`): a probe's success, "End failover now" (POST
 *     /api/failover/end), or the policy being switched off or its chain no
 *     longer reaching the current entry. Every agent that was sent a
 *     substitute is sent `model: null` (source `failover`).
 *
 * What it did is told through `deps.onEvent` (wired to daemon/failover-notes.ts
 * by the Store): one event per trip, escalation, exhaustion and end — never one
 * per agent — which become the episode's Inbox note, plus `retried` (a claim
 * whose run moves to the substitute, once per thread and chain entry) and the
 * probe of an `ended` revert, which become thread comments.
 *
 * No timers: the probe is due lazily, when a claim comes; the clock is
 * injectable (`deps.now`) so tests run on a fake one.
 */

import { resolveFailover, DEFAULT_HARNESS, FAILOVER_TRIP_KINDS, type Member, type ResolvedFailover, type TeamConfig, type WorkItemState } from "../shared/types.ts";
import { resolveChainEntry } from "../shared/failover.ts";
import { MODEL_FAILOVER_CAPABILITY, SET_MODEL_CAPABILITY, type ModelErrorKind, type SetModelParams } from "../shared/agent-protocol.ts";
import type { FailoverView } from "../shared/protocol.ts";
import { teamDefaultModel } from "../shared/model-aliases.ts";

/** The `settings` key the state is persisted under. */
export const FAILOVER_STATE_KEY = "failover.state";

/** One counted failure. */
interface FailureRecord {
  at: number;
  /** The chain index it was counted against. */
  index: number;
  kind: ModelErrorKind;
  memberId: string;
}

/** The persisted failover state (JSON in `settings`). */
interface FailoverState {
  /** The chain index in use: 0 = the primary (no failover). */
  index: number;
  /** When the current failover first tripped. */
  since: number | null;
  trips: Array<{ at: number; from: string; to: string; kind: ModelErrorKind; failures: number }>;
  /** When the next claim becomes the revert probe. */
  nextProbeAt: number | null;
  probe: { workItemId: string; memberId: string; startedAt: number } | null;
  exhausted: boolean;
  /** Agents sent a substitute (each is sent `model: null` at the end). */
  notified: string[];
  /** Failures counted toward the next trip. */
  failures: FailureRecord[];
  /** `<workDefId>@<index>` of each thread told its retry moved to the substitute (once each). */
  retried: string[];
}

/** No failover. */
function idle(): FailoverState {
  return { index: 0, since: null, trips: [], nextProbeAt: null, probe: null, exhausted: false, notified: [], failures: [], retried: [] };
}

/** What the failover needs from the Store (wired in its constructor). */
export interface FailoverDeps {
  /** The live team config (its `failover`, `modelAliases`, `defaultModel`). */
  config: TeamConfig;
  /** The persisted state, or null for none. */
  load(): string | null;
  /** Persist the state (null clears it). */
  save(value: string | null): void;
  getMembers(): Member[];
  getMember(id: string): Member | null;
  hasCapability(memberId: string, capability: string): boolean;
  getModelPin(memberId: string): string | null;
  /** The model the agent's session reports running (an opaque ref), or null. */
  currentModel(memberId: string): string | null;
  /** Send a failover `set-model`, superseding only an earlier pending failover one. True when sent. */
  sendFailoverModel(memberId: string, params: SetModelParams): boolean;
  /** A WorkItem's state, or null when it doesn't exist. */
  workItemState(id: string): WorkItemState | null;
  /** Release retries held after a failure of one of `kinds` (QueueStore `releaseRetriesFor`). */
  releaseRetries(kinds: readonly ModelErrorKind[], now: number): string[];
  /**
   * For a retry (attempt > 1): its WorkDef and the error kind of the attempt it
   * follows; null for a first attempt or one whose cause isn't known.
   */
  retryOf?(workItemId: string): { workDefId: string; kind: ModelErrorKind } | null;
  /** Tell the team what happened (the Inbox note, thread comments). */
  onEvent?(event: FailoverEvent): void;
  /** The clock (ms). */
  now(): number;
  log?(message: string): void;
}

/**
 * What the failover did, for the people watching (daemon/failover-notes.ts).
 * `episode` is when the failover first tripped (ms): it names the episode's
 * one Inbox note. Model names are chain entries (ids or aliases) as configured.
 */
export type FailoverEvent =
  /** The team switched `from` → `to`; `escalated` when it was already failed over. */
  | { type: "tripped"; episode: number; at: number; from: string; to: string; kind: ModelErrorKind; failures: number; escalated: boolean }
  /** The last chain entry is failing too: the team stays on it. */
  | { type: "exhausted"; episode: number; at: number; model: string; kind: ModelErrorKind }
  /** A claimed retry runs on `to` because its last attempt failed (`kind`) on the failed `from`. */
  | { type: "retried"; workItemId: string; from: string; to: string; kind: ModelErrorKind }
  /** Back on `primary`: the probe `probeWorkItemId` worked, or it was ended (`reason`). */
  | { type: "ended"; episode: number; at: number; primary: string; reason: string; probeWorkItemId: string | null };

/** A model failure as the errored-session route reports it. */
export interface ModelFailure {
  memberId: string;
  workItemId: string;
  kind: ModelErrorKind;
  /** The model the failed call was on (opaque), or null when unknown. */
  model: string | null;
}

/** What `recordFailure` did. */
export type FailureOutcome =
  | { action: "ignored" }
  | { action: "counted"; failures: number }
  | { action: "tripped"; from: string; to: string; released: string[] }
  | { action: "exhausted" }
  | { action: "probe-failed"; nextProbeAt: number }
  | { action: "probe-inconclusive" };

/** The claim's model, after the failover had its say (`claimModel`). */
export interface ClaimModel {
  /** The persona's model id, substituted when it was a failed one. */
  modelId: string | null;
  /** Set when this claim is the revert probe: run on this model (the primary, for this harness). */
  probe?: { modelId: string };
}

/** Item states in which a probe is still running. */
const IN_FLIGHT: readonly WorkItemState[] = ["IN_PROGRESS", "MORIBUND"];

export class ModelFailover {
  private readonly deps: FailoverDeps;
  private state: FailoverState;

  constructor(deps: FailoverDeps) {
    this.deps = deps;
    this.state = this.read();
  }

  /** The policy, defaults applied (live: config edits apply at once). */
  private get policy(): ResolvedFailover {
    return resolveFailover(this.deps.config);
  }

  /** The kinds that may trip: the policy's `on`, never auth or context. */
  private get tripKinds(): ModelErrorKind[] {
    return this.policy.on.filter((k) => FAILOVER_TRIP_KINDS.includes(k));
  }

  /** Is a failover in effect? */
  get active(): boolean {
    this.reconcile();
    return this.state.index > 0;
  }

  /** The state as GET /api/failover reports it. */
  view(): FailoverView {
    this.reconcile();
    const p = this.policy;
    const s = this.state;
    const active = s.index > 0;
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const windowStart = this.deps.now() - p.windowMinutes * 60_000;
    return {
      enabled: p.enabled,
      active,
      from: active ? p.chain[0]! : null,
      to: active ? p.chain[s.index]! : null,
      replaces: active ? p.chain.slice(0, s.index) : [],
      since: iso(s.since),
      trips: s.trips.map((t) => ({ ...t, at: new Date(t.at).toISOString() })),
      nextProbeAt: active ? iso(s.nextProbeAt) : null,
      probe: s.probe ? { workItemId: s.probe.workItemId, memberId: s.probe.memberId, startedAt: new Date(s.probe.startedAt).toISOString() } : null,
      exhausted: s.exhausted,
      recentFailures: s.failures.filter((f) => f.at > windowStart && f.index === s.index).length,
    };
  }

  /**
   * A run's model call failed (the errored-session route, after the retry is
   * scheduled). Counts it, and trips, escalates, or settles a probe. A no-op
   * while the policy is off.
   */
  recordFailure(failure: ModelFailure): FailureOutcome {
    this.reconcile();
    const p = this.policy;
    if (!p.enabled) return { action: "ignored" };
    const now = this.deps.now();
    const s = this.state;
    const tripKind = this.tripKinds.includes(failure.kind);

    // The probe's own outcome: a trip kind means the primary is still failing.
    if (s.probe && s.probe.workItemId === failure.workItemId) {
      s.probe = null;
      if (tripKind) {
        s.nextProbeAt = now + p.revertAfterMinutes * 60_000;
        this.write();
        this.deps.log?.(`failover: probe on ${p.chain[0]} failed (${failure.kind}); next probe at ${new Date(s.nextProbeAt).toISOString()}`);
        return { action: "probe-failed", nextProbeAt: s.nextProbeAt };
      }
      this.write();
      return { action: "probe-inconclusive" };
    }
    if (!tripKind || p.chain.length === 0) return { action: "ignored" };

    // Only failures on the current entry count (resolved for the agent's harness).
    const harness = this.deps.getMember(failure.memberId)?.harness || DEFAULT_HARNESS;
    const current = resolveChainEntry(this.deps.config, p.chain[s.index]!, harness);
    if (failure.model !== null && failure.model !== current) return { action: "ignored" };

    const windowStart = now - p.windowMinutes * 60_000;
    s.failures = s.failures.filter((f) => f.at > windowStart && f.index === s.index);
    s.failures.push({ at: now, index: s.index, kind: failure.kind, memberId: failure.memberId });
    if (s.failures.length < p.after) {
      this.write();
      return { action: "counted", failures: s.failures.length };
    }
    if (s.index + 1 >= p.chain.length) {
      // The chain is used up: stay on the last entry; normal retries carry on.
      s.failures = [];
      const changed = !s.exhausted;
      s.exhausted = true;
      this.write();
      if (changed) {
        this.deps.log?.(`failover: ${p.chain[s.index]} is failing too and the chain is exhausted; staying on it`);
        if (s.index > 0) this.deps.onEvent?.({ type: "exhausted", episode: s.since ?? now, at: now, model: p.chain[s.index]!, kind: failure.kind });
      }
      return { action: "exhausted" };
    }
    const from = p.chain[s.index]!;
    const to = p.chain[s.index + 1]!;
    const failures = s.failures.length;
    const escalated = s.index > 0;
    s.trips.push({ at: now, from, to, kind: failure.kind, failures });
    s.index += 1;
    s.since ??= now;
    s.failures = [];
    s.probe = null;
    s.nextProbeAt = now + p.revertAfterMinutes * 60_000;
    this.write();
    this.deps.log?.(`failover: ${from} tripped (${failure.kind}); the team switches to ${to}`);
    this.notifyAll(`failover: ${from} is ${failure.kind === "throttle" ? "throttled" : "failing"}`);
    this.deps.onEvent?.({ type: "tripped", episode: s.since, at: now, from, to, kind: failure.kind, failures, escalated });
    const released = this.deps.releaseRetries(this.tripKinds, now);
    return { action: "tripped", from, to, released };
  }

  /**
   * A work item ended with a working model call (COMPLETE, WAITED, or a FAILED
   * the agent chose). When it was the probe, the primary is back: the failover
   * ends. True when it did.
   */
  recordSuccess(workItemId: string): boolean {
    if (!this.state.probe || this.state.probe.workItemId !== workItemId) return false;
    this.deps.log?.(`failover: probe ${workItemId} on ${this.policy.chain[0] ?? "the primary"} worked; failover ends`);
    this.finish("the probe worked", workItemId);
    return true;
  }

  /**
   * The model a claim's work runs on, as far as the failover is concerned:
   * `personaModelId` substituted when it is a failed entry, or — when the
   * revert timer has run out and this agent can take one — the probe, which
   * runs on the primary. Records the probe.
   */
  claimModel(memberId: string, workItemId: string, personaModelId: string | null): ClaimModel {
    this.reconcile();
    const s = this.state;
    if (s.index === 0) return { modelId: personaModelId };
    const p = this.policy;
    const now = this.deps.now();
    const harness = this.deps.getMember(memberId)?.harness || DEFAULT_HARNESS;
    // A probe whose item ended without a verdict (cancelled, force-failed) is dropped.
    if (s.probe && !IN_FLIGHT.includes(this.deps.workItemState(s.probe.workItemId) ?? "CANCELED")) {
      s.probe = null;
      this.write();
    }
    if (!s.probe && s.nextProbeAt !== null && s.nextProbeAt <= now && this.deps.hasCapability(memberId, MODEL_FAILOVER_CAPABILITY)) {
      s.probe = { workItemId, memberId, startedAt: now };
      this.write();
      this.deps.log?.(`failover: ${workItemId} probes the primary ${p.chain[0]}`);
      return { modelId: personaModelId, probe: { modelId: resolveChainEntry(this.deps.config, p.chain[0]!, harness) } };
    }
    this.noteRetry(memberId, workItemId, personaModelId, harness);
    if (personaModelId && this.failedModels(harness).includes(personaModelId)) {
      return { modelId: this.currentModel(harness) };
    }
    return { modelId: personaModelId };
  }

  /**
   * A claimed retry whose last attempt failed with a trip kind, on an agent
   * whose model (as far as the daemon can tell: pin ?? persona ?? team default
   * ?? the session's) is a failed entry or the substitute, runs on the
   * substitute: say so on its thread, once per thread and chain entry.
   */
  private noteRetry(memberId: string, workItemId: string, personaModelId: string | null, harness: string): void {
    const cause = this.deps.retryOf?.(workItemId);
    if (!cause || !this.tripKinds.includes(cause.kind)) return;
    const s = this.state;
    const key = `${cause.workDefId}@${s.index}`;
    if (s.retried.includes(key)) return;
    const seen = this.deps.getModelPin(memberId) ?? personaModelId ?? teamDefaultModel(this.deps.config, harness) ?? this.deps.currentModel(memberId);
    if (seen !== null && seen !== this.currentModel(harness) && !this.failedModels(harness).includes(seen)) return;
    s.retried.push(key);
    this.write();
    const p = this.policy;
    this.deps.onEvent?.({ type: "retried", workItemId, from: p.chain[s.index - 1]!, to: p.chain[s.index]!, kind: cause.kind });
  }

  /** An agent (re)registered: while active, send it the substitute (its fresh session has none). */
  onRegister(memberId: string): void {
    if (!this.active) return;
    const m = this.deps.getMember(memberId);
    if (m) this.notify(m, `failover: the team is on ${this.policy.chain[this.state.index]}`);
  }

  /**
   * End the failover now (a probe's success, "End failover now", or the policy
   * going away): back to the primary, and every agent sent a substitute is sent
   * `model: null`. False when none was active.
   */
  end(reason = "failover ended"): boolean {
    return this.finish(reason, null);
  }

  // --- Internals ---

  /** `end`, naming the probe whose success ended it (for the `ended` event). */
  private finish(reason: string, probeWorkItemId: string | null): boolean {
    const wasActive = this.state.index > 0;
    const { notified, since } = this.state;
    const primary = this.policy.chain[0] ?? "the primary";
    this.state = idle();
    this.write();
    for (const id of notified) {
      if (this.deps.getMember(id)) this.deps.sendFailoverModel(id, { model: null, source: "failover", reason });
    }
    if (wasActive) {
      const now = this.deps.now();
      this.deps.onEvent?.({ type: "ended", episode: since ?? now, at: now, primary, reason, probeWorkItemId });
    }
    return wasActive;
  }

  /** The failed entries (chain[0 .. current-1]) as `harness` names them. */
  private failedModels(harness: string): string[] {
    return this.policy.chain.slice(0, this.state.index).map((e) => resolveChainEntry(this.deps.config, e, harness));
  }

  /** The current entry as `harness` names it. */
  private currentModel(harness: string): string {
    return resolveChainEntry(this.deps.config, this.policy.chain[this.state.index]!, harness);
  }

  /** Send the substitute to every live agent that should get it. */
  private notifyAll(reason: string): void {
    for (const m of this.deps.getMembers()) if (m.status !== "offline") this.notify(m, reason);
  }

  /**
   * Send one agent the substitute: a failover-capable harness always (it
   * substitutes only where its model is a failed one); an older set-model
   * harness only when the daemon's view of its model is a failed one.
   */
  private notify(m: Member, reason: string): void {
    const harness = m.harness || DEFAULT_HARNESS;
    const replaces = this.failedModels(harness);
    const model = this.currentModel(harness);
    let params: SetModelParams | null = null;
    if (this.deps.hasCapability(m.id, MODEL_FAILOVER_CAPABILITY)) {
      params = { model, source: "failover", reason, replaces };
    } else if (this.deps.hasCapability(m.id, SET_MODEL_CAPABILITY)) {
      const seen = this.deps.getModelPin(m.id) ?? teamDefaultModel(this.deps.config, harness) ?? this.deps.currentModel(m.id);
      if (seen && replaces.includes(seen)) params = { model, source: "failover", reason };
    }
    if (!params || !this.deps.sendFailoverModel(m.id, params)) return;
    if (!this.state.notified.includes(m.id)) {
      this.state.notified.push(m.id);
      this.write();
    }
  }

  /**
   * Keep the state consistent with a policy that may have changed: switched
   * off, or a chain that no longer reaches the current entry, ends the failover.
   */
  private reconcile(): void {
    if (this.state.index === 0) return;
    const p = this.policy;
    if (!p.enabled) this.end("failover switched off");
    else if (this.state.index >= p.chain.length) this.end("failover chain changed");
  }

  private read(): FailoverState {
    try {
      const raw = this.deps.load();
      if (!raw) return idle();
      const parsed = JSON.parse(raw) as Partial<FailoverState>;
      return { ...idle(), ...parsed, notified: parsed.notified ?? [], failures: parsed.failures ?? [], trips: parsed.trips ?? [], retried: parsed.retried ?? [] };
    } catch {
      return idle();
    }
  }

  private write(): void {
    const s = this.state;
    const empty = s.index === 0 && s.failures.length === 0 && s.notified.length === 0 && !s.exhausted;
    this.deps.save(empty ? null : JSON.stringify(s));
  }
}

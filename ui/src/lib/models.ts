/**
 * lib/models.ts — What the UI says about an agent's model (docs/DESIGN.md
 * "Choosing a Model"): the teammate page's model chip and the Assistant card's
 * model picker read an agent's model state (GET /api/agents/:id/model,
 * `AgentModelResponse`) through these.
 *
 * Config → Models' default-model picker offers the union of the live agents'
 * models per harness (`modelChoicesByHarness`).
 *
 * Model ids are opaque: a model is matched by its `AvailableModel.ref` (what
 * the harness accepts back) or, for the session's model, by `provider/id` —
 * never by anything vendor-specific. The effective model is the one the
 * session reports running; a pending `set-model` is shown as a switch in
 * progress, a done `failover` one as a substitution, and the user's pin with a
 * 📌. `failoverSummary` is Config → Models' account of a team-wide failover;
 * `failoverBanner` is the Team tab's (and the phone's) one line about it.
 */

import type { AgentModelResponse, AvailableModel, FailoverView, ModelChangeView } from "@shared/protocol";
import { failoverLine } from "../../../shared/failover.ts";

/** The session's model (`MemberSessionStats.model`). */
export type SessionModel = { id: string; name: string; provider: string };

/** What a harness that can't switch models gets told, in the chip and the picker. */
export const MODEL_SWITCHING_UNSUPPORTED = "Model switching is not supported by this harness";

/** The ref a session model would have (`provider/id`, or the bare id with no provider) — AvailableModel's default. */
export function sessionModelRef(m: { id: string; provider: string }): string {
  return m.provider ? `${m.provider}/${m.id}` : m.id;
}

/** A model ref's display name: its reported name, else the ref itself. */
export function modelLabel(ref: string | null, models: AvailableModel[] | null | undefined): string {
  if (ref === null) return "its default model";
  return models?.find((m) => m.ref === ref)?.name ?? ref;
}

/**
 * Is this change a failover substitute that is in effect (done, with a model)?
 * With `currentRef` (the model the session runs), only when it is that model:
 * a harness applies a substitute only over a failed model (docs/DESIGN.md
 * "Model Failover"), so an agent on a healthy one isn't marked.
 */
export function failoverActive(change: ModelChangeView | null | undefined, currentRef?: string | null): boolean {
  if (!change || change.source !== "failover" || change.status !== "done" || change.model === null) return false;
  return currentRef == null || currentRef === change.model;
}

/**
 * One line for an active team-wide failover (GET /api/failover): what the team
 * runs instead of what, since when, and when the primary is tried again — the
 * Team tab's banner and Config → Models say it the same way.
 */
export function failoverSummary(f: FailoverView, now = Date.now()): string {
  if (!f.active || !f.to) return "No failover: the team runs its usual models.";
  const mins = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(iso) - now) / 60_000)) : null);
  const parts = [`Failover: the team is on ${f.to} instead of ${f.replaces.join(", ") || f.from}`];
  if (f.since) parts.push(`since ${new Date(f.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  if (f.exhausted) parts.push("(the last model in the chain is failing too)");
  const next = mins(f.nextProbeAt);
  const tail = f.probe ? `Trying ${f.from} again on one work item now.`
    : next === null ? "" : next === 0 ? `${f.from} is tried again with the next work item.` : `${f.from} is tried again in ${next} min.`;
  return `${parts.join(" ")}.${tail ? ` ${tail}` : ""}`;
}

/** A clock time as the UI shows one: local HH:MM. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What the Team tab's failover banner shows; null renders nothing. */
export interface FailoverBannerView {
  /** "Failover: <from> → <to> since <time> (<kind>)" (shared/failover.ts `failoverLine`). */
  text: string;
  /** The longer account (`failoverSummary`: when the primary is tried again), for the tooltip. */
  detail: string;
}

/**
 * The Team tab's banner while a failover is active (and the phone's one-line
 * notice: its `text`), or null when none is — no failover, or no answer yet.
 * `formatTime` is for tests; the UI shows local clock time.
 */
export function failoverBanner(f: FailoverView | null | undefined, now = Date.now(), formatTime: (iso: string) => string = clockTime): FailoverBannerView | null {
  const text = failoverLine(f, formatTime);
  if (!f || text === null) return null;
  return { text, detail: failoverSummary(f, now) };
}

/** Everything the model chip shows, in words. */
export interface ModelChipView {
  /** The chip's text: the effective model's name (or what it is switching to). */
  label: string;
  /** The tooltip: what it's running, and why (pin, failover, a switch pending or failed). */
  tooltip: string;
  /** The user pinned a model on it. */
  pinned: boolean;
  /** A failover substitute is in effect. */
  failover: boolean;
  /** A set-model is waiting for the agent: what it's switching to. */
  pending: string | null;
  /** The latest change failed: the agent's reason. */
  failed: string | null;
  /** Can the user change it here (its harness switches models, and reported some)? */
  changeable: boolean;
}

/**
 * The chip for an agent's model state. `state` is GET /api/agents/:id/model
 * (null until it loads); `session` is the model its session stats report, the
 * fallback while `state` loads.
 */
export function modelChipView(state: AgentModelResponse | null | undefined, session: SessionModel | null | undefined): ModelChipView {
  const current = state?.current ?? session ?? null;
  const models = state?.models ?? null;
  const pin = state?.pin ?? null;
  const change = state?.lastChange ?? null;
  const pending = change?.status === "pending" ? modelLabel(change.model, models) : null;
  const failed = change?.status === "failed" ? (change.error || "the harness refused it") : null;
  const failover = failoverActive(change, current ? sessionModelRef(current) : null);
  const supported = !!state?.supported;
  const changeable = supported && (models?.length ?? 0) > 0;

  const label = current?.name ?? (pin ? modelLabel(pin, models) : "Default model");
  const lines = [current ? `Model: ${sessionModelRef(current)}` : "Model: not reported yet"];
  if (failover) {
    lines.push(`Failover: using ${modelLabel(change!.model, models)} instead of its usual model${change!.reason ? ` — ${change!.reason}` : ""}. It goes back automatically.`);
  }
  if (pin) lines.push(`Pinned by you: ${modelLabel(pin, models)}. It stays until you clear the pin, and wins over the persona's model.`);
  else if (!failover) lines.push("Not pinned: the persona's model, the team default or the harness's own.");
  if (pending) lines.push(`Switching to ${pending} after the current run…`);
  if (failed && change) lines.push(`The last switch, to ${modelLabel(change.model, models)}, failed: ${failed}`);
  if (state && !supported) lines.push(`${MODEL_SWITCHING_UNSUPPORTED}.`);
  else if (state && supported && !changeable) lines.push("Its harness hasn't reported any models to switch to.");
  return { label, tooltip: lines.join("\n"), pinned: !!pin, failover, pending, failed, changeable };
}

/**
 * The outcome of a change the user asked for, once the agent has reported it:
 * `{ done }` or `{ error }` — or null while it is still pending (or `change`
 * is some other ask).
 */
export function changeOutcome(change: ModelChangeView | null | undefined, directiveId: string): { done: true } | { error: string } | null {
  if (!change || change.id !== directiveId || change.status === "pending") return null;
  if (change.status === "done") return { done: true };
  return { error: change.status === "cancelled" ? (change.error || "superseded by a newer change") : (change.error || "the harness refused it") };
}

/** The model the "Apply to all teammates" action spreads: the agent's pin, else what it's running. */
export function applyToAllModel(state: AgentModelResponse | null | undefined): string | null {
  if (!state) return null;
  if (state.pin) return state.pin;
  if (!state.current) return null;
  const ref = sessionModelRef(state.current);
  return state.models?.find((m) => m.ref === ref || (m.id === state.current!.id && m.provider === state.current!.provider))?.ref ?? null;
}

/** The ref of the model the session runs, as it appears in `models` (for the picker's checked item), or null. */
export function currentRef(state: AgentModelResponse | null | undefined): string | null {
  const cur = state?.current;
  if (!cur) return null;
  return state?.models?.find((m) => m.id === cur.id && m.provider === cur.provider)?.ref ?? sessionModelRef(cur);
}

/**
 * The models the live agents report, grouped by harness: each harness's union
 * of `AvailableModel`s (by ref, first name seen), sorted by name. Offline agents
 * and those that never reported are skipped. What Config → Models' default
 * model picker offers (beside free text).
 */
export function modelChoicesByHarness(
  agents: ReadonlyArray<{ status: string; harness?: string; models?: AvailableModel[] | null }> | null | undefined,
): Map<string, AvailableModel[]> {
  const byHarness = new Map<string, Map<string, AvailableModel>>();
  for (const a of agents ?? []) {
    if (a.status === "offline" || !a.models) continue;
    const h = a.harness || "pi";
    const refs = byHarness.get(h) ?? new Map<string, AvailableModel>();
    for (const m of a.models) if (!refs.has(m.ref)) refs.set(m.ref, m);
    byHarness.set(h, refs);
  }
  return new Map([...byHarness].map(([h, refs]) => [h, [...refs.values()].sort((x, y) => x.name.localeCompare(y.name) || x.ref.localeCompare(y.ref))]));
}

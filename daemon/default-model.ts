/**
 * daemon/default-model.ts — The team default model (`TeamConfig.defaultModel`,
 * per harness) handed to agents as `set-model` directives with source
 * `default` (docs/DESIGN.md "Choosing a Model").
 *
 * The daemon doesn't put the default in a start command (the harness start
 * templates stay as they are) or pick models itself: it asks the agent, the
 * same way a user's pick does, and the harness checks the id and keeps it as
 * its "team default" preference — below a user pin and a persona's model,
 * above the harness's own default (harnesses/pi/src/model-choice.ts).
 *
 *   - At registration (`offerDefaultModelOnRegister`): an agent — teammate or
 *     the assistant — with no pin, whose harness can switch models, is sent its
 *     harness's default. The daemon can't tell which model a fresh session
 *     runs (registration clears the session stats), so it always asks; the
 *     harness's switch is idempotent, so an agent already on it changes nothing.
 *   - When a pin is cleared (`offerDefaultModelAfterUnpin`): the agent reported
 *     a user's `model: null` done, so it falls back to the persona's or the
 *     team default — which it was never sent while pinned, so it's sent now.
 *   - On request (`applyDefaultModel`, POST /api/agents/model/default — the
 *     Config → Models "Apply to all teammates now"): every live unpinned agent
 *     is sent its harness's current default, or `null` to drop a default an
 *     earlier ask set, so running agents follow a changed config without a
 *     restart.
 *
 * Pinned agents are never sent the default: the pin wins anyway, and the
 * Team tab's picker is where a pin is changed or cleared.
 */

import type { LeaderDirective, Store } from "./store.ts";
import { DEFAULT_HARNESS, type TeamConfig } from "../shared/types.ts";
import { SET_MODEL_ACTION, SET_MODEL_CAPABILITY } from "../shared/protocol.ts";
import { teamDefaultModel } from "../shared/model-aliases.ts";
import { readSetModelParams, setModelParams } from "./agent-models.ts";

/** The `reason` on a default set-model sent at registration. */
const ON_REGISTER_REASON = "team default model";
/** The `reason` on a default set-model sent after a user cleared the agent's pin. */
const ON_UNPIN_REASON = "team default model (pin cleared)";
/** The `reason` on a default set-model sent by "Apply to all teammates now". */
const ON_APPLY_REASON = "team default model (applied from Config → Models)";

/** The harness an agent runs under, as the claim route reads it (unset = Pi). */
function harnessOf(store: Store, memberId: string): string {
  return store.getMember(memberId)?.harness || DEFAULT_HARNESS;
}

/**
 * Send a just-registered agent its harness's team default, when it should
 * have one: a default is configured for its harness, its harness can switch
 * models, it has no user pin, and no set-model ask is already pending for it
 * (a user's pick waiting to be realized must not be superseded by the
 * default). Returns the directive, or null when none was sent.
 */
export function offerDefaultModelOnRegister(store: Store, config: Pick<TeamConfig, "defaultModel">, memberId: string): LeaderDirective | null {
  return offerDefaultModel(store, config, memberId, ON_REGISTER_REASON);
}

/**
 * After an agent reported a set-model done (PUT /api/agents/:id/directives/:id):
 * when it was a user clearing the pin, send the team default — the agent never
 * got it while pinned. `directive` is the one reported, read before completion.
 * Returns the new directive, or null.
 */
export function offerDefaultModelAfterUnpin(
  store: Store, config: Pick<TeamConfig, "defaultModel">, directive: LeaderDirective, status: string,
): LeaderDirective | null {
  if (status !== "done" || directive.action !== SET_MODEL_ACTION || !directive.memberId) return null;
  const params = readSetModelParams(directive.params);
  if (params?.source !== "user" || params.model !== null) return null;
  return offerDefaultModel(store, config, directive.memberId, ON_UNPIN_REASON);
}

/** The shared rule: a default for its harness, a harness that can switch, no pin, nothing pending. */
function offerDefaultModel(store: Store, config: Pick<TeamConfig, "defaultModel">, memberId: string, reason: string): LeaderDirective | null {
  const model = teamDefaultModel(config, harnessOf(store, memberId));
  if (!model) return null;
  if (!store.memberHasCapability(memberId, SET_MODEL_CAPABILITY)) return null;
  if (store.getModelPin(memberId)) return null;
  if (store.getLastModelChange(memberId)?.status === "pending") return null;
  const res = store.requestModelChange(memberId, setModelParams(model, "default", reason));
  return "directive" in res ? res.directive : null;
}

/** What `applyDefaultModel` did, per live agent. */
export interface ApplyDefaultModelResult {
  /** One set-model (source `default`) per agent that was sent one, with the model (null = default cleared). */
  directives: Array<{ memberId: string; directiveId: string; model: string | null }>;
  /** Live agents left alone because a user pinned their model (or a pick of theirs is still pending). */
  pinned: string[];
  /** Live agents whose harness can't switch models. */
  unsupported: string[];
}

/**
 * Send every live (not offline) agent without a pin — the teammates and the
 * assistant — its harness's current team default as a set-model with source
 * `default`; `null` where its harness has none, which drops a default an
 * earlier ask set (the agent goes back to the persona's or its own model).
 */
export function applyDefaultModel(store: Store, config: Pick<TeamConfig, "defaultModel">): ApplyDefaultModelResult {
  const result: ApplyDefaultModelResult = { directives: [], pinned: [], unsupported: [] };
  for (const m of store.getMembers()) {
    if (m.status === "offline") continue;
    if (!store.memberHasCapability(m.id, SET_MODEL_CAPABILITY)) { result.unsupported.push(m.id); continue; }
    // A user's pick still pending is a pin-to-be: superseding it would lose it.
    const last = store.getLastModelChange(m.id);
    if (store.getModelPin(m.id) || (last?.status === "pending" && last.source === "user")) { result.pinned.push(m.id); continue; }
    const model = teamDefaultModel(config, m.harness || DEFAULT_HARNESS);
    const res = store.requestModelChange(m.id, setModelParams(model, "default", ON_APPLY_REASON));
    if ("directive" in res) result.directives.push({ memberId: m.id, directiveId: res.directive.id, model });
    else result.unsupported.push(m.id);
  }
  return result;
}

/**
 * daemon/routes/models.ts — Model switching for an agent (docs/DESIGN.md
 * "Choosing a Model").
 *
 * The daemon never picks or validates a model itself: model ids are opaque
 * strings the harness reports (`AvailableModel`) and checks when asked. These
 * routes record what the harness can use and turn a user's choice into a
 * `set-model` self-directive the agent realizes between runs:
 *
 *   - Agent-facing: `POST /api/agents/:id/models` — the harness's available
 *     models changed (they are also sent at registration).
 *   - UI-facing: `GET /api/agents/:id/model` (supported?, models, pin, the live
 *     model, the latest ask); `POST /api/agents/:id/model` `{ model | null }`
 *     pins a model on one agent — the assistant too, by the leader's id — or
 *     clears the pin; `POST /api/agents/model` `{ model, scope: "teammates" }`
 *     pins it on every live teammate; `POST /api/agents/model/default` sends
 *     every live unpinned agent the team default model (`TeamConfig.defaultModel`,
 *     daemon/default-model.ts) — Config → Models' "Apply to all teammates now".
 *
 *   - Failover (daemon/failover.ts; docs/DESIGN.md "Model Failover"):
 *     `GET /api/failover` — the team-wide failover state (also in /api/status);
 *     `POST /api/failover/end` — "End failover now".
 *
 * An agent whose harness didn't declare `set-model` (an older one, `mpt agent`)
 * gets a 409 with `unsupported: true` — the UI's "not supported by this
 * harness" — rather than a directive nobody would realize. The pin itself is
 * set when the agent reports the directive done (MemberStore
 * `completeMemberDirective`), so it is never a model the harness refused.
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import { isPoolTeammate } from "../store.ts";
import { parseAvailableModels, parseModelRef, setModelParams } from "../agent-models.ts";
import { applyDefaultModel } from "../default-model.ts";
import { SET_MODEL_CAPABILITY, type AgentModelResponse, type ApplyDefaultModelResponse, type EndFailoverResponse, type FailoverView } from "../../shared/protocol.ts";

/** The 409 reply's wording for a harness that can't switch models. */
export const MODEL_SWITCHING_UNSUPPORTED = "Model switching is not supported by this harness (upgrade it, or change the model in its own session)";

export function registerModelRoutes(ctx: RouteContext): void {
  const { app, store, config } = ctx;

  app.get("/api/failover", (c) => c.json(store.failover.view() satisfies FailoverView));

  // Ends it at once: back to the primary, substitutes cleared. Not an error when
  // none is active (the banner may be stale) — the reply carries the state.
  app.post("/api/failover/end", (c) => {
    store.failover.end("failover ended by hand (End failover now)");
    return c.json({ success: true, failover: store.failover.view() } satisfies EndFailoverResponse);
  });

  app.post("/api/agents/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!store.getMember(id)) return fail(c, 404, `Agent "${id}" not found`);
    const body = await readBody(c) as { models?: unknown };
    const models = parseAvailableModels(body.models);
    if (!models) return fail(c, 400, "Field 'models' must be a list of { ref, id, name, provider }");
    store.setAvailableModels(id, models);
    return c.json({ success: true });
  });

  app.get("/api/agents/:id/model", (c) => {
    const id = c.req.param("id");
    if (!store.getMember(id)) return fail(c, 404, `Agent "${id}" not found`);
    return c.json({
      supported: store.memberHasCapability(id, SET_MODEL_CAPABILITY),
      models: store.getAvailableModels(id),
      pin: store.getModelPin(id),
      current: store.getMemberSessionStats(id)?.model ?? null,
      lastChange: store.getLastModelChange(id),
    } satisfies AgentModelResponse);
  });

  app.post("/api/agents/:id/model", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c) as { model?: unknown; reason?: unknown };
    if (!("model" in body)) return fail(c, 400, "Field 'model' is required (a model id, or null to clear the pin)");
    const model = parseModelRef(body.model);
    if ("error" in model) return fail(c, 400, model.error);
    const res = store.requestModelChange(id, setModelParams(model.value, "user", body.reason));
    if ("error" in res) {
      return res.error === "unknown"
        ? fail(c, 404, `Agent "${id}" not found`)
        : fail(c, 409, MODEL_SWITCHING_UNSUPPORTED, { unsupported: true });
    }
    return c.json({ success: true, directive: res.directive }, 201);
  });

  // Registered before the `:id` routes on purpose (a literal path, never an agent id).
  app.post("/api/agents/model/default", (c) => {
    return c.json({ success: true, ...applyDefaultModel(store, config) } satisfies ApplyDefaultModelResponse);
  });

  app.post("/api/agents/model", async (c) => {
    const body = await readBody(c) as { model?: unknown; scope?: unknown; reason?: unknown };
    if (body.scope !== "teammates") return fail(c, 400, "Field 'scope' must be \"teammates\"");
    if (!("model" in body)) return fail(c, 400, "Field 'model' is required (a model id, or null to clear the pins)");
    const model = parseModelRef(body.model);
    if ("error" in model) return fail(c, 400, model.error);
    // Every live pool teammate: not the leader (its model is the assistant's, set
    // on its own), not one that has gone offline.
    const teammates = store.getMembers().filter((m) => m.status !== "offline" && isPoolTeammate(m.name));
    const directives: Array<{ memberId: string; directiveId: string }> = [];
    const unsupported: string[] = [];
    for (const m of teammates) {
      const res = store.requestModelChange(m.id, setModelParams(model.value, "user", body.reason));
      if ("directive" in res) directives.push({ memberId: m.id, directiveId: res.directive.id });
      else unsupported.push(m.id);
    }
    return c.json({ success: true, directives, unsupported });
  });
}

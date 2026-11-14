/**
 * tests/model-switching.test.ts — Model switching from the web UI
 * (daemon/routes/models.ts, MemberStore's model methods; docs/DESIGN.md
 * "Choosing a Model").
 *
 * The daemon side: a harness reports its available models (at registration and
 * on change) and the GET routes expose them; POST /api/agents/:id/model turns a
 * choice into a `set-model` self-directive whose lifecycle is pending → done /
 * failed (with the harness's reason); a done user set-model is the agent's pin,
 * sent back at every registration, kept across a session reset, cleared by
 * `model: null` and by dismissal; a newer ask supersedes a pending one; the
 * bulk route pins every live teammate; the leader takes the per-agent route;
 * and a harness that never declared `set-model` is reported as unsupported
 * instead of being handed a directive it would never realize. The harness side
 * (the between-runs wait, pin precedence over a persona model) is
 * harnesses/pi/tests/model-choice.test.mjs.
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, post, put, get, del, type App } from "./_team.ts";
import { SET_MODEL_CAPABILITY, type AgentListResponse, type AgentModelResponse } from "../shared/protocol.ts";

const MODELS = [
  { ref: "acme/base", id: "base", name: "Base", provider: "acme" },
  { ref: "acme/strong", id: "strong", name: "Strong", provider: "acme" },
];

/** Register `id`; `modern` declares set-model and reports MODELS. Returns the registration reply. */
async function register(app: App, id: string, modern = true, name = id) {
  const res = await post(app, "/api/agents/register", {
    id, name, directory: "/tmp",
    ...(modern ? { capabilities: [SET_MODEL_CAPABILITY], models: MODELS } : {}),
  });
  assertEquals(res.status, 200);
  return await res.json() as { modelPin?: string | null };
}

const modelState = async (app: App, id: string) => await (await get(app, `/api/agents/${id}/model`)).json() as AgentModelResponse;
const pending = async (app: App, id: string) =>
  (await (await get(app, `/api/agents/${id}/directives`)).json() as { directives: Array<{ id: string; action: string; params: Record<string, unknown> }> }).directives;

test("available models: reported at registration and on change, listed for the UI (cleaned)", async () => {
  await withTeam({}, async ({ app }) => {
    await register(app, "t1");
    await register(app, "old", false);
    const list = await (await get(app, "/api/agents")).json() as AgentListResponse;
    const t1 = list.agents.find((a) => a.id === "t1")!;
    assertEquals([t1.modelSwitching, t1.models, t1.modelPin], [true, MODELS, null]);
    const old = list.agents.find((a) => a.id === "old")!;
    assertEquals([old.modelSwitching, old.models, old.modelPin], [false, null, null], "an older harness: not supported, never reported");

    // A later report replaces the list; bad entries are dropped, gaps filled.
    const res = await post(app, "/api/agents/t1/models", { models: [{ id: "x", provider: "p" }, { name: "no id" }, "junk", { id: "x", provider: "p" }] });
    assertEquals(res.status, 200);
    assertEquals((await modelState(app, "t1")).models, [{ ref: "p/x", id: "x", name: "x", provider: "p" }]);
    assertEquals((await post(app, "/api/agents/t1/models", { models: "nope" })).status, 400);
    assertEquals((await post(app, "/api/agents/ghost/models", { models: [] })).status, 404);
  });
});

test("set-model lifecycle: pending → done sets the pin, sent back at registration", async () => {
  await withTeam({}, async ({ app }) => {
    await register(app, "t1");
    const res = await post(app, "/api/agents/t1/model", { model: "acme/strong", reason: "try it" });
    assertEquals(res.status, 201);
    const { directive } = await res.json() as { directive: { id: string; action: string; params: Record<string, unknown>; status: string } };
    assertEquals([directive.action, directive.status, directive.params], ["set-model", "pending", { model: "acme/strong", source: "user", reason: "try it" }]);
    assertEquals((await pending(app, "t1")).map((d) => d.id), [directive.id], "the agent polls it");
    assertEquals((await modelState(app, "t1")).pin, null, "not a pin until the agent did it");
    assertEquals((await modelState(app, "t1")).lastChange?.status, "pending");

    assertEquals((await put(app, `/api/agents/t1/directives/${directive.id}`, { status: "done" })).status, 200);
    const state = await modelState(app, "t1");
    assertEquals([state.pin, state.lastChange?.status, state.supported], ["acme/strong", "done", true]);
    assertEquals((await pending(app, "t1")).length, 0);
    // Every registration (a fresh session) hands the pin back.
    assertEquals((await register(app, "t1")).modelPin, "acme/strong");
  });
});

test("set-model failed: the harness's reason is kept and the pin doesn't change", async () => {
  await withTeam({}, async ({ app }) => {
    await register(app, "t1");
    const { directive } = await (await post(app, "/api/agents/t1/model", { model: "acme/nope" })).json() as { directive: { id: string } };
    await put(app, `/api/agents/t1/directives/${directive.id}`, { status: "failed", error: "\"acme/nope\" isn't a model this Pi knows" });
    const state = await modelState(app, "t1");
    assertEquals(state.pin, null);
    assertEquals([state.lastChange?.status, state.lastChange?.error], ["failed", "\"acme/nope\" isn't a model this Pi knows"]);
  });
});

test("a newer ask supersedes a pending one; clearing the pin (model: null)", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "t1");
    const first = (await (await post(app, "/api/agents/t1/model", { model: "acme/base" })).json()).directive;
    const second = (await (await post(app, "/api/agents/t1/model", { model: "acme/strong" })).json()).directive;
    assertEquals((await pending(app, "t1")).map((d) => d.id), [second.id], "only the latest is pending");
    assertEquals(store.getLeaderDirective(first.id)?.status, "cancelled");
    await put(app, `/api/agents/t1/directives/${second.id}`, { status: "done" });
    assertEquals(store.getModelPin("t1"), "acme/strong");

    const clear = (await (await post(app, "/api/agents/t1/model", { model: null })).json()).directive;
    assertEquals(clear.params, { model: null, source: "user" });
    await put(app, `/api/agents/t1/directives/${clear.id}`, { status: "done" });
    assertEquals(store.getModelPin("t1"), null);
    assertEquals((await register(app, "t1")).modelPin, null);
  });
});

test("the pin lives as long as the agent: kept across a reset, gone on dismiss", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "t1");
    const d = (await (await post(app, "/api/agents/t1/model", { model: "acme/strong" })).json()).directive;
    await put(app, `/api/agents/t1/directives/${d.id}`, { status: "done" });
    // A Team-tab Reset: the agent deregisters and its new session registers again.
    await del(app, "/api/agents/t1");
    assertEquals((await register(app, "t1")).modelPin, "acme/strong");
    await del(app, "/api/agents/t1?dismiss=true");
    assertEquals(store.getModelPin("t1"), null);
  });
});

test("an older harness is reported as unsupported and is never handed a set-model", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "old", false);
    const res = await post(app, "/api/agents/old/model", { model: "acme/strong" });
    assertEquals(res.status, 409);
    const body = await res.json() as { unsupported?: boolean; error: string };
    assertEquals(body.unsupported, true);
    assert(body.error.includes("not supported by this harness"), body.error);
    assertEquals((await modelState(app, "old")).supported, false);
    // Even one queued some other way never reaches it (it would fail or ignore it).
    store.createLeaderDirectiveForMember("old", "set-model", { model: "acme/strong", source: "user" });
    assertEquals((await pending(app, "old")).length, 0);
  });
});

test("POST /api/agents/:id/model: validation and unknown agents", async () => {
  await withTeam({}, async ({ app }) => {
    await register(app, "t1");
    for (const body of [{}, { model: "" }, { model: 3 }, { model: "x".repeat(201) }]) {
      assertEquals((await post(app, "/api/agents/t1/model", body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assertEquals((await post(app, "/api/agents/ghost/model", { model: "acme/base" })).status, 404);
    assertEquals((await get(app, "/api/agents/ghost/model")).status, 404);
  });
});

test("the assistant: the same per-agent route on the leader", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "leader", true, "leader");
    const res = await post(app, "/api/agents/leader/model", { model: "acme/strong" });
    assertEquals(res.status, 201);
    const { directive } = await res.json() as { directive: { id: string } };
    assertEquals((await pending(app, "leader")).map((d) => d.id), [directive.id]);
    await put(app, `/api/agents/leader/directives/${directive.id}`, { status: "done" });
    assertEquals(store.getModelPin("leader"), "acme/strong");
  });
});

test("bulk: POST /api/agents/model pins every live teammate, not the leader, naming those that can't", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "leader", true, "leader");
    await register(app, "t1");
    await register(app, "t2");
    await register(app, "old", false);
    await register(app, "gone");
    store.updateMemberStatus("gone", "offline");

    assertEquals((await post(app, "/api/agents/model", { model: "acme/strong" })).status, 400, "scope is required");
    assertEquals((await post(app, "/api/agents/model", { model: 5, scope: "teammates" })).status, 400);
    const res = await post(app, "/api/agents/model", { model: "acme/strong", scope: "teammates" });
    assertEquals(res.status, 200);
    const body = await res.json() as { directives: Array<{ memberId: string; directiveId: string }>; unsupported: string[] };
    assertEquals(body.directives.map((d) => d.memberId).sort(), ["t1", "t2"]);
    assertEquals(body.unsupported, ["old"]);
    assertEquals((await pending(app, "leader")).length, 0, "the assistant's model is set on its own");
    assertEquals((await pending(app, "gone")).length, 0);
    for (const d of body.directives) {
      assertEquals((await pending(app, d.memberId)).map((p) => [p.id, p.params.model]), [[d.directiveId, "acme/strong"]]);
    }
  });
});

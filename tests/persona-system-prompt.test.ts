/**
 * tests/persona-system-prompt.test.ts — The persona in the system prompt: a
 * harness that declares the `persona-system-prompt` capability at registration
 * gets the claim's `persona` (id, title, body, state, the rendered role block)
 * and a work prompt without the role block; every other harness gets the prompt
 * byte-identical to before, with the role inline. Also the builder's
 * `inlinePersona` switch. See docs/DESIGN.md "The persona in the system prompt".
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { buildWorkDefPrompt, renderRoleBlock, stateFraming, DEFAULT_TRIAGE_INSTRUCTIONS } from "../daemon/prompt.ts";
import { PERSONA_SYSTEM_PROMPT_CAPABILITY, type AgentClaimResponse } from "../shared/protocol.ts";
import type { Store } from "../daemon/store.ts";
import { TASK_SOURCE_ID } from "../daemon/sources/registry.ts";
import type { buildApp } from "../daemon/server.ts";

type App = ReturnType<typeof buildApp>;

/** Register `id` through the route, as a harness does, with `capabilities` (or none). */
async function register(app: App, id: string, capabilities?: string[]): Promise<void> {
  const res = await app.request("/api/agents/register", jsonInit("POST", { id, name: id, directory: "/tmp", ...(capabilities ? { capabilities } : {}) }));
  assertEquals(res.status, 200);
}

/** Claim the READY item for `defId` as `agentId`. */
async function claim(app: App, store: Store, defId: string, agentId: string): Promise<AgentClaimResponse & { itemId: string }> {
  const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === defId)!;
  const body = await (await app.request(`/api/agents/claim/${item.id}`, jsonInit("POST", { agentId }))).json() as AgentClaimResponse;
  assertEquals(body.success, true);
  return { ...body, itemId: item.id };
}

const WORK_DEF = { title: "Review it", goal: "Look.", acceptanceCriteria: "It's looked at." };

// ─── The builder ─────────────────────────────────────────────────────

test("buildWorkDefPrompt: inlinePersona false leaves exactly the role block out", () => {
  for (const input of [
    { workDef: WORK_DEF, persona: "# Review\n\nNever edit code." },
    { workDef: WORK_DEF, state: "in_progress", persona: "Small diffs." },
    { workDef: WORK_DEF, state: "in_progress" },
  ]) {
    const inline = buildWorkDefPrompt(input);
    const without = buildWorkDefPrompt({ ...input, inlinePersona: false });
    const block = renderRoleBlock(input);
    assertEquals(inline, block + without);
    assertEquals(without.includes("## Your Role"), false);
    assertEquals(without.startsWith("## "), true);
  }
  // No persona and no state: nothing to leave out.
  assertEquals(buildWorkDefPrompt({ workDef: WORK_DEF, inlinePersona: false }), buildWorkDefPrompt({ workDef: WORK_DEF }));
  // The default is the inline block, byte-identical to before.
  assertEquals(buildWorkDefPrompt({ workDef: WORK_DEF, state: "in_progress" }).startsWith(
    `## Your Role: in_progress\n\n${stateFraming("in_progress")}\n\n## Task: Review it`), true);
});

// ─── The claim ───────────────────────────────────────────────────────

test("claim: a capable harness gets the persona in `persona` and no role block; an old one gets the inline block", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    await register(app, "old");
    store.createPersona({ title: "Careful Reviewer", content: "# Review\n\nNever edit code." });
    const a = store.createWorkDef({ ...WORK_DEF, persona: "careful-reviewer" });
    const b = store.createWorkDef({ ...WORK_DEF, title: "Review it too", persona: "careful-reviewer" });

    const capable = await claim(app, store, a.id, "new");
    assertEquals(capable.prompt!.includes("## Your Role"), false);
    assertEquals(capable.prompt!.startsWith("## Task: Review it"), true);
    assertEquals(capable.persona, {
      id: "careful-reviewer", title: "Careful Reviewer", body: "# Review\n\nNever edit code.",
      prompt: "## Your Role\n\n### Review\n\nNever edit code.", inline: false,
    });

    const old = await claim(app, store, b.id, "old");
    assertEquals(old.prompt!.startsWith("## Your Role\n\n### Review\n\nNever edit code.\n\n## Task: Review it too"), true);
    assertEquals(old.persona?.inline, true);
    assertEquals(old.persona?.prompt, capable.persona?.prompt);

    // The in-flight snapshot (the persona chip, run history) is recorded either way.
    assertEquals(store.getWorkItem(capable.itemId)!.persona?.id, "careful-reviewer");
    assertEquals(store.getWorkItem(old.itemId)!.persona?.id, "careful-reviewer");
  });
});

test("claim: board work carries its state; a state with no persona sends its one-line framing", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    await register(app, "old");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const bare = await claim(app, store, "s1-1", "new");
    assertEquals(bare.persona, {
      id: null, title: null, body: null, state: "in_progress", stateFraming: stateFraming("in_progress"),
      prompt: `## Your Role: in_progress\n\n${stateFraming("in_progress")}`, inline: false,
    });
    assertEquals(bare.prompt!.startsWith("## Story: S1"), true);
    assertEquals(store.getWorkItem(bare.itemId)!.persona, undefined);

    store.createPersona({ title: "Implementer", content: "## Rules\n\nSmall diffs." });
    assertEquals(store.setStatePersona("default", "in_progress", "implementer").ok, true);
    // Two stories that read the same, so their prompts can be compared byte for byte.
    store.createStory("s2", "S2", "D", "open", [], [{ title: "T2", description: "D2" }], "default");
    store.createStory("s3", "S2", "D", "open", [], [{ title: "T2", description: "D2" }], "default");
    const framed = await claim(app, store, "s2-1", "new");
    assertEquals(framed.persona?.id, "implementer");
    assertEquals(framed.persona?.state, "in_progress");
    assertEquals(framed.persona?.stateFraming, undefined);
    assertEquals(framed.persona?.prompt, "## Your Role: in_progress\n\n### Rules\n\nSmall diffs.");
    assertEquals(framed.prompt!.startsWith("## Story: S2"), true);
    assertEquals(framed.prompt!.includes("Small diffs."), false);

    // The old harness's prompt is the capable one with the block in front, byte for byte.
    const old = await claim(app, store, "s3-1", "old");
    assertEquals(old.prompt, `${framed.persona!.prompt}\n\n${framed.prompt}`);
    assertEquals(old.persona?.inline, true);
  });
});

test("claim: note triage moves `## Your Role: Triage` to the persona", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    const note = store.createThought({ content: "Should we add a cache?" });
    assertEquals(store.triageNow(note.id).ok, true);
    const def = store.ensureTriageWorkDef(note.id)!;
    const res = await claim(app, store, def.id, "new");
    assertEquals(res.persona?.id, "builtin:triage");
    assertEquals(res.persona?.inline, false);
    assertEquals(res.persona?.prompt.startsWith("## Your Role: Triage\n\n"), true);
    assertStringIncludes(res.persona!.prompt, DEFAULT_TRIAGE_INSTRUCTIONS.trim().split("\n")[0]!);
    assertEquals(res.prompt!.includes("## Your Role"), false);
    assertStringIncludes(res.prompt!, "Should we add a cache?");
  });
});

test("claim: work with no persona sends persona null and the same prompt either way", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    await register(app, "old");
    const a = store.createWorkDef({ ...WORK_DEF });
    const b = store.createWorkDef({ ...WORK_DEF });
    const capable = await claim(app, store, a.id, "new");
    const old = await claim(app, store, b.id, "old");
    assertEquals(capable.persona, null);
    assertEquals(old.persona, null);
    assertEquals(capable.prompt, old.prompt);
  });
});

test("register: capabilities are per registration — re-registering without them drops them; junk is ignored", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "a1", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    assertEquals(store.memberHasCapability("a1", PERSONA_SYSTEM_PROMPT_CAPABILITY), true);
    await register(app, "a1");
    assertEquals(store.memberHasCapability("a1", PERSONA_SYSTEM_PROMPT_CAPABILITY), false);
    const res = await app.request("/api/agents/register", jsonInit("POST", { id: "a2", name: "a2", capabilities: "persona-system-prompt" }));
    assertEquals(res.status, 200);
    assertEquals(store.memberHasCapability("a2", PERSONA_SYSTEM_PROMPT_CAPABILITY), false);
    await app.request("/api/agents/register", jsonInit("POST", { id: "a3", name: "a3", capabilities: [7, PERSONA_SYSTEM_PROMPT_CAPABILITY] }));
    assertEquals(store.memberHasCapability("a3", PERSONA_SYSTEM_PROMPT_CAPABILITY), true);
    assertEquals(store.memberHasCapability("nobody", PERSONA_SYSTEM_PROMPT_CAPABILITY), false);
  });
});

test("claim: a Work Source's prompt hook wraps a base without the block; one that keeps it elsewhere keeps it inline", async () => {
  await withTeam({}, async ({ app, store }) => {
    await register(app, "new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]);
    store.createPersona({ title: "Careful Reviewer", content: "Never edit code." });
    // Replace the built-in parent-less kind, as tests/work-sources.test.ts does.
    let mode: "wrap" | "keep" = "wrap";
    assertEquals(store.unregisterWorkSource(TASK_SOURCE_ID), true);
    store.registerWorkSource({
      id: TASK_SOURCE_ID,
      apiVersion: 1,
      buildPrompt: (_def, base) => mode === "wrap" ? `SOURCE-HEADER\n\n${base}` : `SOURCE-HEADER\n\n${renderRoleBlock({ persona: "Never edit code." })}${base}`,
    });
    const a = store.createWorkDef({ ...WORK_DEF, persona: "careful-reviewer" });
    const wrapped = await claim(app, store, a.id, "new");
    assertEquals(wrapped.prompt!.startsWith("SOURCE-HEADER\n\n## Task: Review it"), true);
    assertEquals(wrapped.persona?.inline, false);

    mode = "keep";
    const b = store.createWorkDef({ ...WORK_DEF, title: "Again", persona: "careful-reviewer" });
    const kept = await claim(app, store, b.id, "new");
    assertStringIncludes(kept.prompt!, "## Your Role\n\nNever edit code.");
    assertEquals(kept.persona?.inline, true, "the harness must not add it a second time");
  });
});

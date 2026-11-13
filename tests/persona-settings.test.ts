/**
 * tests/persona-settings.test.ts — A persona's harness settings (frontmatter
 * `tools`, `skills`, `model`, `requires`; docs/DESIGN.md "Persona settings"):
 * the frontmatter's YAML subset (flow and block style) parses and round-trips
 * through serialize; the linter's errors (shapes, non-`*` globs) and warnings
 * (deny cancelling allow, empty allow, unknown keys, an unknown model alias);
 * package personas lint them at registration; the persona routes save, clear
 * and refuse them; and the settings reach the claim's `persona`, a duplicate,
 * and the assistant persona the leader reads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { parsePersonaFile, rawPersonaSettings, serializePersona } from "../daemon/personas/library.ts";
import { validatePersonaSettings } from "../daemon/personas/lint.ts";
import { matchesToolPattern, readPersonaSettings } from "../daemon/personas/settings.ts";
import { PackagePersonas } from "../daemon/personas/packages.ts";
import { PERSONA_SYSTEM_PROMPT_CAPABILITY, type AgentClaimResponse } from "../shared/protocol.ts";

const FLOW = `---
title: Reviewer
tools: { allow: ["read", "grep", "mcp__code-search__*"], deny: ["bash", "write"] }  # a comment
skills: ["code-review", "style-guide"]
model: "strong"
requires: { mcp: ["code-search"] }
---
Review it.
`;

const BLOCK = `---
title: Reviewer
tools:
  allow: [read, grep, "mcp__code-search__*"]
  deny:
    - bash
    - write
skills:
  - code-review
  - style-guide
model: strong # the alias
requires:
  mcp: [code-search]
unknownKey: kept-out
---
Review it.
`;

const EXPECTED = {
  tools: { allow: ["read", "grep", "mcp__code-search__*"], deny: ["bash", "write"] },
  skills: ["code-review", "style-guide"],
  model: "strong",
  requires: { mcp: ["code-search"] },
};

const settingsOf = (p: { tools?: unknown; skills?: unknown; model?: unknown; requires?: unknown }) =>
  ({ tools: p.tools, skills: p.skills, model: p.model, requires: p.requires });

// ─── Parse / serialize ───────────────────────────────────────────────

test("parse: flow and block style read the same settings; serialize round-trips them", () => {
  for (const raw of [FLOW, BLOCK]) {
    const p = parsePersonaFile("reviewer", raw, { kind: "team" });
    assertEquals(settingsOf(p), EXPECTED);
    assertEquals(p.title, "Reviewer");
    assertEquals(p.content, "Review it.\n");
    assertEquals(validatePersonaSettings(rawPersonaSettings(raw)), { errors: [], warnings: [] });
    const text = serializePersona(p);
    // Unknown keys are ignored (and so not written back), as before.
    assertEquals(text.includes("unknownKey"), false);
    const again = parsePersonaFile("reviewer", text, { kind: "team" });
    assertEquals(settingsOf(again), EXPECTED);
    assertEquals(serializePersona(again), text);
  }
  // Written flow style, list items quoted (a leading `*` is a YAML alias otherwise).
  const text = serializePersona({ title: "T", content: "", tools: { deny: ["*"] }, skills: [] });
  assert(text.includes('tools: { deny: ["*"] }\n'), text);
  assert(text.includes("skills: []\n"), text);
  assertEquals(settingsOf(parsePersonaFile("t", text, { kind: "team" })), { tools: { deny: ["*"] }, skills: [], model: undefined, requires: undefined });
});

test("parse: a persona without settings is unchanged; serialize writes none", () => {
  const raw = "---\ntitle: Plain\ndescription: \"\"\ntags: [a]\n---\nBody\n";
  const p = parsePersonaFile("plain", raw, { kind: "team" });
  assertEquals(settingsOf(p), { tools: undefined, skills: undefined, model: undefined, requires: undefined });
  assertEquals(serializePersona(p), raw);
});

// ─── Lint ────────────────────────────────────────────────────────────

test("lint: wrong shapes are errors and the field is left out", () => {
  const raw = "---\ntitle: z\ntools: read\nskills: code-review\nmodel: [a, b]\nrequires: { mcp: x }\n---\n";
  const lint = validatePersonaSettings(rawPersonaSettings(raw));
  assertEquals(lint.errors.length, 4);
  assert(lint.errors[0]!.startsWith("`tools` must be a map"));
  assert(lint.errors[1]!.startsWith("`skills` must be a list"));
  assert(lint.errors[2]!.startsWith("`model` must be a single model alias"));
  assert(lint.errors[3]!.startsWith("`requires.mcp` must be a list"));
  assertEquals(settingsOf(parsePersonaFile("z", raw, { kind: "team" })), { tools: undefined, skills: undefined, model: undefined, requires: undefined });
  // JSON shapes (a save request) go through the same checks.
  assertEquals(readPersonaSettings({ skills: ["ok", 3], tools: { allow: "read" } }).errors.length, 2);
});

test("lint: tool patterns allow only `*` wildcards", () => {
  const r = readPersonaSettings({ tools: { allow: ["read", "mcp__*", "file?", "[ab]", "{x,y}", "two words"] } });
  assertEquals(r.errors.length, 4);
  assert(r.errors.every((e) => e.includes("only `*` wildcards")));
  assertEquals(r.settings.tools, { allow: ["read", "mcp__*"] });
  assertEquals(matchesToolPattern("mcp__*", "mcp__server__tool"), true);
  assertEquals(matchesToolPattern("mcp__*", "read"), false);
  assertEquals(matchesToolPattern("re.d", "read"), false, "only * is special");
});

test("lint: deny overlapping allow, an empty allow, unknown keys and unknown aliases warn", () => {
  const overlap = readPersonaSettings({ tools: { allow: ["read", "bash", "mcp__x__*"], deny: ["bash", "mcp__*"] } });
  assertEquals(overlap.errors, []);
  assertEquals(overlap.warnings.length, 2);
  assert(overlap.warnings[0]!.includes('"bash" overrides `tools.allow` "bash"'));
  assert(overlap.warnings[1]!.includes('"mcp__*" overrides `tools.allow` "mcp__x__*"'));
  // A deny that narrows a broader allow is the normal use: no warning.
  assertEquals(readPersonaSettings({ tools: { allow: ["mcp__*"], deny: ["mcp__x__write"] } }).warnings, []);

  const empty = readPersonaSettings({ tools: { allow: [] } });
  assertEquals(empty.settings.tools, { allow: [] });
  assert(empty.warnings[0]!.startsWith("`tools.allow` is empty"));

  const unknown = readPersonaSettings({ tools: { allowed: ["x"] }, requires: { mcp: ["a"], http: ["b"] } });
  assert(unknown.warnings.some((w) => w.startsWith("`tools.allowed` is not a known key")));
  assert(unknown.warnings.some((w) => w.startsWith("`requires.http` is not a known key")));
  assertEquals(unknown.settings.requires, { mcp: ["a"] });

  // Model aliases are only checked when the team's are given.
  assertEquals(readPersonaSettings({ model: "strong" }).warnings, []);
  assertEquals(readPersonaSettings({ model: "strong" }, { modelAliases: ["strong"] }).warnings, []);
  assert(readPersonaSettings({ model: "huge" }, { modelAliases: ["strong"] }).warnings[0]!.includes('"huge" is not a model alias'));
});

test("packages: settings are linted at registration — errors mark lintError, warnings are returned", () => {
  const registry = new PackagePersonas();
  const res = registry.register({ name: "acme", identity: "local:/x" }, [
    { name: "good", raw: FLOW },
    { name: "bad", raw: "---\ntitle: Bad\ntools: [read]\n---\nBody\n" },
    { name: "odd", raw: "---\ntitle: Odd\ntools: { allow: [] }\n---\nBody\n" },
  ]);
  assertEquals(res.personas, ["acme/good", "acme/bad", "acme/odd"]);
  assertEquals(settingsOf(registry.get("acme/good")!), EXPECTED);
  assert(registry.get("acme/bad")!.lintError!.startsWith("`tools` must be a map"));
  assertEquals(res.errors.length, 1);
  assert(res.errors[0]!.startsWith("persona acme/bad: `tools` must be a map"));
  assert(res.warnings.some((w) => w.startsWith("persona acme/odd: `tools.allow` is empty")));
});

// ─── Routes, claim, assistant ────────────────────────────────────────

test("routes: save, keep, clear and refuse settings", async () => {
  await withTeam({}, async ({ app, teamDir }) => {
    const bad = await app.request("/api/personas", jsonInit("POST", { title: "Bad", content: "x", tools: { allow: ["a?"] } }));
    assertEquals(bad.status, 400);
    assert(((await bad.json()) as { errors: string[] }).errors[0]!.includes("only `*` wildcards"));

    const created = await (await app.request("/api/personas", jsonInit("POST", { title: "Reviewer", content: "Review it.\n", ...EXPECTED }))).json();
    assertEquals(settingsOf(created.persona), EXPECTED);
    const file = fs.readFileSync(path.join(teamDir, "personas", "reviewer.md"), "utf8");
    assert(file.includes('requires: { mcp: ["code-search"] }'), file);

    // Absent keeps; a value replaces; null clears.
    const kept = await (await app.request("/api/personas/reviewer", jsonInit("PUT", { content: "Review it twice.\n" }))).json();
    assertEquals(settingsOf(kept.persona), EXPECTED);
    const changed = await (await app.request("/api/personas/reviewer", jsonInit("PUT", { model: "fast", skills: null, tools: { allow: ["bash"], deny: ["bash"] } }))).json();
    assertEquals(changed.success, true);
    assertEquals(changed.persona.model, "fast");
    assertEquals(changed.persona.skills, undefined);
    assertEquals(changed.persona.tools, { allow: ["bash"], deny: ["bash"] });
    assert(changed.warnings.some((w: string) => w.includes("overrides `tools.allow`")));
    const cleared = await (await app.request("/api/personas/reviewer", jsonInit("PUT", { tools: null, model: null, requires: null }))).json();
    assertEquals(settingsOf(cleared.persona), { tools: undefined, skills: undefined, model: undefined, requires: undefined });
    assertEquals((await app.request("/api/personas/reviewer", jsonInit("PUT", { skills: "x" }))).status, 400);
  });
});

test("claim and assistant: the persona's settings travel with it; a duplicate keeps them", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createPersona({ title: "Reviewer", content: "Review it.", ...EXPECTED });
    store.createPersona({ title: "Plain", content: "Just do it." });

    // The claim's `persona`, for a harness that does the system prompt and one that doesn't.
    for (const [agent, caps] of [["new", [PERSONA_SYSTEM_PROMPT_CAPABILITY]], ["old", undefined]] as const) {
      await app.request("/api/agents/register", jsonInit("POST", { id: agent, name: agent, directory: "/tmp", ...(caps ? { capabilities: caps } : {}) }));
      const def = store.createWorkDef({ title: `Review ${agent}`, goal: "Look.", acceptanceCriteria: "Done.", persona: "reviewer" });
      const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
      const res = await (await app.request(`/api/agents/claim/${item.id}`, jsonInit("POST", { agentId: agent }))).json() as AgentClaimResponse;
      assertEquals(res.persona?.id, "reviewer");
      assertEquals(settingsOf(res.persona!), EXPECTED);
    }
    // A persona without settings sends none (the payload is as before).
    await app.request("/api/agents/register", jsonInit("POST", { id: "plain", name: "plain", directory: "/tmp" }));
    const def = store.createWorkDef({ title: "Plain", goal: "Look.", acceptanceCriteria: "Done.", persona: "plain" });
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
    const plain = await (await app.request(`/api/agents/claim/${item.id}`, jsonInit("POST", { agentId: "plain" }))).json() as AgentClaimResponse;
    assertEquals(Object.keys(plain.persona!).sort(), ["body", "id", "inline", "prompt", "title"]);

    // The assistant persona the leader reads.
    await app.request("/api/assistant/persona", jsonInit("PUT", { personaId: "reviewer" }));
    const assistant = await (await app.request("/api/assistant/persona")).json();
    assertEquals(settingsOf(assistant.persona), EXPECTED);

    const dup = store.duplicatePersona("reviewer");
    assert(dup.ok);
    if (dup.ok) assertEquals(settingsOf(dup.persona), EXPECTED);
  });
});

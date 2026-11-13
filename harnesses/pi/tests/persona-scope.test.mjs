// The persona's tool and skill scope (src/persona-scope.ts, its wiring in
// src/index.ts and src/leader.ts, the persona hook in src/teammate.ts): the
// active tools follow the persona's `tools` allow/deny, MPT's protocol tools
// are always kept, a call the persona doesn't permit is blocked (also from
// codemode), the skill listing follows `skills`, the full set comes back
// between items, and what can't be applied is reported once
// (my-pizza-team docs/DESIGN.md "Persona settings").
//
// Run: node --test --experimental-strip-types tests/persona-scope.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const scope = await import("../src/persona-scope.ts");
const {
  MPT_PROTOCOL_TOOLS, PersonaToolScope, applyPersonaScope, checkSkillCommand, checkToolCall,
  filterSkills, isToolPermitted, matchesPattern, reportScopeOnce, scopeProblems,
} = scope;
const { TeammateLoop } = await import("../src/teammate.ts");

/** A fake Pi tool API: `all` registered, `active` the declared set; records setActiveTools calls. */
function fakePi(all, active = all) {
  const pi = {
    active: [...active],
    calls: 0,
    getAllTools: () => all.map((name) => ({ name })),
    getActiveTools: () => [...pi.active],
    setActiveTools: (names) => { pi.calls++; pi.active = names.filter((n) => all.includes(n)); },
  };
  return pi;
}

const BUILTIN = ["read", "bash", "edit", "write", "codemode", "mcp__docs__search", "mcp__docs__fetch"];
const TEAMMATE = [...BUILTIN, "upload_attachment", "fail", "propose_work"];

/** A `before_agent_start` event with the prompt options this reads. */
function event(selectedTools, skills = []) {
  return { systemPrompt: "BASE", systemPromptOptions: { selectedTools: [...selectedTools], skills: skills.map((name) => ({ name })) } };
}

test("matchesPattern: exact names, and `*` as any run of characters only", () => {
  assert.ok(matchesPattern("read", "read"));
  assert.ok(!matchesPattern("reader", "read"));
  assert.ok(matchesPattern("mcp__docs__search", "mcp__docs__*"));
  assert.ok(matchesPattern("mcp__docs__search", "*search"));
  assert.ok(!matchesPattern("mcp__docsXsearch", "mcp__docs.*"), "a dot is literal");
  assert.ok(matchesPattern("anything", "*"));
});

test("isToolPermitted: no policy = all; allow narrows (empty = none); deny wins", () => {
  assert.ok(isToolPermitted("bash", undefined));
  assert.ok(isToolPermitted("bash", {}));
  assert.ok(isToolPermitted("bash", { deny: ["edit"] }));
  assert.ok(!isToolPermitted("edit", { deny: ["edit"] }));
  assert.ok(isToolPermitted("read", { allow: ["read", "mcp__*"] }));
  assert.ok(!isToolPermitted("bash", { allow: ["read", "mcp__*"] }));
  assert.ok(!isToolPermitted("mcp__docs__fetch", { allow: ["read", "mcp__*"], deny: ["*fetch"] }));
  assert.ok(!isToolPermitted("read", { allow: [] }));
});

test("protocol tools are always permitted and kept, whatever the persona says", () => {
  for (const t of ["fail", "upload_attachment", "propose_work", "wait_for_next_check", "create_task"]) {
    assert.ok(isToolPermitted(t, { allow: [] }), t);
    assert.ok(isToolPermitted(t, { deny: ["*"] }), t);
  }
  const pi = fakePi(TEAMMATE);
  new PersonaToolScope(pi).applyTools({ allow: [], deny: ["fail"] });
  assert.deepStrictEqual(pi.active, ["upload_attachment", "fail", "propose_work"]);
});

test("MPT_PROTOCOL_TOOLS names every tool tools.ts registers", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/tools.ts"), "utf-8");
  const names = [...src.matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  names.push("wait_for_next_check"); // registered as `name: WAIT_TOOL`
  assert.ok(names.length > 15);
  assert.deepStrictEqual([...new Set(names)].sort(), [...MPT_PROTOCOL_TOOLS].sort());
});

test("applyTools: allow minus deny; never turns on a tool that was off; only sets on a change", () => {
  const pi = fakePi([...TEAMMATE, "inactive_tool"], TEAMMATE);
  const s = new PersonaToolScope(pi);
  s.applyTools({ allow: ["read", "mcp__docs__*", "inactive_tool"], deny: ["mcp__docs__fetch"] });
  assert.deepStrictEqual(pi.active, ["read", "mcp__docs__search", "upload_attachment", "fail", "propose_work"]);
  assert.strictEqual(s.scoped, true);
  const calls = pi.calls;
  s.applyTools({ allow: ["read", "mcp__docs__*"], deny: ["mcp__docs__fetch"] });
  assert.strictEqual(pi.calls, calls, "unchanged: no setActiveTools");
});

test("applyTools: a persona change is computed from the full set, and no policy restores it", () => {
  const pi = fakePi(TEAMMATE);
  const s = new PersonaToolScope(pi);
  s.applyTools({ allow: ["read"] });
  s.applyTools({ allow: ["bash", "edit"] });
  assert.deepStrictEqual(pi.active.filter((t) => BUILTIN.includes(t)), ["bash", "edit"], "not narrowed from the previous persona's set");
  s.applyTools(undefined);
  assert.deepStrictEqual([...pi.active].sort(), [...TEAMMATE].sort());
  assert.strictEqual(s.scoped, false);
  const calls = pi.calls;
  s.applyTools(undefined);
  assert.strictEqual(pi.calls, calls, "unscoped and nothing to restore: untouched");
});

test("applyTools: leaves the protocol tools' own managers alone (the poll-only wait tool)", () => {
  const pi = fakePi([...TEAMMATE, "wait_for_next_check"], TEAMMATE);
  const s = new PersonaToolScope(pi);
  s.applyTools({ allow: ["read"] });
  assert.ok(!pi.active.includes("wait_for_next_check"), "not switched on by the persona");
  pi.active.push("wait_for_next_check"); // the claim's state polls (wait-tool.ts)
  s.applyTools(undefined);
  assert.ok(pi.active.includes("wait_for_next_check"), "nor switched off by the restore");
});

test("checkToolCall: blocks a tool the persona doesn't permit, naming the persona — nested calls too", () => {
  const persona = { id: "reviewer", tools: { allow: ["read", "codemode"], deny: ["mcp__*"] } };
  assert.strictEqual(checkToolCall(persona, { toolName: "read" }), undefined);
  assert.strictEqual(checkToolCall(persona, { toolName: "fail" }), undefined, "protocol tools never blocked");
  const direct = checkToolCall(persona, { toolName: "bash" });
  assert.strictEqual(direct.block, true);
  assert.match(direct.reason, /'bash'.*persona reviewer/);
  const nested = checkToolCall(persona, { toolName: "mcp__docs__search", parentToolCallId: "call_1" });
  assert.strictEqual(nested.block, true, "a call made from codemode is checked like any other");
  assert.match(nested.reason, /'mcp__docs__search' \(called from another tool\).*persona reviewer/);
  assert.strictEqual(checkToolCall(null, { toolName: "bash" }), undefined, "no persona: nothing blocked");
  assert.strictEqual(checkToolCall({ id: "p" }, { toolName: "bash" }), undefined, "no tools policy: nothing blocked");
});

test("skills: the listing is trimmed to the persona's skills, and /skill: for others is refused", () => {
  const skills = ["git", "docs", "deploy"].map((name) => ({ name }));
  filterSkills(skills, ["docs", "missing"]);
  assert.deepStrictEqual(skills.map((s) => s.name), ["docs"]);
  const all = [{ name: "git" }];
  filterSkills(all, undefined);
  assert.deepStrictEqual(all, [{ name: "git" }], "absent = all kept");

  const persona = { id: "writer", skills: ["docs"] };
  assert.strictEqual(checkSkillCommand(persona, "/skill:docs write it"), undefined);
  assert.strictEqual(checkSkillCommand(persona, "hello"), undefined);
  assert.strictEqual(checkSkillCommand({ id: "x" }, "/skill:git"), undefined, "no skills setting: all allowed");
  const refused = checkSkillCommand(persona, "/skill:git push");
  assert.strictEqual(refused.action, "transform");
  assert.match(refused.text, /'git'.*persona writer.*docs/);
  assert.ok(!refused.text.startsWith("/skill:"), "not expanded");
});

test("scopeProblems: unmatched patterns, a denied protocol tool, and unloaded skills, one line each", () => {
  const problems = scopeProblems(
    { id: "aim-reviewer", tools: { allow: ["read", "foo*"], deny: ["fail", "nope"] }, skills: ["docs", "ghost"] },
    TEAMMATE, ["docs"],
  );
  assert.deepStrictEqual(problems, [
    "persona aim-reviewer: tools.allow pattern 'foo*' matched no tools",
    "persona aim-reviewer: tools.deny pattern 'fail' can't remove MPT's protocol tools; they stay available",
    "persona aim-reviewer: tools.deny pattern 'nope' matched no tools",
    "persona aim-reviewer: skill 'ghost' is not loaded",
  ]);
  assert.deepStrictEqual(scopeProblems({ id: "ok", tools: { allow: ["read"] } }, TEAMMATE, []), []);
});

test("applyPersonaScope: sets tools and the run's selectedTools, filters skills, returns problems", () => {
  const pi = fakePi(TEAMMATE);
  const s = new PersonaToolScope(pi);
  const ev = event(TEAMMATE, ["docs", "git"]);
  const problems = applyPersonaScope(pi, s, { id: "p", tools: { allow: ["read", "zzz*"] }, skills: ["docs"] }, ev);
  assert.deepStrictEqual(pi.active, ["read", "upload_attachment", "fail", "propose_work"]);
  assert.deepStrictEqual(ev.systemPromptOptions.selectedTools, pi.active);
  assert.deepStrictEqual(ev.systemPromptOptions.skills.map((k) => k.name), ["docs"]);
  assert.deepStrictEqual(problems, ["persona p: tools.allow pattern 'zzz*' matched no tools"]);

  const next = event(pi.active, ["docs", "git"]);
  assert.deepStrictEqual(applyPersonaScope(pi, s, null, next), []);
  assert.deepStrictEqual([...pi.active].sort(), [...TEAMMATE].sort(), "restored");
  assert.deepStrictEqual([...next.systemPromptOptions.selectedTools].sort(), [...TEAMMATE].sort());
  assert.deepStrictEqual(next.systemPromptOptions.skills.map((k) => k.name), ["docs", "git"], "no persona: skills untouched");

  const untouched = event(TEAMMATE);
  applyPersonaScope(pi, s, { id: "q" }, untouched);
  assert.deepStrictEqual(untouched.systemPromptOptions.selectedTools, TEAMMATE, "no policy, never scoped: options untouched");
});

test("reportScopeOnce: posts the problems once per key, nothing when there are none", () => {
  const posted = [];
  const seen = new Set();
  assert.strictEqual(reportScopeOnce(seen, "wi-1", [], (t) => posted.push(t)), false);
  assert.strictEqual(reportScopeOnce(seen, "wi-1", ["a", "b"], (t) => posted.push(t)), true);
  assert.strictEqual(reportScopeOnce(seen, "wi-1", ["a", "b"], (t) => posted.push(t)), false);
  reportScopeOnce(seen, "wi-2", ["c"], (t) => posted.push(t));
  assert.deepStrictEqual(posted, ["a\nb", "c"]);
});

/** A running loop whose daemon hands out `claims` in order, with a fake tool API. */
function loopWith(claims, pi) {
  const queue = [...claims];
  pi.sendUserMessage = () => {};
  const client = {
    heartbeat: async () => ({}),
    postComment: async () => ({}),
    setWorkItemState: async () => ({ success: true, completed: true }),
    getNextWork: async () => (queue.length ? { workItem: { id: queue[0].id, title: "t" } } : { workItem: null }),
    claimWorkItem: async () => {
      const c = queue.shift();
      return { success: true, prompt: `## Task: ${c.id}`, persona: c.persona };
    },
  };
  const loop = new TeammateLoop(pi, client);
  loop["running"] = true;
  loop["autonomous"] = true;
  loop.requestFreshSession = () => {};
  return { loop, claimNext: async () => { await loop["pollForWork"](); loop.handleAgentStart(); } };
}

test("between items: the claim applies the persona's tools, the item's end restores the full set", async () => {
  const pi = fakePi(TEAMMATE);
  const { loop, claimNext } = loopWith([
    { id: "wi-1", persona: { id: "reviewer", title: "r", body: "b", prompt: "R", inline: false, tools: { allow: ["read"] } } },
    { id: "wi-2", persona: { id: "plain", title: "p", body: "b", prompt: "P", inline: false } },
  ], pi);
  const s = new PersonaToolScope(pi);
  loop.onPersonaChange = (persona) => { s.applyTools(persona?.tools); }; // as index.ts wires it
  await claimNext();
  assert.deepStrictEqual(pi.active, ["read", "upload_attachment", "fail", "propose_work"]);
  assert.ok(checkToolCall(loop.persona, { toolName: "bash" }));
  loop.handleAgentEnd();
  await loop.handleAgentComplete("done");
  assert.deepStrictEqual([...pi.active].sort(), [...TEAMMATE].sort(), "restored when the item ended");
  assert.strictEqual(checkToolCall(loop.persona, { toolName: "bash" }), undefined);
  await claimNext();
  assert.deepStrictEqual([...pi.active].sort(), [...TEAMMATE].sort(), "a persona without a policy changes nothing");
  loop.stop();
});

const index = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");
const leader = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");

test("index.ts and leader.ts wire the scope into before_agent_start, tool_call and input", () => {
  assert.match(index, /loop\.onPersonaChange = \(persona\) => \{ toolScope\.applyTools\(persona\?\.tools\); \}/);
  assert.match(index, /applyPersonaScope\(pi, toolScope, persona, event\)/);
  assert.match(index, /reportScopeOnce\(reportedScope, workItemId, problems,[\s\S]*?client\.postComment\(workItemId, text\)/);
  assert.match(index, /pi\.on\("tool_call", async \(event\) => checkToolCall\(loop\.persona,/);
  assert.match(index, /pi\.on\("input", async \(event\) => checkSkillCommand\(loop\.persona, event\.text\)\)/);
  assert.match(leader, /applyPersonaScope\(pi, toolScope, chat\.personaScope, event\)/);
  assert.match(leader, /pi\.on\("tool_call", async \(event\) => checkToolCall\(chat\.personaScope,/);
  assert.match(leader, /pi\.on\("input", async \(event\) => checkSkillCommand\(chat\.personaScope, event\.text\)\)/);
});

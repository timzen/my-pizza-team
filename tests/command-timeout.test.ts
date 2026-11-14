/**
 * tests/command-timeout.test.ts — The default command timeout's daemon side
 * and the long-command guidance (docs/DESIGN.md "Stalled Teammates" —
 * prevention).
 *
 * `commandTimeoutMinutes` resolves state → team → default (60; 0 = off), a
 * workflow state's value is validated (and warned about on a manual state),
 * config.json keeps its key order, the claim and the registration reply carry
 * the resolved minutes, and every teammate work prompt (once and poll) carries
 * the one-line guidance. The harness side (applying it to Pi's bash calls) is
 * harnesses/pi/tests/command-timeout.test.mjs.
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { post, withTeam } from "./_team.ts";
import type { TeamConfig, WorkflowConfig } from "../shared/types.ts";
import { DEFAULT_COMMAND_TIMEOUT_MINUTES, resolveCommandTimeoutMinutes } from "../shared/protocol.ts";
import { serializeTeamConfig } from "../shared/team-config.ts";
import { ignoredStateFields, validateWorkflow } from "../daemon/workflow-engine.ts";
import { buildWorkDefPrompt } from "../daemon/prompt.ts";
import { LONG_COMMAND_GUIDANCE } from "../daemon/personas/builtins.ts";

test("resolve: the state's value, else the team's, else 60; nonsense is skipped; 0 is off", () => {
  assertEquals(DEFAULT_COMMAND_TIMEOUT_MINUTES, 60);
  assertEquals(resolveCommandTimeoutMinutes(undefined), 60);
  assertEquals(resolveCommandTimeoutMinutes(90), 90);
  assertEquals(resolveCommandTimeoutMinutes(0), 0);
  assertEquals(resolveCommandTimeoutMinutes(-5), 60);
  assertEquals(resolveCommandTimeoutMinutes("2h"), 60);
  assertEquals(resolveCommandTimeoutMinutes(90, 240), 240);
  assertEquals(resolveCommandTimeoutMinutes(90, 0), 0);
  assertEquals(resolveCommandTimeoutMinutes(90, null), 90);
});

test("config: commandTimeoutMinutes is written after stallMinutes; a state's must be minutes", () => {
  const keys = Object.keys(serializeTeamConfig({ port: 1, apiToken: "t", commandTimeoutMinutes: 0, stallMinutes: 30 } as Partial<TeamConfig> as TeamConfig));
  assertEquals(keys, ["port", "stallMinutes", "commandTimeoutMinutes", "apiToken"]);
  const wf = (commandTimeoutMinutes: unknown): WorkflowConfig => ({ states: [{ name: "build", type: "teammate", commandTimeoutMinutes } as never] });
  assertEquals(validateWorkflow(wf(0)), null);
  assertEquals(validateWorkflow(wf(120)), null);
  assertStringIncludes(validateWorkflow(wf(-1))!, "commandTimeoutMinutes");
  assertStringIncludes(validateWorkflow(wf("1h"))!, "commandTimeoutMinutes");
  assertEquals(ignoredStateFields({ name: "review", type: "manual", commandTimeoutMinutes: 5 }), ["commandTimeoutMinutes"]);
});

test("routes: registration and claim carry the team's commandTimeoutMinutes (default 60)", async () => {
  for (const [cfg, expected] of [[{}, 60], [{ commandTimeoutMinutes: 15 }, 15], [{ commandTimeoutMinutes: 0 }, 0]] as const) {
    await withTeam(cfg, async (t) => {
      const reg = await (await post(t.app, "/api/agents/register", { id: "m1", name: "bright-muad-dib", directory: "/tmp" })).json();
      assertEquals(reg.commandTimeoutMinutes, expected, `register with ${JSON.stringify(cfg)}`);
      const def = t.store.createWorkDef({ title: "Job", goal: "g", acceptanceCriteria: "a" });
      const item = t.store.getActiveWorkItem(def.id)!;
      const claim = await (await post(t.app, `/api/agents/claim/${item.id}`, { agentId: "m1" })).json();
      assertEquals(claim.success, true);
      assertEquals(claim.commandTimeoutMinutes, expected, `claim with ${JSON.stringify(cfg)}`);
    });
  }
});

test("routes: a workflow state's commandTimeoutMinutes overrides the team's on claim", async () => {
  const workflows = { default: { states: [{ name: "build", type: "teammate", commandTimeoutMinutes: 240 }, { name: "review", type: "manual" }] } } as Record<string, WorkflowConfig>;
  await withTeam({ workflows, commandTimeoutMinutes: 30 }, async (t) => {
    await post(t.app, "/api/agents/register", { id: "m1", name: "bright-muad-dib", directory: "/tmp" });
    t.store.createStory("s1", "S1", "D", "open", [], [{ title: "Build it", description: "long build" }], "default");
    const item = t.store.getActiveWorkItem("s1-1")!;
    const claim = await (await post(t.app, `/api/agents/claim/${item.id}`, { agentId: "m1" })).json();
    assertEquals(claim.success, true);
    assertEquals(claim.commandTimeoutMinutes, 240);
    assertEquals(t.store.commandTimeoutMinutesFor("s1-1"), 240);
  });
});

test("prompt: every teammate work prompt carries the long-command guidance, once", () => {
  assertStringIncludes(LONG_COMMAND_GUIDANCE, "with a timeout");
  assertStringIncludes(LONG_COMMAND_GUIDANCE, "watch/serve");
  const workDef = { title: "T", goal: "G", acceptanceCriteria: "" } as never;
  const once = buildWorkDefPrompt({ workDef });
  const poll = buildWorkDefPrompt({ workDef, state: "await-cr", poll: { checks: 0 } } as never);
  assertStringIncludes(poll, "## Completing This Check");
  for (const [name, prompt] of [["once", once], ["poll", poll]] as const) {
    assertEquals(prompt.split(LONG_COMMAND_GUIDANCE).length - 1, 1, `${name}: exactly once`);
  }
  assert(once.indexOf(LONG_COMMAND_GUIDANCE) > once.indexOf("## Completing This Work"), "in the completion section");
});

// The poll-state wait tool on the Pi side (src/wait-tool.ts, src/tools.ts,
// src/teammate.ts): `wait_for_next_check` is registered once but offered (in
// Pi's active tool set) only while the claimed item's state polls — the claim's
// `completion: "poll"` (my-pizza-team docs/DESIGN.md "Polling States").
//
// Run: node --test --experimental-strip-types tests/wait-tool.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const { WAIT_TOOL, setWaitToolActive } = await import("../src/wait-tool.ts");

/** A fake ExtensionAPI with Pi's semantics: setActiveTools ignores unknown names. */
function fakePi(registered = ["read", "bash", "fail", WAIT_TOOL]) {
  let active = [...registered];
  const sets = [];
  return {
    sets,
    get active() { return active; },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveTools: (names) => { sets.push(names); active = names.filter((n) => registered.includes(n)); },
  };
}

test("the wait tool is withdrawn, offered, and withdrawn again, keeping every other tool", () => {
  const pi = fakePi();
  setWaitToolActive(pi, false);
  assert.deepEqual(pi.active, ["read", "bash", "fail"]);
  setWaitToolActive(pi, true);
  assert.deepEqual(pi.active, ["read", "bash", "fail", WAIT_TOOL]);
  setWaitToolActive(pi, false);
  assert.deepEqual(pi.active, ["read", "bash", "fail"]);
});

test("no change, no setActiveTools call (each one lands in the transcript)", () => {
  const pi = fakePi();
  setWaitToolActive(pi, true);
  assert.equal(pi.sets.length, 0);
  setWaitToolActive(pi, false);
  setWaitToolActive(pi, false);
  assert.equal(pi.sets.length, 1);
});

test("never activated before it is registered", () => {
  const pi = fakePi(["read"]);
  setWaitToolActive(pi, true);
  assert.equal(pi.sets.length, 0);
  assert.deepEqual(pi.active, ["read"]);
});

const tools = fs.readFileSync(path.join(import.meta.dirname, "../src/tools.ts"), "utf-8");
const teammate = fs.readFileSync(path.join(import.meta.dirname, "../src/teammate.ts"), "utf-8");
const index = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");

test("registerTeammateTools registers the wait tool and starts it withdrawn", () => {
  const fn = tools.slice(tools.indexOf("export function registerTeammateTools"), tools.indexOf("function registerWaitForNextCheck"));
  assert.ok(fn.includes("registerWaitForNextCheck("));
  assert.ok(fn.includes("setWaitToolActive(pi, false)"));
});

test("the wait tool sends WAITED with the reason, then posts its [wait] comment, and ends the item", () => {
  const fn = tools.slice(tools.indexOf("function registerWaitForNextCheck"));
  assert.ok(fn.includes("client.waitWorkItem(workItemId, p.reason)"));
  assert.ok(fn.indexOf("client.waitWorkItem(") < fn.indexOf("client.postComment("), "comment only once accepted");
  assert.ok(fn.includes("`[wait] ${p.reason.trim()}"));
  assert.ok(fn.includes("onWorkItemWaited?.(workItemId)"));
});

test("the loop reports each claim's completion, and setup offers the tool only for poll", () => {
  assert.ok(teammate.includes(`this.onClaimCompletion?.(claim.completion === "poll" ? "poll" : "once")`));
  assert.ok(index.includes(`loop.onClaimCompletion = (completion) => setWaitToolActive(pi, completion === "poll")`));
});

// Interrupt, in the Pi harness (src/runtime/interrupt.ts wired by src/index.ts,
// the work loop's side in src/teammate.ts; my-pizza-team docs/DESIGN.md
// "Stalled Teammates"): a user interrupts a teammate stuck on a hung command.
//
// With Pi's real bash tool and a real hung subprocess (a backgrounded sleep and
// a foreground one — a test runner and its worker, say): aborting the run's
// signal, which is what `ctx.abort()` does to the tool in flight, kills the
// command's whole process tree; the aborted run's end is not the item's
// completion; once the run settles the nudge goes in as the item's next run
// (naming the command), the directive is reported done, and the item
// completes when *that* run ends. Plus the poll's routing of an `interrupt`
// and the wiring in index.ts.
//
// Run: node --test --experimental-strip-types tests/interrupt.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";

const { InterruptRealizer } = await import("../src/runtime/interrupt.ts");
const { ActivityTracker } = await import("../src/runtime/activity.ts");
const { TeammateLoop } = await import("../src/teammate.ts");

/** Is process `pid` still alive? */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Wait until `fn()` holds (up to `ms`). */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

/** A work loop holding wi-1 mid-run, on fakes that record what reaches Pi and the daemon. */
function workingLoop() {
  const sent = [];
  const daemon = { comments: [], states: [], reports: [] };
  const pi = { sendUserMessage: (text, opts) => { sent.push({ text, opts }); } };
  const client = {
    heartbeat: async () => ({}),
    postComment: async (id, c) => { daemon.comments.push([id, c]); return {}; },
    setWorkItemState: async (id, st) => { daemon.states.push([id, st]); return { success: true, completed: st === "COMPLETE" }; },
    getNextWork: async () => ({}),
    completeSelfDirective: async (id, status, error) => { daemon.reports.push([id, status, error]); return {}; },
  };
  const loop = new TeammateLoop(pi, client);
  loop["currentWorkItemId"] = "wi-1";
  loop["awaitingWorkRun"] = false;
  loop["autonomous"] = true;
  loop.handleAgentStart();
  loop.requestFreshSession = () => {};
  return { loop, sent, daemon, client };
}

test("interrupt kills a hung bash command's whole process tree, keeps the item, and nudges the agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-interrupt-"));
  const pidFile = path.join(dir, "child.pid");
  try {
    const { loop, sent, daemon, client } = workingLoop();
    // The run in flight: Pi's bash tool on a command that never returns. Its
    // signal is the run's — what ctx.abort() aborts.
    const run = new AbortController();
    const tracker = new ActivityTracker();
    tracker.runStarted();
    const command = `sleep 3601 & echo $! > ${JSON.stringify(pidFile)}; echo $$ >> ${JSON.stringify(pidFile)}; sleep 3602`;
    tracker.toolStarted("call-1", "bash", { command });
    const bash = createBashTool(dir);
    const execution = bash.execute("call-1", { command }, run.signal, () => {});
    const settled = execution.then(() => "returned", (e) => `threw: ${e.message}`);
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split("\n").length === 2), "the command started");
    const pids = fs.readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.ok(pids.every(alive), "the shell and its backgrounded child are running");

    const interrupts = new InterruptRealizer({
      workItemId: () => loop.currentTask,
      isRunning: () => loop.isAgentRunning,
      isAutonomous: () => loop.isAutonomous,
      activity: () => tracker.report(),
      markInterrupted: (id) => loop.markInterrupted(id),
      abort: () => run.abort(),
      sendNudge: (text) => loop.sendWorkFollowUp(text),
      complete: (id, status, error) => client.completeSelfDirective(id, status, error),
    });
    await interrupts.offer({ id: "d1", params: {} });

    // The tool call ends, and every process it started is gone.
    assert.match(await settled, /^threw: .*abort/i);
    assert.ok(await until(() => !pids.some(alive)), `still alive: ${pids.filter(alive).join(", ")}`);
    tracker.toolEnded("call-1");

    // The aborted run ends (agent_end): not a completion — the item stays claimed.
    loop.handleAgentEnd();
    tracker.runEnded();
    await loop.handleAgentComplete("I was running the tests", undefined);
    assert.deepStrictEqual(daemon.states, [], "no COMPLETE for the aborted run");
    assert.ok(!daemon.comments.some(([, c]) => c.startsWith("[done]")));
    assert.strictEqual(loop.currentTask, "wi-1");
    assert.deepStrictEqual(sent, [], "no nudge before the run settled");

    // It settles (agent_settled): the nudge goes in as the item's next message.
    await interrupts.runSettled();
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].opts, { deliverAs: "followUp" });
    assert.match(sent[0].text, /^Your last command \(`sleep 3601 & .*`\) was interrupted by the user after \d+m with no progress\. It likely hung\./);
    assert.match(sent[0].text, /re-run with a timeout, then continue your task\.$/);
    assert.deepStrictEqual(daemon.reports, [["d1", "done", undefined]]);

    // A foreign agent_end before the nudge's run starts is ignored; the nudge's run completes the item.
    await loop.handleAgentComplete("stale", undefined);
    assert.deepStrictEqual(daemon.states, []);
    loop.handleAgentStart();
    loop.handleAgentEnd();
    await loop.handleAgentComplete("The persona-model test never settled; fixed it and re-ran with --test-timeout.", undefined);
    assert.deepStrictEqual(daemon.states, [["wi-1", "COMPLETE"]]);
    loop.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop's poll hands an `interrupt` to onInterruptDirective (and fails it when nothing is wired)", async () => {
  const { loop, client, daemon } = workingLoop();
  client.getSelfDirectives = async () => ({ directives: [{ id: "d9", action: "interrupt", params: { reason: "hung" } }] });
  loop["running"] = true;
  loop.onSessionDirective = () => { throw new Error("must not roll the session"); };
  const offered = [];
  loop.onInterruptDirective = (d) => { offered.push(d.id); };
  await loop["pollSessionDirectives"]();
  assert.deepStrictEqual(offered, ["d9"]);
  assert.deepStrictEqual(daemon.reports, []);
  loop.onInterruptDirective = null;
  await loop["pollSessionDirectives"]();
  assert.deepStrictEqual(daemon.reports, [["d9", "failed", undefined]], "an older wiring fails it rather than leaving it queued");
  loop.stop();
});

test("markInterrupted only applies to the item held", async () => {
  const { loop, daemon } = workingLoop();
  loop.markInterrupted("wi-other");
  loop.handleAgentEnd();
  await loop.handleAgentComplete("done", undefined);
  assert.deepStrictEqual(daemon.states, [["wi-1", "COMPLETE"]]);
  loop.stop();
});

test("index.ts declares `interrupt` and wires the realizer: ctx.abort(), the loop, agent_settled", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
  assert.ok(/const capabilities = \[[^\]]*INTERRUPT_CAPABILITY\]/.test(src), "declared at registration");
  assert.ok(src.includes("abort: () => ctx.abort(),"), "aborts the way Pi's Escape does");
  assert.ok(src.includes("sendNudge: (text) => loop.sendWorkFollowUp(text),"));
  assert.ok(src.includes("loop.onInterruptDirective = (directive) => interrupts.offer(directive);"));
  assert.ok(/pi\.on\("agent_settled", async \(\) => \{[\s\S]*?await interrupts\.runSettled\(\);/.test(src), "the nudge after the run settles");
  assert.ok(src.includes("interrupts.stop();"), "stopped with the session");
});

// Behavioral tests for finding the permission system's service and registering
// our authorizer link on it (src/permissions.ts).
// Run with: node --experimental-strip-types tests/permission-service.test.mjs
//
// @gotgenes/pi-permission-system 29.0.0 removed the process-root service slot; the
// service now lives in a map keyed by session id. Reading only the old slot made
// every teammate warn "not installed" while it was installed — and, worse, never
// registered the ppt-autonomous link, so the asks it answers prompted instead.
// These run the real functions against fake globals and a fake event bus, in each
// shape the permission system has published.

import * as assert from "node:assert";
import {
  findPermissionsService,
  registerAutonomousAuthorizer,
  warnIfPermissionSystemAbsent,
  PERMISSIONS_SESSION_SERVICES_KEY,
  PERMISSIONS_LEGACY_SERVICE_KEY,
  AUTONOMOUS_AUTHORIZER,
} from "../src/permissions.ts";

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}: ${e.message}`); }
}

/** A fake PermissionsService that records registrations (and throws on duplicates, like the real one). */
function fakeService() {
  const links = new Map();
  return {
    links,
    registerAuthorizer(name, authorize) {
      if (links.has(name)) throw new Error(`duplicate ${name}`);
      links.set(name, authorize);
      return () => links.delete(name);
    },
  };
}
/** A fake Pi event bus. */
function fakeEvents() {
  const handlers = new Map();
  return {
    on(channel, h) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(h);
      return () => handlers.get(channel).delete(h);
    },
    emit(channel, data) { for (const h of handlers.get(channel) ?? []) h(data); },
    count(channel) { return handlers.get(channel)?.size ?? 0; },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("finding the service");

await test("≥ 29: found in the session-keyed map, for our session only", () => {
  const ours = fakeService(), theirs = fakeService();
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-1", ours], ["s-child", theirs]]) };
  assert.strictEqual(findPermissionsService("s-1", globals), ours);
  assert.strictEqual(findPermissionsService("s-other", globals), undefined);
});

await test("< 29: found in the legacy process-root slot", () => {
  const legacy = fakeService();
  assert.strictEqual(findPermissionsService("s-1", { [PERMISSIONS_LEGACY_SERVICE_KEY]: legacy }), legacy);
});

await test("the keyed service wins over a legacy one (27–28 publish both)", () => {
  const keyed = fakeService(), legacy = fakeService();
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-1", keyed]]), [PERMISSIONS_LEGACY_SERVICE_KEY]: legacy };
  assert.strictEqual(findPermissionsService("s-1", globals), keyed);
});

await test("not installed: nothing found", () => {
  assert.strictEqual(findPermissionsService("s-1", {}), undefined);
});

console.log("registering the autonomous link");

await test("registers on this session's service when it's already up", async () => {
  const svc = fakeService();
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-1", svc]]) };
  let autonomous = true;
  registerAutonomousAuthorizer(fakeEvents(), "s-1", () => autonomous, globals);
  const link = svc.links.get(AUTONOMOUS_AUTHORIZER);
  assert.ok(link, "the link is registered");
  assert.deepStrictEqual(await link({}, null, {}), { kind: "allow" });
  autonomous = false;
  assert.deepStrictEqual(await link({}, null, {}), { kind: "defer" });
});

await test("registers when the permission system starts after us (its permissions:ready)", () => {
  const map = new Map();
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: map };
  const events = fakeEvents();
  registerAutonomousAuthorizer(events, "s-1", () => true, globals);
  const svc = fakeService();
  map.set("s-1", svc);
  events.emit("permissions:ready", { sessionId: "s-1", adjudicatesLocally: true });
  assert.ok(svc.links.has(AUTONOMOUS_AUTHORIZER));
  // ready repeats (it re-announces at the first before_agent_start): still one link, no throw.
  events.emit("permissions:ready", { sessionId: "s-1", adjudicatesLocally: true });
  assert.strictEqual(svc.links.size, 1);
});

await test("ignores another session's ready — a subagent's service is not ours", () => {
  const child = fakeService();
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-child", child]]) };
  const events = fakeEvents();
  registerAutonomousAuthorizer(events, "s-1", () => true, globals);
  events.emit("permissions:ready", { sessionId: "s-child", adjudicatesLocally: true });
  assert.strictEqual(child.links.size, 0);
});

await test("disposing drops the registration and the listener (session shutdown)", () => {
  const svc = fakeService();
  const events = fakeEvents();
  const dispose = registerAutonomousAuthorizer(events, "s-1", () => true, { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-1", svc]]) });
  dispose();
  assert.strictEqual(svc.links.size, 0);
  assert.strictEqual(events.count("permissions:ready"), 0);
});

await test("works against a legacy install too", () => {
  const legacy = fakeService();
  registerAutonomousAuthorizer(fakeEvents(), "s-1", () => true, { [PERMISSIONS_LEGACY_SERVICE_KEY]: legacy });
  assert.ok(legacy.links.has(AUTONOMOUS_AUTHORIZER));
});

console.log("the not-installed warning");

await test("installed (≥ 29): no warning — the reported bug", async () => {
  let warned = 0;
  const globals = { [PERMISSIONS_SESSION_SERVICES_KEY]: new Map([["s-1", fakeService()]]) };
  warnIfPermissionSystemAbsent(fakeEvents(), "s-1", () => warned++, { graceMs: 10, globals });
  await sleep(30);
  assert.strictEqual(warned, 0);
});

await test("starts after us: its ready within the grace period cancels the warning", async () => {
  let warned = 0;
  const events = fakeEvents();
  warnIfPermissionSystemAbsent(events, "s-1", () => warned++, { graceMs: 30, globals: {} });
  events.emit("permissions:ready", { sessionId: "s-1", adjudicatesLocally: true });
  await sleep(60);
  assert.strictEqual(warned, 0);
  assert.strictEqual(events.count("permissions:ready"), 0, "and stops listening");
});

await test("published during the grace period without a broadcast we heard: no warning", async () => {
  let warned = 0;
  const map = new Map();
  warnIfPermissionSystemAbsent(fakeEvents(), "s-1", () => warned++, { graceMs: 20, globals: { [PERMISSIONS_SESSION_SERVICES_KEY]: map } });
  map.set("s-1", fakeService());
  await sleep(50);
  assert.strictEqual(warned, 0);
});

await test("really absent: warns once, after the grace period", async () => {
  let warned = 0;
  warnIfPermissionSystemAbsent(fakeEvents(), "s-1", () => warned++, { graceMs: 20, globals: {} });
  assert.strictEqual(warned, 0, "not immediately");
  await sleep(60);
  assert.strictEqual(warned, 1);
});

await test("cancelled at shutdown: never warns", async () => {
  let warned = 0;
  const cancel = warnIfPermissionSystemAbsent(fakeEvents(), "s-1", () => warned++, { graceMs: 20, globals: {} });
  cancel();
  await sleep(50);
  assert.strictEqual(warned, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

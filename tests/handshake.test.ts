/**
 * tests/handshake.test.ts — The agent registration version handshake (P1b).
 *
 * The failure this exists to prevent (BATTERIES_INCLUDED.md §1.2): the daemon and
 * the harness are one protocol, and when they drifted nothing noticed. An old
 * extension kept running while streaming no transcript and recording no usage,
 * with no hint why. So an unservable *protocol* is refused loudly here.
 *
 * The other half matters just as much: build versions must NOT be gated on.
 * Rejecting on those would nag the whole team on every patch release until people
 * learned to ignore the warning, which is how a real signal gets lost.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../daemon/app.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../shared/protocol.ts";

const testDir = Deno.makeTempDirSync({ prefix: "mpt-handshake-test-" });
Deno.writeTextFileSync(`${testDir}/config.json`, JSON.stringify(DEFAULT_CONFIG));
const { app, store } = createApp(testDir);

const register = (body: Record<string, unknown>) =>
  app.request("/api/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("a matching protocol registers, and the daemon reports its own versions", async () => {
  const res = await register({
    id: "a1",
    name: "swift-ripley",
    protocolVersion: PROTOCOL_VERSION,
    harness: "pi",
    harnessVersion: "0.17.2",
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { success: boolean; protocolVersion: number; daemonVersion: string };
  assertEquals(body.success, true);
  assertEquals(body.protocolVersion, PROTOCOL_VERSION);
  assertEquals(typeof body.daemonVersion, "string");

  const member = store!.getMember("a1")!;
  assertEquals(member.protocolVersion, PROTOCOL_VERSION);
  assertEquals(member.harness, "pi");
  assertEquals(member.harnessVersion, "0.17.2");
});

Deno.test("a harness from the future is refused, naming the fix", async () => {
  const res = await register({
    id: "a2",
    name: "future-agent",
    protocolVersion: PROTOCOL_VERSION + 1,
    harness: "pi",
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { success: boolean; error: string };
  assertEquals(body.success, false);
  assertStringIncludes(body.error, "mpt upgrade");
  // Refused means *not registered* — a half-registered agent is the thing to avoid.
  assertEquals(store!.getMember("a2"), null);
});

Deno.test("a harness below the minimum is refused, naming the fix", async () => {
  if (MIN_PROTOCOL_VERSION <= 0) return; // nothing below the floor to test yet
  const res = await register({
    id: "a3",
    name: "ancient-agent",
    protocolVersion: MIN_PROTOCOL_VERSION - 1,
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { success: boolean; error: string };
  assertStringIncludes(body.error, "Restart the agent");
  assertEquals(store!.getMember("a3"), null);
});

Deno.test("a pre-handshake harness is accepted and flagged, not stranded", async () => {
  // Upgrading the daemon first must not kill a running team, so an omitted
  // protocolVersion registers — recorded as undefined so the UI can surface it.
  const res = await register({ id: "a4", name: "legacy-agent" });
  assertEquals(res.status, 200);
  const member = store!.getMember("a4")!;
  assertEquals(member.protocolVersion, undefined);
  assertEquals(member.harness, undefined);
});

Deno.test("a differing build version is tolerated — only the protocol gates", async () => {
  // The whole point of separating the two: a daemon patch release must not reject
  // every agent still reporting the previous build.
  const res = await register({
    id: "a5",
    name: "older-build",
    protocolVersion: PROTOCOL_VERSION,
    harness: "pi",
    harnessVersion: "0.0.1-ancient",
  });
  assertEquals(res.status, 200);
  assertEquals(store!.getMember("a5")!.harnessVersion, "0.0.1-ancient");
});

Deno.test("a non-Pi harness can register — the field is open-ended", async () => {
  // Tier 0 harnesses self-report (BATTERIES_INCLUDED.md §3.2). Costing one field
  // now avoids versioning the handshake twice later.
  const res = await register({
    id: "a6",
    name: "claude-1",
    protocolVersion: PROTOCOL_VERSION,
    harness: "claude",
  });
  assertEquals(res.status, 200);
  assertEquals(store!.getMember("a6")!.harness, "claude");
});

Deno.test({
  name: "cleanup handshake test",
  fn() {
    store?.close();
    Deno.removeSync(testDir, { recursive: true });
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

/**
 * tests/harness-skew.test.ts — What the UI treats as version skew
 * (ui/src/lib/team.ts `harnessSkew`).
 *
 * The rule has to draw two lines carefully:
 *
 *   - Only *build* version, never protocol. An unservable protocol is already
 *     refused at registration (tests/handshake.test.ts), so what's left to
 *     surface is the silent case: an agent still on an older extension that keeps
 *     working while streaming no transcript and recording no usage
 *     (BATTERIES_INCLUDED.md §1.2).
 *   - Only *online* agents. Flagging every offline row would make the warning
 *     ambient, and an ambient warning is one people stop reading — the same
 *     reason P1b-3 refuses to gate on build version.
 */

import { assertEquals } from "@std/assert";
import { harnessSkew, type Teammate } from "../ui/src/lib/team.ts";

const agent = (over: Partial<Teammate> = {}): Teammate => ({
  id: "a1",
  name: "swift-ripley",
  status: "idle",
  lastHeartbeat: Date.now(),
  protocolVersion: 1,
  harness: "pi",
  harnessVersion: "0.17.2",
  ...over,
});

Deno.test("an agent on the daemon's version is not skewed", () => {
  assertEquals(harnessSkew(agent(), "0.17.2"), null);
});

Deno.test("an older extension is skewed, and the message names the fix", () => {
  const skew = harnessSkew(agent({ harnessVersion: "0.16.0" }), "0.17.2");
  assertEquals(skew?.skewed, true);
  assertEquals(
    skew?.reason,
    "swift-ripley runs extension 0.16.0; the daemon is 0.17.2 — restart it.",
  );
});

Deno.test("a pre-handshake agent is skewed — it predates version reporting", () => {
  const skew = harnessSkew(agent({ protocolVersion: undefined, harnessVersion: undefined }), "0.17.2");
  assertEquals(skew?.skewed, true);
  assertEquals(skew?.reason.includes("before version reporting"), true);
});

Deno.test("offline agents are never flagged", () => {
  // Restarting is the fix for skew, and an offline agent is already stopped.
  assertEquals(harnessSkew(agent({ status: "offline", harnessVersion: "0.16.0" }), "0.17.2"), null);
  assertEquals(harnessSkew(agent({ status: "offline", protocolVersion: undefined }), "0.17.2"), null);
});

Deno.test("nothing is flagged before the daemon's version is known", () => {
  // The first poll can resolve without it; a banner that flickers on load is
  // worse than one that appears a second late.
  assertEquals(harnessSkew(agent({ harnessVersion: "0.16.0" }), undefined), null);
});

Deno.test("a reported protocol version alone is enough to clear an agent", () => {
  // A Tier 0 harness may not report a build version at all. It handshook, so it
  // is not pre-handshake, and there is nothing to compare — don't cry wolf.
  const skew = harnessSkew(agent({ harness: "claude", harnessVersion: undefined }), "0.17.2");
  assertEquals(skew, null);
});

// ─── The remedy (P2-9) ───────────────────────────────────────────────

Deno.test("only skewed agents are selected for a restart", () => {
  // Resetting a healthy agent would throw away its context window for nothing, so
  // the restart-all affordance must act on the skewed set and not "everyone".
  const daemonVersion = "0.17.2";
  const team = [
    agent({ id: "a", name: "current", harnessVersion: "0.17.2" }),
    agent({ id: "b", name: "behind", harnessVersion: "0.16.0" }),
    agent({ id: "c", name: "pre-handshake", protocolVersion: undefined, harnessVersion: undefined }),
    agent({ id: "d", name: "offline-and-behind", status: "offline", harnessVersion: "0.16.0" }),
  ];

  const selected = team.filter((t) => harnessSkew(t, daemonVersion)?.skewed).map((t) => t.id);
  assertEquals(selected, ["b", "c"], "current and offline agents must be left alone");
});

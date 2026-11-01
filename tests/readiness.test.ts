/**
 * tests/readiness.test.ts — The team readiness routes (P1c-3).
 *
 * Readiness answers "is this machine able to work right now?" A not-ready team
 * *holds* scheduled enqueues instead of failing them, so an expired credential
 * doesn't turn an overnight cron into a pile of FAILED runs. The hold-and-
 * single-refire behaviour lives in tests/store.test.ts; this covers the HTTP
 * surface the leader's probe reports through.
 *
 * Team-level, not per-host: multi-host was removed in P1c
 * (docs/DESIGN.md "One Host, One Leader"), so POST /api/hosts/:hostId/readiness became
 * POST /api/readiness.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam } from "./_team.ts";
import { buildApp } from "../daemon/server.ts";

const report = (app: ReturnType<typeof buildApp>, body: unknown) =>
  app.request("/api/readiness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("with nothing reported, readiness is null — and the team counts as ready", async () => {
  // Absence must not read as "not ready": a freshly booted daemon knows nothing,
  // and refusing to schedule until something reports would stall a healthy team.
  await withTeam({}, async ({ app, store }) => {
    const body = await (await app.request("/api/readiness")).json();
    assertEquals(body.readiness, null);
    assertEquals(store.getTeamReadiness(), undefined);
  });
});

test("a not-ready report is stored with its reason", async () => {
  await withTeam({}, async ({ app, store }) => {
    assertEquals((await report(app, { ready: false, reason: "mwinit credentials expired" })).status, 200);
    const readiness = store.getTeamReadiness()!;
    assertEquals(readiness.ready, false);
    assertEquals(readiness.reason, "mwinit credentials expired");
    assertEquals(typeof readiness.at, "number");

    const body = await (await app.request("/api/readiness")).json();
    assertEquals(body.readiness.reason, "mwinit credentials expired");
  });
});

test("recovering clears the reason rather than leaving it stale", async () => {
  await withTeam({}, async ({ app, store }) => {
    await report(app, { ready: false, reason: "mwinit credentials expired" });
    await report(app, { ready: true });
    const readiness = store.getTeamReadiness()!;
    assertEquals(readiness.ready, true);
    assertEquals(readiness.reason, undefined);
  });
});

test("a report without a boolean `ready` is rejected", async () => {
  // A probe that reports garbage must not silently read as ready — that would
  // disable gating exactly when something is already wrong.
  await withTeam({}, async ({ app, store }) => {
    assertEquals((await report(app, {})).status, 400);
    assertEquals((await report(app, { ready: "yes" })).status, 400);
    assertEquals(store.getTeamReadiness(), undefined);
  });
});

test("/health surfaces a not-ready team, and nothing when it's fine", async () => {
  await withTeam({}, async ({ app }) => {
    assertEquals((await (await app.request("/health")).json()).notReady, null);
    await report(app, { ready: false, reason: "VPN down" });
    assertEquals((await (await app.request("/health")).json()).notReady.reason, "VPN down");
    await report(app, { ready: true });
    assertEquals((await (await app.request("/health")).json()).notReady, null);
  });
});

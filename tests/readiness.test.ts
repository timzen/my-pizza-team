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
 * (docs/BATTERIES_INCLUDED.md §3.3), so POST /api/hosts/:hostId/readiness became
 * POST /api/readiness.
 */

import { assertEquals } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";

import * as path from "@std/path";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-readiness-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  const app = buildApp(store, TEST_CONFIG, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

const report = (app: ReturnType<typeof buildApp>, body: unknown) =>
  app.request("/api/readiness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("with nothing reported, readiness is null — and the team counts as ready", async () => {
  // Absence must not read as "not ready": a freshly booted daemon knows nothing,
  // and refusing to schedule until something reports would stall a healthy team.
  const { app, store, teamDir } = setup();
  try {
    const body = await (await app.request("/api/readiness")).json();
    assertEquals(body.readiness, null);
    assertEquals(store.getTeamReadiness(), undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a not-ready report is stored with its reason", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await report(app, { ready: false, reason: "mwinit credentials expired" })).status, 200);
    const readiness = store.getTeamReadiness()!;
    assertEquals(readiness.ready, false);
    assertEquals(readiness.reason, "mwinit credentials expired");
    assertEquals(typeof readiness.at, "number");

    const body = await (await app.request("/api/readiness")).json();
    assertEquals(body.readiness.reason, "mwinit credentials expired");
  } finally { cleanup(teamDir, store); }
});

Deno.test("recovering clears the reason rather than leaving it stale", async () => {
  const { app, store, teamDir } = setup();
  try {
    await report(app, { ready: false, reason: "mwinit credentials expired" });
    await report(app, { ready: true });
    const readiness = store.getTeamReadiness()!;
    assertEquals(readiness.ready, true);
    assertEquals(readiness.reason, undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a report without a boolean `ready` is rejected", async () => {
  // A probe that reports garbage must not silently read as ready — that would
  // disable gating exactly when something is already wrong.
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await report(app, {})).status, 400);
    assertEquals((await report(app, { ready: "yes" })).status, 400);
    assertEquals(store.getTeamReadiness(), undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("/health surfaces a not-ready team, and nothing when it's fine", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await (await app.request("/health")).json()).notReady, null);
    await report(app, { ready: false, reason: "VPN down" });
    assertEquals((await (await app.request("/health")).json()).notReady.reason, "VPN down");
    await report(app, { ready: true });
    assertEquals((await (await app.request("/health")).json()).notReady, null);
  } finally { cleanup(teamDir, store); }
});

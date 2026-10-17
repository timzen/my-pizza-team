/**
 * tests/config-persist.test.ts — config.json survives the daemon's own writes.
 *
 * `Store.saveConfig` is the single writer of config.json, and every route that
 * persists config goes through it (`PUT /api/config`, `PUT /api/teammate-pool`).
 * A field the writer forgets is silently erased the first time anyone saves the
 * Config page or changes the team size — which is how custom harness templates were
 * being lost. These tests save through each path and read the file back.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import type { TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

/** Every persistable field set to a non-default value, so a dropped one shows. */
const FULL: Partial<TeamConfig> = {
  apiToken: "secret-token",
  minTeammates: 1,
  agentTimeoutSeconds: 120,
  teammates: { nouns: ["ripley"] },
  readinessProbe: "true",
  defaultHarness: "custom",
  experimental: { harnesses: true },
  favoriteDirectories: ["/tmp/mpt-fav-a", "/tmp/mpt-fav-b"],
  harnesses: {
    custom: { teammate: "my-agent --name={name} --daemon={url}", leader: "my-agent --lead" },
  },
};

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-config-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...structuredClone(FULL) };
  const store = new Store(teamDir, config);
  const built = buildApp(store, config, teamDir);
  // FULL sets an apiToken, so the routes require it.
  const app = {
    request: (url: string, init: RequestInit = {}) =>
      built.request(url, { ...init, headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${FULL.apiToken}` } }),
  };
  const onDisk = () => JSON.parse(Deno.readTextFileSync(path.join(teamDir, "config.json"))) as Partial<TeamConfig>;
  const cleanup = () => { store.close(); Deno.removeSync(teamDir, { recursive: true }); };
  return { app, store, onDisk, cleanup };
}

/** The fields no route edits must come back exactly as they went in. */
function assertPreserved(saved: Partial<TeamConfig>) {
  assertEquals(saved.apiToken, FULL.apiToken);
  assertEquals(saved.agentTimeoutSeconds, FULL.agentTimeoutSeconds);
  assertEquals(saved.defaultHarness, FULL.defaultHarness);
  assertEquals(saved.harnesses, FULL.harnesses);
  assertEquals(saved.experimental, FULL.experimental);
  // Favorites have their own endpoint; PUT /api/config must not drop them.
  assertEquals(saved.favoriteDirectories, FULL.favoriteDirectories);
}

Deno.test("saveConfig writes every persistable field", () => {
  const { store, onDisk, cleanup } = setup();
  try {
    store.saveConfig();
    const saved = onDisk();
    assertPreserved(saved);
    assertEquals(saved.minTeammates, FULL.minTeammates);
    assertEquals(saved.teammates, FULL.teammates);
    assertEquals(saved.readinessProbe, FULL.readinessProbe);
  } finally { cleanup(); }
});

Deno.test("saving the Config page (PUT /api/config) keeps fields it doesn't edit", async () => {
  const { app, onDisk, cleanup } = setup();
  try {
    // What the Config page sends: GET's shape back, with an edit.
    const current = await (await app.request("/api/config")).json();
    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, maxTeammates: 6, harnesses: undefined, defaultHarness: undefined }),
    });
    assertEquals((await res.json()).success, true);
    const saved = onDisk();
    assertEquals(saved.maxTeammates, 6);
    assertPreserved(saved);
  } finally { cleanup(); }
});

Deno.test("changing the team size (PUT /api/teammate-pool) keeps every other field", async () => {
  const { app, onDisk, cleanup } = setup();
  try {
    const res = await app.request("/api/teammate-pool", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minTeammates: 2 }),
    });
    assertEquals((await res.json()).success, true);
    const saved = onDisk();
    assertEquals(saved.minTeammates, 2);
    assertPreserved(saved);
  } finally { cleanup(); }
});

// ─── Experimental harnesses (Config → Teammates) ─────────────────────

/** PUT the Config page's payload — GET's shape back — with `patch` applied. */
async function putConfig(app: ReturnType<typeof setup>["app"], patch: Record<string, unknown>) {
  const current = await (await app.request("/api/config")).json();
  const res = await app.request("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...current, ...patch }),
  });
  return { status: res.status, body: await res.json() as { success: boolean; error?: string } };
}

Deno.test("the experimental-harnesses toggle saves, survives a reload, and applies live", async () => {
  const { app, store, onDisk, cleanup } = setup();
  try {
    let r = await putConfig(app, { experimental: { harnesses: false }, defaultHarness: "pi" });
    assertEquals(r.body.success, true);
    // Off is the default, so nothing is written — and Pi is stored as unset.
    assertEquals(onDisk().experimental, undefined);
    assertEquals(onDisk().defaultHarness, undefined);
    assertEquals(store.getConfig().experimental, undefined);

    r = await putConfig(app, { experimental: { harnesses: true }, defaultHarness: "kiro" });
    assertEquals(r.body.success, true);
    assertEquals(onDisk().experimental, { harnesses: true });
    assertEquals(onDisk().defaultHarness, "kiro");
    // Live: the in-memory config the spawner and Spawn dialog read changed too.
    const live = await (await app.request("/api/config")).json();
    assertEquals(live.experimental, { harnesses: true });
    assertEquals(live.defaultHarness, "kiro");
  } finally { cleanup(); }
});

Deno.test("PUT /api/config rejects an unknown defaultHarness with a 400", async () => {
  const { app, store, cleanup } = setup();
  try {
    const r = await putConfig(app, { defaultHarness: "nope" });
    assertEquals(r.status, 400);
    assertEquals(r.body.success, false);
    assertStringIncludes(r.body.error ?? "", "defaultHarness");
    assertEquals(store.getConfig().defaultHarness, FULL.defaultHarness);
  } finally { cleanup(); }
});

Deno.test("an experimental default without the opt-in is refused and changes nothing", async () => {
  const { app, store, cleanup } = setup();
  try {
    const maxBefore = store.getConfig().maxTeammates;
    // Turning experimental off while the default stays non-Pi ("custom").
    let r = await putConfig(app, { experimental: { harnesses: false }, maxTeammates: 9 });
    assertEquals(r.status, 400);
    assertStringIncludes(r.body.error ?? "", "experimental");
    // Validated before mutation: the live config is untouched.
    assertEquals(store.getConfig().experimental, { harnesses: true });
    assertEquals(store.getConfig().defaultHarness, "custom");
    assertEquals(store.getConfig().maxTeammates, maxBefore);

    // Setting a non-Pi default with the opt-in off is refused too.
    r = await putConfig(app, { experimental: null, defaultHarness: "claude" });
    assertEquals(r.status, 400);

    // Off + reset to Pi together is consistent, and saves.
    r = await putConfig(app, { experimental: { harnesses: false }, defaultHarness: "" });
    assertEquals(r.body.success, true);
    assertEquals(store.getConfig().defaultHarness, undefined);
    assertEquals(store.getConfig().experimental, undefined);
  } finally { cleanup(); }
});

Deno.test("experimental must be an object with a boolean harnesses", async () => {
  const { app, cleanup } = setup();
  try {
    assertEquals((await putConfig(app, { experimental: "yes" })).status, 400);
    assertEquals((await putConfig(app, { experimental: { harnesses: "true" } })).status, 400);
  } finally { cleanup(); }
});

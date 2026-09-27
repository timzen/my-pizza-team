/**
 * tests/config-persist.test.ts — config.json survives the daemon's own writes.
 *
 * `Store.saveConfig` is the single writer of config.json, and every route that
 * persists config goes through it (`PUT /api/config`, `PUT /api/teammate-pool`).
 * A field the writer forgets is silently erased the first time anyone saves the
 * Config page or changes the team size — which is how custom harness templates were
 * being lost. These tests save through each path and read the file back.
 */

import { assertEquals } from "@std/assert";
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

/**
 * tests/capabilities.test.ts — Verifies recently-used capability tracking.
 *
 * config.recentCapabilities is a map of capability name -> known values,
 * auto-populated when stories declare `requirements` and when agents register
 * `capabilities`, and editable via the /api/capabilities endpoints. It persists
 * to the team's config.json.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-caps-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function readConfig(teamDir: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(path.join(teamDir, "config.json")));
}

Deno.test("story requirements auto-populate recentCapabilities (keys + values)", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T", description: "D" }],
      { directory: "/tmp/project", python: "3.11", design: null }, "default");
    const caps = store.getRecentCapabilities();
    assertEquals(caps.directory, ["/tmp/project"]);
    assertEquals(caps.python, ["3.11"]);
    assertEquals(caps.design, []); // presence-only: key remembered, no values
    // Persisted to config.json
    assertEquals((readConfig(teamDir).recentCapabilities as Record<string, string[]>).python, ["3.11"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("agent registration auto-populates recentCapabilities", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "a1", name: "neo", capabilities: { directory: "/tmp/x", docker: "24" } });
    const caps = store.getRecentCapabilities();
    assertEquals(caps.directory, ["/tmp/x"]);
    assertEquals(caps.docker, ["24"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("values are most-recent-first, deduped", () => {
  const { store, teamDir } = setup();
  try {
    store.addCapability("python", "3.11");
    store.addCapability("python", "3.12");
    store.addCapability("python", "3.11"); // moves to front
    assertEquals(store.getRecentCapabilities().python, ["3.11", "3.12"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("directory values are normalized", () => {
  const { store, teamDir } = setup();
  try {
    store.addCapability("directory", "/tmp/project/");
    assertEquals(store.getRecentCapabilities().directory, ["/tmp/project"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET/POST/DELETE /api/capabilities", async () => {
  const { app, store, teamDir } = setup();
  try {
    // POST add key + value
    let res = await post(app, "/api/capabilities", { name: "python", value: "3.11" });
    assertEquals(res.status, 200);
    // POST add another value
    await post(app, "/api/capabilities", { name: "python", value: "3.12" });
    // POST presence-only key
    await post(app, "/api/capabilities", { name: "design" });

    res = await app.request("/api/capabilities");
    let body = await res.json();
    assertEquals(body.capabilities.python, ["3.12", "3.11"]);
    assertEquals(body.capabilities.design, []);

    // DELETE a single value
    res = await app.request("/api/capabilities/python?value=3.11", { method: "DELETE" });
    body = await res.json();
    assertEquals(body.capabilities.python, ["3.12"]);

    // DELETE the whole key
    res = await app.request("/api/capabilities/python", { method: "DELETE" });
    body = await res.json();
    assertEquals("python" in body.capabilities, false);

    // DELETE unknown → 404
    res = await app.request("/api/capabilities/nope", { method: "DELETE" });
    assertEquals(res.status, 404);

    // Missing name on POST → 400
    res = await post(app, "/api/capabilities", {});
    assertEquals(res.status, 400);

    // Verify persistence to disk
    assertEquals((readConfig(teamDir).recentCapabilities as Record<string, string[]>).design, []);
    void store;
  } finally { cleanup(teamDir, store); }
});

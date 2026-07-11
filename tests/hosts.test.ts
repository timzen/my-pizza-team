/**
 * tests/hosts.test.ts — Verifies host-namespaced configuration.
 *
 * Tests that:
 * - Agents can register with a hostId
 * - Per-host config (favoriteDirectories, tmuxSession) is returned on register
 * - GET /api/hosts/:hostId returns host-specific config
 * - Fallback to global config when host has no specific config
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-hosts-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

Deno.test("Agent register with hostId stores it", async () => {
  const { app, store, teamDir } = setup({
    hosts: {
      "laptop-1": { favoriteDirectories: ["/home/user/projects"], tmuxSession: "dev" },
    },
  });
  try {
    const res = await post(app, "/api/agents/register", { id: "a1", name: "neo", capabilities: { directory: "/tmp" }, hostId: "laptop-1" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.config.tmuxSession, "dev");
    assertEquals(body.config.favoriteDirectories, ["/home/user/projects"]);

    // Verify stored in DB
    const member = store.getMember("a1");
    assertEquals(member?.hostId, "laptop-1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Agent register without hostId falls back to global config", async () => {
  const { app, store, teamDir } = setup({
    tmuxSession: "global-session",
    teammates: { favoriteDirectories: ["/global/dir"] },
    hosts: {
      "laptop-1": { favoriteDirectories: ["/host-specific"], tmuxSession: "host-session" },
    },
  });
  try {
    const res = await post(app, "/api/agents/register", { id: "a1", name: "neo", capabilities: { directory: "/tmp" } });
    const body = await res.json();
    assertEquals(body.config.tmuxSession, "global-session");
    assertEquals(body.config.favoriteDirectories, ["/global/dir"]);

    const member = store.getMember("a1");
    assertEquals(member?.hostId, undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("Agent register with unknown hostId falls back to global config", async () => {
  const { app, store, teamDir } = setup({
    tmuxSession: "global-session",
    teammates: { favoriteDirectories: ["/global/dir"] },
    hosts: {
      "laptop-1": { favoriteDirectories: ["/host-specific"] },
    },
  });
  try {
    const res = await post(app, "/api/agents/register", { id: "a1", name: "neo", capabilities: { directory: "/tmp" }, hostId: "unknown-host" });
    const body = await res.json();
    assertEquals(body.config.tmuxSession, "global-session");
    assertEquals(body.config.favoriteDirectories, ["/global/dir"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/hosts/:hostId returns host-specific config", async () => {
  const { app, store, teamDir } = setup({
    hosts: {
      "server-1": { favoriteDirectories: ["/srv/apps", "/srv/libs"], tmuxSession: "server-tmux" },
    },
  });
  try {
    const res = await app.request("/api/hosts/server-1");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.hostId, "server-1");
    assertEquals(body.tmuxSession, "server-tmux");
    assertEquals(body.favoriteDirectories, ["/srv/apps", "/srv/libs"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/hosts/:hostId returns global fallback for unknown host", async () => {
  const { app, store, teamDir } = setup({
    tmuxSession: "default-tmux",
    teammates: { favoriteDirectories: ["/default/dir"] },
  });
  try {
    const res = await app.request("/api/hosts/nonexistent");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.hostId, "nonexistent");
    assertEquals(body.tmuxSession, "default-tmux");
    assertEquals(body.favoriteDirectories, ["/default/dir"]);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents includes hostId in listing", async () => {
  const { app, store, teamDir } = setup({
    hosts: { "h1": { favoriteDirectories: [] } },
  });
  try {
    store.registerMember("a1", "neo", { directory: "/tmp" }, "a1", "h1");
    store.registerMember("a2", "trinity", { directory: "/home" }, "a2");
    const res = await app.request("/api/agents");
    const body = await res.json();
    const a1 = body.agents.find((a: { id: string }) => a.id === "a1");
    const a2 = body.agents.find((a: { id: string }) => a.id === "a2");
    assertEquals(a1.hostId, "h1");
    assertEquals(a2.hostId, undefined);
  } finally { cleanup(teamDir, store); }
});

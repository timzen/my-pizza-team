/**
 * tests/persona-mcp.test.ts — `mpt doctor`'s check of the MCP servers personas
 * require (frontmatter `requires.mcp`; docs/DESIGN.md "Persona settings").
 *
 * MPT never starts or installs a server: doctor reads Pi's mcp.json files
 * (cli/pi-config.ts `readMcpServersFile`, read-only) and warns, per in-use
 * persona, about servers Pi's config lacks — present, missing, disabled, only
 * in a (trusted or untrusted) project's `.pi/mcp.json`, and personas with no
 * requirement or used by nothing (no check at all). The Pi harness's claim-time
 * check has its own suite (harnesses/pi/tests/persona-mcp.test.mjs).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, type App } from "./_team.ts";
import { mcpServerKey, readMcpServersFile } from "../cli/pi-config.ts";
import { gatherPersonaMcp, personaMcpChecks, personaMcpFacts, type McpConfigSource } from "../cli/doctor.ts";

/** A temp dir with `agent/mcp.json` and `project/.pi/mcp.json` written from the given objects (when given). */
function piDirs(user?: unknown, project?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-mcp-"));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  if (user !== undefined) fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(user));
  if (project !== undefined) fs.writeFileSync(path.join(projectDir, ".pi", "mcp.json"), JSON.stringify(project));
  return { root, agentDir, projectDir };
}

/** A config source from raw `mcpServers` maps. */
function source(user: Record<string, unknown> | null, projects: Array<{ dir: string; trusted: boolean; servers: Record<string, unknown> }> = []): McpConfigSource {
  const { agentDir, root } = piDirs(user ? { mcpServers: user } : undefined);
  return {
    user: readMcpServersFile(path.join(agentDir, "mcp.json")),
    projects: projects.map((p) => {
      const file = path.join(root, `${p.dir.replace(/\W/g, "_")}.json`);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: p.servers }));
      return { dir: p.dir, trusted: p.trusted, servers: readMcpServersFile(file) };
    }),
  };
}

test("readMcpServersFile: entries keyed by Pi's name rule, enabled and override flags; absent/broken = null", () => {
  const { agentDir } = piDirs({ mcpServers: { "dev-radius": { url: "u" }, off: { command: "c", enabled: false }, flip: { enabled: true } } });
  const servers = readMcpServersFile(path.join(agentDir, "mcp.json"))!;
  assertEquals(servers.get(mcpServerKey("dev_radius")), { name: "dev-radius", enabled: true, override: false });
  assertEquals(servers.get("off")?.enabled, false);
  assertEquals(servers.get("flip")?.override, true);
  assertEquals(readMcpServersFile(path.join(agentDir, "nope.json")), null);
  fs.writeFileSync(path.join(agentDir, "bad.json"), "{ nope");
  assertEquals(readMcpServersFile(path.join(agentDir, "bad.json")), null);
});

test("present: every server in the user-level config → one ok line", () => {
  const facts = personaMcpFacts([{ id: "researcher", mcp: ["jira", "docs"] }], source({ jira: { url: "u" }, docs: { command: "d" } }), "/pi/mcp.json");
  const checks = personaMcpChecks(facts);
  assertEquals(checks.length, 1);
  assert(checks[0]!.status === "ok" && checks[0]!.detail.includes("jira, docs"), JSON.stringify(checks));
});

test("missing: a warning per persona naming the servers, with a pi mcp add fix", () => {
  const facts = personaMcpFacts([{ id: "researcher", mcp: ["jira", "docs"] }, { id: "ok", mcp: ["jira"] }], source({ jira: { url: "u" } }), "/pi/mcp.json");
  const checks = personaMcpChecks(facts);
  assertEquals(checks.length, 1, "only the persona with a gap");
  const c = checks[0]!;
  assertEquals(c.status, "warn");
  assertEquals(c.name, "Persona researcher MCP servers");
  assert(c.detail.includes("docs not configured") && c.detail.includes("go on without them"), c.detail);
  assert(c.fix!.includes("pi mcp add docs -- <command>") && c.fix!.includes("pi mcp add docs --url <url>"), c.fix);
});

test("no requires / nothing in use → no check at all", () => {
  assertEquals(personaMcpChecks(personaMcpFacts([], source(null), "/pi/mcp.json")), []);
});

test("project-level .pi/mcp.json: trusted counts (noted), untrusted warns with a trust fix", () => {
  const trusted = personaMcpChecks(personaMcpFacts([{ id: "r", mcp: ["docs"] }], source(null, [{ dir: "/work/a", trusted: true, servers: { docs: { command: "d" } } }]), "/pi/mcp.json"));
  assert(trusted.length === 1 && trusted[0]!.status === "ok" && trusted[0]!.detail.includes("docs (/work/a)"), JSON.stringify(trusted));

  const untrusted = personaMcpChecks(personaMcpFacts([{ id: "r", mcp: ["docs"] }], source(null, [{ dir: "/work/a", trusted: false, servers: { docs: { command: "d" } } }]), "/pi/mcp.json"));
  assert(untrusted[0]!.status === "warn" && untrusted[0]!.detail.includes("project not trusted") && untrusted[0]!.fix!.includes("/trust"), JSON.stringify(untrusted));
});

test("disabled: a user-level server with enabled:false warns, unless a trusted project override enables it", () => {
  const user = { docs: { command: "d", enabled: false } };
  const off = personaMcpChecks(personaMcpFacts([{ id: "r", mcp: ["docs"] }], source(user), "/pi/mcp.json"));
  assert(off[0]!.status === "warn" && off[0]!.detail.includes("docs disabled"), JSON.stringify(off));
  const on = personaMcpFacts([{ id: "r", mcp: ["docs"] }], source(user, [{ dir: "/w", trusted: true, servers: { docs: { enabled: true } } }]), "/pi/mcp.json");
  assertEquals(on.personas[0]!.servers, [{ name: "docs", status: "project", dir: "/w" }]);
  // An override with no user-level server to override configures nothing.
  const orphan = personaMcpFacts([{ id: "r", mcp: ["x"] }], source(null, [{ dir: "/w", trusted: true, servers: { x: { enabled: true } } }]), "/pi/mcp.json");
  assertEquals(orphan.personas[0]!.servers, [{ name: "x", status: "missing" }]);
});

/** Serve `app` on an ephemeral port for `fn`, then close it. */
async function serving<T>(app: App, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("gather: only in-use personas that declare requires.mcp are checked, against Pi's files", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    store.createPersona({ id: "used", title: "Used", content: "Do it.", requires: { mcp: ["jira", "docs"] } });
    store.createPersona({ id: "idle", title: "Idle", content: "Do it.", requires: { mcp: ["wiki"] } });
    store.createPersona({ id: "plain", title: "Plain", content: "Do it." });
    store.createWorkDef({ title: "W", goal: "g", acceptanceCriteria: "a", persona: "used" });
    store.createWorkDef({ title: "P", goal: "g", acceptanceCriteria: "a", persona: "plain" });
    const { agentDir, projectDir } = piDirs({ mcpServers: { jira: { url: "u" } } });
    const facts = await serving(app, (daemonUrl) => gatherPersonaMcp({ teamDir, projectDir, daemonUrl }, agentDir));
    assertEquals(facts?.personas, [{ id: "used", servers: [{ name: "jira", status: "user" }, { name: "docs", status: "missing" }] }]);
    assertEquals(facts?.userConfig, path.join(agentDir, "mcp.json"));
  });
});

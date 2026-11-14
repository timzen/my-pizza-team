// The persona's required MCP servers (src/persona-mcp.ts, its wiring in
// src/index.ts): at claim, `requires.mcp` is compared with the MCP servers this
// Pi has — the user-level mcp.json, a trusted project's .pi/mcp.json, extension
// registrations — and what's missing is reported once; nothing is started
// (my-pizza-team docs/DESIGN.md "Persona settings").
//
// Run: node --test --experimental-strip-types tests/persona-mcp.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { knownMcpServers, mcpRequirementProblem, mcpServerKey, missingMcpServers, piAgentDir, registeredMcpServers } =
  await import("../src/persona-mcp.ts");

/** A throwaway agent dir and project dir, with the given mcp.json contents (objects, or raw text). */
function setup({ user, project } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-mcp-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const write = (file, v) => fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
  if (user !== undefined) write(path.join(agentDir, "mcp.json"), user);
  if (project !== undefined) write(path.join(cwd, ".pi", "mcp.json"), project);
  return { agentDir, cwd };
}

const persona = (mcp) => ({ id: "researcher", ...(mcp ? { requires: { mcp } } : {}) });

test("present: every required server configured at user level → no problem", () => {
  const { agentDir, cwd } = setup({ user: { mcpServers: { jira: { url: "https://x/mcp" }, docs: { command: "docs-mcp" } } } });
  assert.strictEqual(mcpRequirementProblem(persona(["jira", "docs"]), { agentDir, cwd, projectTrusted: false }), null);
});

test("missing: names each missing server in one comment, and says the work continues", () => {
  const { agentDir, cwd } = setup({ user: { mcpServers: { jira: { url: "https://x/mcp" } } } });
  const problem = mcpRequirementProblem(persona(["jira", "docs", "wiki"]), { agentDir, cwd, projectTrusted: false });
  assert.match(problem, /^persona researcher expects MCP servers: docs, wiki — not configured/);
  assert.match(problem, /Continuing without them/);
  assert.match(problem, /pi mcp add/);
});

test("no requires (or no persona) → no problem, whatever is configured", () => {
  const { agentDir, cwd } = setup();
  assert.strictEqual(mcpRequirementProblem(persona(), { agentDir, cwd, projectTrusted: false }), null);
  assert.strictEqual(mcpRequirementProblem(persona([]), { agentDir, cwd, projectTrusted: false }), null);
  assert.strictEqual(mcpRequirementProblem(null, { agentDir, cwd, projectTrusted: false }), null);
});

test("no mcp.json at all, or an unreadable one → every required server missing", () => {
  for (const user of [undefined, "{ not json", { mcpServers: [] }]) {
    const { agentDir, cwd } = setup({ user });
    assert.match(mcpRequirementProblem(persona(["jira"]), { agentDir, cwd, projectTrusted: false }), /jira — not configured/);
  }
});

test("project-level .pi/mcp.json counts only when the project is trusted", () => {
  const { agentDir, cwd } = setup({ project: { mcpServers: { docs: { command: "docs-mcp" } } } });
  assert.strictEqual(mcpRequirementProblem(persona(["docs"]), { agentDir, cwd, projectTrusted: true }), null);
  assert.match(mcpRequirementProblem(persona(["docs"]), { agentDir, cwd, projectTrusted: false }), /docs — not configured/);
  assert.strictEqual(knownMcpServers({ agentDir, cwd, projectTrusted: true }).get("docs").source, path.join(cwd, ".pi", "mcp.json"));
});

test("disabled servers count as missing; a project override can disable or re-enable a user-level one", () => {
  const { agentDir, cwd } = setup({
    user: { mcpServers: { jira: { url: "https://x/mcp" }, docs: { command: "d", enabled: false } } },
    project: { mcpServers: { jira: { enabled: false }, docs: { enabled: true }, orphan: { enabled: true } } },
  });
  assert.match(mcpRequirementProblem(persona(["docs"]), { agentDir, cwd, projectTrusted: false }), /docs — disabled/);
  assert.strictEqual(mcpRequirementProblem(persona(["docs"]), { agentDir, cwd, projectTrusted: true }), null);
  const both = mcpRequirementProblem(persona(["jira", "orphan"]), { agentDir, cwd, projectTrusted: true });
  // An override with no user-level server to override configures nothing.
  assert.match(both, /orphan — not configured; jira — disabled/);
});

test("extension-registered servers count; names differing only in - and _ are one server", () => {
  const { agentDir, cwd } = setup({ user: { mcpServers: { "dev-radius": { url: "https://x/mcp" } } } });
  assert.strictEqual(mcpServerKey("dev-radius"), mcpServerKey("dev_radius"));
  const known = knownMcpServers({ agentDir, cwd, projectTrusted: false, registered: ["jira"] });
  assert.deepStrictEqual(missingMcpServers(["dev_radius", "jira", "wiki"], known), { missing: ["wiki"], disabled: [] });
  assert.strictEqual(known.get("jira").source, "extension");
});

test("registeredMcpServers: Pi's getMcpServers when present, else none", () => {
  assert.deepStrictEqual(registeredMcpServers({ getMcpServers: () => [{ name: "jira" }, { name: 3 }] }), ["jira"]);
  assert.deepStrictEqual(registeredMcpServers({}), []);
  assert.deepStrictEqual(registeredMcpServers({ getMcpServers: () => { throw new Error("x"); } }), []);
});

test("piAgentDir honours PI_CODING_AGENT_DIR (with ~), else ~/.pi/agent", () => {
  assert.strictEqual(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/pi-x" }), "/tmp/pi-x");
  assert.strictEqual(piAgentDir({ PI_CODING_AGENT_DIR: "~/alt" }), path.join(os.homedir(), "alt"));
  assert.strictEqual(piAgentDir({}), path.join(os.homedir(), ".pi", "agent"));
});

test("index.ts wires the check at claim, reported once per item", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.match(src, /checkMcp\(loop\.currentTask, persona\)/);
  assert.match(src, /reportScopeOnce\(reportedMcp, workItemId/);
});

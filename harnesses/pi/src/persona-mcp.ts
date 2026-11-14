// The active persona's required MCP servers (frontmatter `requires.mcp`).
//
// A persona may declare the MCP servers its work depends on (my-pizza-team
// docs/DESIGN.md "Persona settings"): `requires: { mcp: [jira, docs] }`. MPT
// never starts or installs a server — Pi's MCP servers are configured by the
// user, globally — so this module only *checks*: at claim, the persona's list is
// compared with the servers this Pi has, and what's missing is posted once on
// the item's thread ("persona X expects MCP servers: a, b — not configured").
// The work goes on either way.
//
// What "this Pi has" means, mirroring Pi's built-in MCP support
// (pi-coding-agent docs/mcp.md "Configure servers"):
//
//   - `<agent dir>/mcp.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`);
//   - `<cwd>/.pi/mcp.json`, only when the project is trusted
//     (`ctx.isProjectTrusted()`); a project entry replaces a user-level one of
//     the same name, and an entry without `command`/`url`/`type` only overrides
//     `enabled` of the user-level server (no user-level server: it is nothing);
//   - servers extensions registered (`pi.getMcpServers()`, where this Pi has it).
//
// The files are read, never written, and read rather than asked of Pi because
// Pi's runtime API lists only extension-registered servers. A server with
// `enabled: false` counts as not configured (it won't connect). Names that
// differ only in `-`/`_` are one server, as in Pi. Whether a configured server
// actually *connects* isn't checked — `pi mcp list` does that.
//
// cli/pi-config.ts `readPiMcpServers` (for `mpt doctor`) reads the same files
// the same way; the extension is a self-contained package that can't import the
// CLI, so it keeps this copy.
//
// No Pi imports at all (only node: built-ins): like persona-model.ts, this
// module loads standalone under Node's type stripping, which lets tests import it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One MCP server this Pi knows: where it is configured, and whether it's enabled. */
export interface KnownMcpServer {
  name: string;
  enabled: boolean;
  /** The file that configures it, or `"extension"` for a registered server. */
  source: string;
}

/** Where to look for MCP servers (the parts of Pi's context the check reads). */
export interface McpLookup {
  /** Pi's agent dir; default `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
  agentDir?: string;
  /** The session's working directory: where `.pi/mcp.json` is looked for. */
  cwd: string;
  /** Whether Pi trusts the project (its `.pi/mcp.json` is read only then). */
  projectTrusted: boolean;
  /** Servers extensions registered (`pi.getMcpServers()` names). */
  registered?: readonly string[];
}

/** The slice of a persona this module reads. */
export interface McpPersona {
  id: string | null;
  requires?: { mcp?: string[] };
}

/** Pi's agent dir, as Pi computes it (`PI_CODING_AGENT_DIR` with `~` expanded, else `~/.pi/agent`). */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"];
  if (override) return override === "~" ? os.homedir() : override.startsWith("~/") ? path.join(os.homedir(), override.slice(2)) : override;
  return path.join(os.homedir(), ".pi", "agent");
}

/** The key two server names share when Pi treats them as one (`-` and `_` alike). */
export function mcpServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An `mcpServers` map from one mcp.json; null when the file is absent or unreadable. */
function readServers(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
    return isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  } catch {
    // Unparseable: Pi reports it itself; here it just contributes no servers.
    return null;
  }
}

/**
 * The MCP servers this Pi has, keyed by `mcpServerKey`: the user-level
 * mcp.json, a trusted project's `.pi/mcp.json` on top, then extension
 * registrations (a file entry of the same name wins, as in Pi). Read-only.
 */
export function knownMcpServers(lookup: McpLookup): Map<string, KnownMcpServer> {
  const servers = new Map<string, KnownMcpServer>();
  const userFile = path.join(lookup.agentDir ?? piAgentDir(), "mcp.json");
  for (const [name, value] of Object.entries(readServers(userFile) ?? {})) {
    if (!isRecord(value)) continue;
    servers.set(mcpServerKey(name), { name, enabled: value.enabled !== false, source: userFile });
  }
  if (lookup.projectTrusted) {
    const projectFile = path.join(lookup.cwd, ".pi", "mcp.json");
    for (const [name, value] of Object.entries(readServers(projectFile) ?? {})) {
      if (!isRecord(value)) continue;
      const key = mcpServerKey(name);
      const override = !("command" in value) && !("url" in value) && !("type" in value);
      const base = servers.get(key);
      // An override (no command/url/type) only flips `enabled` of a user-level server.
      if (override) {
        if (base) servers.set(key, { ...base, enabled: value.enabled === undefined ? base.enabled : value.enabled !== false });
        continue;
      }
      servers.set(key, { name, enabled: value.enabled !== false, source: projectFile });
    }
  }
  for (const name of lookup.registered ?? []) {
    const key = mcpServerKey(name);
    if (!servers.has(key)) servers.set(key, { name, enabled: true, source: "extension" });
  }
  return servers;
}

/** A persona's required servers this Pi lacks: not configured at all, or configured but disabled. */
export function missingMcpServers(required: readonly string[], known: Map<string, KnownMcpServer>): { missing: string[]; disabled: string[] } {
  const missing: string[] = [];
  const disabled: string[] = [];
  for (const name of required) {
    const server = known.get(mcpServerKey(name));
    if (!server) missing.push(name);
    else if (!server.enabled) disabled.push(name);
  }
  return { missing, disabled };
}

/**
 * The one comment to post when the persona's `requires.mcp` isn't met here, or
 * null (no persona, no requirement, or every server configured and enabled).
 */
export function mcpRequirementProblem(persona: McpPersona | null, lookup: McpLookup): string | null {
  const required = persona?.requires?.mcp ?? [];
  if (required.length === 0) return null;
  const { missing, disabled } = missingMcpServers(required, knownMcpServers(lookup));
  if (missing.length === 0 && disabled.length === 0) return null;
  const who = `persona ${persona?.id ?? "(unnamed)"}`;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.join(", ")} — not configured`);
  if (disabled.length > 0) parts.push(`${disabled.join(", ")} — disabled`);
  return `${who} expects MCP servers: ${parts.join("; ")}. Continuing without them; `
    + "add them with `pi mcp add <name> …` (see `mpt doctor`), then start a fresh teammate.";
}

/** The names of extension-registered MCP servers, where this Pi's API has `getMcpServers` (else none). */
export function registeredMcpServers(pi: unknown): string[] {
  const get = (pi as { getMcpServers?: () => Array<{ name?: unknown }> }).getMcpServers;
  if (typeof get !== "function") return [];
  try {
    return get.call(pi).map((s) => s?.name).filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

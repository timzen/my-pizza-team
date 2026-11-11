/**
 * tests/e2e/_demo.ts — the demo team (tests/fixtures/demo/) in a sandbox, plus a
 * small HTTP client for the daemon's API.
 *
 * The suites ported from mpt-demo-team's run-e2e.sh (legacy-layout, pending-workdefs,
 * demo-tracker, personas, assistant-start, team-flow) all start from the same team:
 * a story with three tasks, a pending story, a Solitary task with a package persona,
 * the demo-tracker Work Source plugin with its three issues, and the
 * mpt-personas-demo persona package. `demoTeam` lays it out the way the demo
 * repo's setup-demo.sh did — but inside the sandbox, so every test gets a fresh copy
 * and nothing outside its temp dir is read or written:
 *
 *   <root>/project/.my-pizza-team/   the team (fixtures/demo/team or team-legacy)
 *   <root>/tracker/tracker.json       the demo tracker's "external system"
 *   <root>/plugins/                   both plugin packages, loaded in place from
 *                                     config.json's relative `packages` paths
 *
 * Placeholders in the team's files: `__DEMO_PROJECT__` → the sandbox's project
 * directory (the story and WorkDef directories), `__SESSION__` → the sandbox's tmux
 * session (so its private-server helpers find the team's windows).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "./_sandbox.ts";
import type { HerdrSandbox } from "./_herdr.ts";
import { scriptedPiHarness } from "./_pi.ts";
import type { Script } from "../fixtures/pi-scripted-provider.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo");

/** The plugin's source id, and the prefix of its mirrored WorkDef ids (`demo-tracker~DEMO-1`). */
export const TRACKER = "demo-tracker";

/** One issue in the demo tracker's JSON file (the plugin's own format). */
export interface TrackerIssue {
  id: string;
  title: string;
  body?: string;
  status: string;
  mode?: string;
  updatedAt?: string;
  comments?: Array<{ at: string; author: string; body: string }>;
}

export interface DemoTeam {
  /** The tracker file the plugin reads and writes back to. */
  trackerFile: string;
  /** Every issue in the tracker file, as it is on disk now. */
  issues(): TrackerIssue[];
  /** One issue (throws if it isn't there). */
  issue(id: string): TrackerIssue;
  /** Rewrite the tracker file through `change`. */
  editTracker(change: (data: { issues: TrackerIssue[] }) => void): void;
  /** Read the team's config.json. */
  config(): Record<string, unknown>;
  /** Rewrite the team's config.json through `change` (before the daemon starts). */
  editConfig(change: (config: Record<string, unknown>) => void): void;
}

/** Replace the placeholders in every file under `dir`. */
function substitute(dir: string, values: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(file, "utf8");
    let out = text;
    for (const [k, v] of Object.entries(values)) out = out.replaceAll(k, v);
    if (out !== text) fs.writeFileSync(file, out);
  }
}

/**
 * Lay the demo team out in `sb` (see the header). `legacy` uses fixtures/demo/team-legacy,
 * a pre-0.36.0 layout the daemon refuses to start on.
 */
export function demoTeam(sb: Sandbox, opts: { legacy?: boolean } = {}): DemoTeam {
  fs.cpSync(path.join(FIXTURES, opts.legacy ? "team-legacy" : "team"), sb.teamDir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "tracker"), path.join(sb.root, "tracker"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "plugins"), path.join(sb.root, "plugins"), { recursive: true });
  substitute(sb.teamDir, { __DEMO_PROJECT__: sb.projectDir, __SESSION__: sb.session });

  const trackerFile = path.join(sb.root, "tracker", "tracker.json");
  const configFile = path.join(sb.teamDir, "config.json");
  const readJson = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as T;
  const team: DemoTeam = {
    trackerFile,
    issues: () => readJson<{ issues: TrackerIssue[] }>(trackerFile).issues,
    issue(id) {
      const found = team.issues().find((i) => i.id === id);
      if (!found) throw new Error(`no issue ${id} in ${trackerFile}`);
      return found;
    },
    editTracker(change) {
      const data = readJson<{ issues: TrackerIssue[] }>(trackerFile);
      change(data);
      fs.writeFileSync(trackerFile, JSON.stringify(data, null, 2) + "\n");
    },
    config: () => readJson<Record<string, unknown>>(configFile),
    editConfig(change) {
      const config = team.config();
      change(config);
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    },
  };
  return team;
}

/** The daemon's JSON is untyped here: the tests assert on its shape. */
export type Json = any;

export interface ApiResponse {
  status: number;
  body: Json;
}

export interface Api {
  get(p: string): Promise<ApiResponse>;
  post(p: string, body?: unknown): Promise<ApiResponse>;
  put(p: string, body?: unknown): Promise<ApiResponse>;
  del(p: string): Promise<ApiResponse>;
}

/** A client for `sb`'s daemon. Bodies that aren't JSON come back as `null`. */
export function api(sb: Sandbox): Api {
  const call = async (method: string, p: string, body?: unknown): Promise<ApiResponse> => {
    const r = await fetch(`http://127.0.0.1:${sb.port}${p}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: Json = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: parsed };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, body) => call("POST", p, body),
    put: (p, body) => call("PUT", p, body),
    del: (p) => call("DELETE", p),
  };
}

/** The id of a READY WorkItem for a WorkDef, or undefined. */
export async function readyItem(a: Api, workDefId: string): Promise<string | undefined> {
  const items = (await a.get("/api/work-items?state=READY")).body.items as Json[];
  return items.find((i) => i.ref.workDefId === workDefId)?.id;
}

/** A WorkItem's recorded persona as `[id, origin, via]`, or null. */
export async function itemPersona(a: Api, itemId: string): Promise<[string, string, string] | null> {
  const p = (await a.get(`/api/work-items/${itemId}`)).body.item.persona;
  return p ? [p.id, p.origin, p.via] : null;
}

/** GET /api/config without the read-only fields, ready to PUT back with changes. */
export async function configForPut(a: Api): Promise<Record<string, unknown>> {
  const body = (await a.get("/api/config")).body as Record<string, unknown>;
  for (const k of ["featureUsage", "featureSources", "defaultNouns", "agentsOnOtherTerminal"]) delete body[k];
  return body;
}

// ─── The team's terminal (tmux, or herdr) ──────────────────────────

/** The team's terminals the terminal flows run under. */
export type Terminal = "tmux" | "herdr";

/**
 * Switch the team's terminal the way Config → General → Terminal does (PUT
 * /api/config with `terminal`; null = unset = tmux). Returns the HTTP status.
 */
export async function putTerminal(a: Api, terminal: Terminal | null): Promise<number> {
  return (await a.put("/api/config", { ...await configForPut(a), terminal })).status;
}

/**
 * Switch the team to herdr through the API and check /health agrees: herdr,
 * available, in the private session `hs` names.
 */
export async function switchToHerdr(a: Api, hs: HerdrSandbox): Promise<void> {
  const status = await putTerminal(a, "herdr");
  if (status !== 200) throw new Error(`PUT /api/config terminal=herdr: ${status}`);
  const health = (await a.get("/health")).body;
  const seen = [health.terminal, health.terminalStatus?.available, health.terminalStatus?.session];
  if (JSON.stringify(seen) !== JSON.stringify(["herdr", true, hs.session])) {
    throw new Error(`/health after switching to herdr: ${JSON.stringify(health)}`);
  }
}

/**
 * The names of the team's windows in `terminal`: tmux windows of the sandbox's
 * private server, or the tabs of the herdr workspace labelled with the session.
 */
export async function teamWindows(sb: Sandbox, terminal: Terminal, hs?: HerdrSandbox): Promise<string[]> {
  if (terminal === "tmux") {
    const r = await sb.tmux("list-windows", "-t", sb.session, "-F", "#{window_name}");
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }
  if (!hs) throw new Error("teamWindows: herdr needs its sandbox");
  const ws = (hs.herdr(["workspace", "list"]).json as Json)?.result?.workspaces?.find((w: Json) => w.label === sb.session);
  if (!ws) return [];
  return ((hs.herdr(["tab", "list", "--workspace", ws.workspace_id]).json as Json)?.result?.tabs ?? []).map((t: Json) => t.label as string);
}

/** What a team window shows, for failure messages. */
export async function windowText(sb: Sandbox, terminal: Terminal, window: string, hs?: HerdrSandbox): Promise<string> {
  if (terminal === "tmux") return (await sb.tmux("capture-pane", "-p", "-J", "-t", `${sb.session}:${window}`)).stdout;
  if (!hs) return "";
  const ws = (hs.herdr(["workspace", "list"]).json as Json)?.result?.workspaces?.find((w: Json) => w.label === sb.session);
  if (!ws) return "(no herdr workspace)";
  const tab = ((hs.herdr(["tab", "list", "--workspace", ws.workspace_id]).json as Json)?.result?.tabs ?? []).find((t: Json) => t.label === window);
  const pane = ((hs.herdr(["pane", "list", "--workspace", ws.workspace_id]).json as Json)?.result?.panes ?? []).find((p: Json) => p.tab_id === tab?.tab_id);
  return pane ? hs.herdr(["pane", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "60"]).stdout : `(no ${window} tab)`;
}

/**
 * Run the team's Pis on the scripted, model-free provider (tests/e2e/_pi.ts):
 * writes `script` to the sandbox, points config.json's `harnesses.pi` at it, and,
 * for herdr, names the sandbox's private herdr session. Returns the request log's
 * path. Call before the daemon starts.
 */
export function useScriptedPi(sb: Sandbox, team: DemoTeam, script: Script, hs?: HerdrSandbox): string {
  const scriptFile = path.join(sb.root, "script.json");
  const log = path.join(sb.root, "requests.jsonl");
  fs.writeFileSync(scriptFile, JSON.stringify(script, null, 2));
  team.editConfig((config) => {
    config["harnesses"] = { pi: scriptedPiHarness({ script: scriptFile, log }) };
    // herdrSession is config.json-only (the Config page doesn't edit it); the
    // terminal itself is switched through the API, as a person would.
    if (hs) config["herdrSession"] = hs.session;
  });
  return log;
}

/**
 * tests/_herdr.ts — a fake `herdr` CLI for unit tests of the herdr backend
 * (daemon/terminal/herdr.ts), answering from the recorded fixtures.
 *
 * Every response is a real herdr 0.9.5 response from tests/fixtures/herdr/ (recorded,
 * and kept honest, by tests/e2e/herdr-contract.test.ts), with only the ids, labels
 * and lists swapped for this fake world's state — so the backend is tested against
 * the shapes herdr really prints, not shapes a test author imagined. Errors are the
 * recorded stderr JSON with exit status 1, as herdr does.
 *
 * The world is one server (for whichever `--session` is passed) holding workspaces →
 * tabs → one pane each. Ids are assigned the way herdr does (`w1`, `w1:t2`,
 * `w1:p2`), but the backend must never rely on that: it reads them from responses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "../daemon/terminal/tmux.ts";
import type { HerdrExec, HerdrLaunch } from "../daemon/terminal/herdr.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "herdr");

/** Fixtures are untyped JSON; what the backend reads is pinned by its own parsing. */
type Any = any;

/** A recorded response, freshly parsed (callers may mutate it). */
export function herdrFixture(name: string): Any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

export interface FakePane {
  id: string;
  /** True when only the shell runs (e.g. restored after a server restart). */
  idle: boolean;
  /** Every line `pane run` typed into it. */
  typed: string[];
  keys: string[];
}
export interface FakeTab { id: string; label: string; pane: FakePane; env: string[]; cwd?: string }
export interface FakeWorkspace { id: string; label: string; tabs: FakeTab[]; n: number }

export interface FakeHerdr {
  exec: HerdrExec;
  launch: HerdrLaunch;
  /** Every call's argv, `--session <s>` included. */
  calls: string[][];
  /** Every `launch` (server start) argv. */
  launched: string[][];
  workspaces: FakeWorkspace[];
  state: {
    running: boolean;
    version: string;
    /** Does a launch bring the server up? */
    launchStarts: boolean;
    /** A running server's `compatible`. */
    compatible: boolean;
    /** `--version` fails like a missing binary. */
    missing: boolean;
  };
  /** The tab labelled `label` in workspace `ws`, if any. */
  tab(ws: string, label: string): FakeTab | undefined;
}

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const json = (v: unknown): ExecResult => ok(JSON.stringify(v));
const err = (fixture: string, message?: string): ExecResult => {
  const e = herdrFixture(fixture);
  if (message) e.error.message = message;
  return { ok: false, stdout: "", stderr: JSON.stringify(e) };
};

/** A fake herdr; `running` = whether the server starts out up. */
export function fakeHerdr(opts: { running?: boolean; version?: string } = {}): FakeHerdr {
  const calls: string[][] = [];
  const launched: string[][] = [];
  const workspaces: FakeWorkspace[] = [];
  let wsCounter = 0;
  let paneCounter = 0;
  const state = { running: opts.running ?? true, version: opts.version ?? "0.9.5", launchStarts: true, compatible: true, missing: false };

  const flag = (args: string[], name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flags = (args: string[], name: string): string[] =>
    args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));

  const newTab = (ws: FakeWorkspace, label: string, args: string[]): FakeTab => {
    ws.n += 1;
    paneCounter += 1;
    const tab: FakeTab = {
      id: `${ws.id}:t${ws.n}`, label,
      pane: { id: `${ws.id}:p${paneCounter}`, idle: false, typed: [], keys: [] },
      env: flags(args, "--env"), cwd: flag(args, "--cwd"),
    };
    ws.tabs.push(tab);
    return tab;
  };
  const findTab = (id: string) => {
    for (const ws of workspaces) {
      const tab = ws.tabs.find((t) => t.id === id);
      if (tab) return { ws, tab };
    }
    return null;
  };
  const findPane = (id: string) => {
    for (const ws of workspaces) {
      const tab = ws.tabs.find((t) => t.pane.id === id);
      if (tab) return tab.pane;
    }
    return null;
  };

  // The recorded objects, re-labelled: a tab / pane / workspace as herdr prints it.
  const tabJson = (ws: FakeWorkspace, t: FakeTab) => ({ ...herdrFixture("tab-get").result.tab, tab_id: t.id, label: t.label, workspace_id: ws.id });
  const paneJson = (ws: FakeWorkspace, t: FakeTab) => ({ ...herdrFixture("pane-get").result.pane, pane_id: t.pane.id, tab_id: t.id, workspace_id: ws.id });
  const wsJson = (ws: FakeWorkspace) => ({ ...herdrFixture("workspace-create").result.workspace, workspace_id: ws.id, label: ws.label, tab_count: ws.tabs.length });

  const exec: HerdrExec = (argv) => {
    calls.push(argv);
    const args = argv[0] === "--session" ? argv.slice(2) : argv;
    const [cmd, sub] = args;
    if (cmd === "--version") {
      return state.missing ? { ok: false, stdout: "", stderr: "spawnSync herdr ENOENT" } : ok(`herdr ${state.version}\n`);
    }
    if (state.missing) return { ok: false, stdout: "", stderr: "spawnSync herdr ENOENT" };
    if (cmd === "status" && sub === "--json") {
      const st = herdrFixture(state.running ? "status-running" : "status-not-running");
      st.client.version = state.version;
      if (state.running) st.server.compatible = state.compatible;
      return json(st);
    }
    if (cmd === "status" && sub === "server") {
      // Exits 0 either way; not running = the `server` half of `status --json`.
      return json(state.running ? herdrFixture("status-server") : herdrFixture("status-not-running").server);
    }
    if (!state.running) return err("error-server-not-running");

    if (cmd === "workspace" && sub === "list") {
      const res = herdrFixture("workspace-list-empty");
      res.result.workspaces = workspaces.map(wsJson);
      return json(res);
    }
    if (cmd === "workspace" && sub === "create") {
      wsCounter += 1;
      const ws: FakeWorkspace = { id: `w${wsCounter}`, label: flag(args, "--label") ?? "", tabs: [], n: 0 };
      workspaces.push(ws);
      const tab = newTab(ws, "1", args);
      const res = herdrFixture("workspace-create");
      res.result.workspace = wsJson(ws);
      res.result.tab = tabJson(ws, tab);
      res.result.root_pane = paneJson(ws, tab);
      return json(res);
    }
    if (cmd === "tab" && sub === "list") {
      const ws = workspaces.find((w) => w.id === flag(args, "--workspace"));
      if (!ws) return err("error-tab-not-found", "workspace not found");
      const res = herdrFixture("tab-list");
      res.result.tabs = ws.tabs.map((t) => tabJson(ws, t));
      return json(res);
    }
    if (cmd === "pane" && sub === "list") {
      const ws = workspaces.find((w) => w.id === flag(args, "--workspace"));
      if (!ws) return err("error-pane-not-found", "workspace not found");
      const res = herdrFixture("pane-list");
      res.result.panes = ws.tabs.map((t) => paneJson(ws, t));
      return json(res);
    }
    if (cmd === "tab" && sub === "create") {
      const ws = workspaces.find((w) => w.id === flag(args, "--workspace"));
      if (!ws) return err("error-tab-not-found", "workspace not found");
      const tab = newTab(ws, flag(args, "--label") ?? String(ws.n + 1), args);
      const res = herdrFixture("tab-create");
      res.result.tab = tabJson(ws, tab);
      res.result.root_pane = paneJson(ws, tab);
      return json(res);
    }
    if (cmd === "tab" && (sub === "rename" || sub === "focus" || sub === "close")) {
      const found = findTab(args[2] ?? "");
      if (!found) return err("error-tab-not-found", `tab ${args[2]} not found`);
      if (sub === "rename") found.tab.label = args[3] ?? "";
      if (sub === "close") {
        found.ws.tabs = found.ws.tabs.filter((t) => t !== found.tab);
        // Closing the last tab closes the workspace (verified).
        if (found.ws.tabs.length === 0) workspaces.splice(workspaces.indexOf(found.ws), 1);
        return json(herdrFixture("tab-close"));
      }
      const res = herdrFixture(sub === "rename" ? "tab-rename" : "tab-focus");
      res.result.tab = { ...tabJson(found.ws, found.tab), focused: sub === "focus" };
      return json(res);
    }
    if (cmd === "pane" && (sub === "run" || sub === "send-keys")) {
      const pane = findPane(args[2] ?? "");
      if (!pane) return err("error-pane-not-found", `pane ${args[2]} not found`);
      if (sub === "run") {
        pane.typed.push(args[3] ?? "");
        pane.idle = false;
      } else {
        pane.keys.push(args[3] ?? "");
      }
      return ok(); // both print nothing on success
    }
    if (cmd === "pane" && sub === "process-info") {
      const pane = findPane(flag(args, "--pane") ?? "");
      if (!pane) return err("error-pane-not-found");
      const res = herdrFixture("pane-process-info");
      res.result.process_info.pane_id = pane.id;
      res.result.process_info.shell_pid = 100;
      res.result.process_info.foreground_process_group_id = pane.idle ? 100 : 200;
      return json(res);
    }
    return { ok: false, stdout: "", stderr: `fake herdr: unhandled ${args.join(" ")}` };
  };

  const launch: HerdrLaunch = (args) => {
    launched.push(args);
    if (state.launchStarts) state.running = true;
  };

  return {
    exec, launch, calls, launched, workspaces, state,
    tab: (ws, label) => workspaces.find((w) => w.label === ws)?.tabs.find((t) => t.label === label),
  };
}

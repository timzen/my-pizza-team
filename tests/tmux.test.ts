/**
 * tests/tmux.test.ts — the daemon's tmux control (P3-1).
 *
 * Two layers. Most tests inject a fake `exec` and assert the **argv** tmux is
 * invoked with, because that is where the bug being fixed lived: the extension
 * interpolated arguments into a shell command line and sanitised them by *stripping*
 * offending characters, so a project at `/Users/t/My Project` silently became
 * `/Users/t/MyProject` and the teammate span up in the wrong directory. Passing argv
 * arrays removes the class, and asserting on argv is how that stays true.
 *
 * A second layer drives a real tmux server in a throwaway session, skipped when tmux
 * isn't installed. Argv assertions can be self-consistently wrong; only real tmux
 * proves the commands are ones tmux accepts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertThrows } from "./_assert.ts";
import {
  assertSafeName,
  ensureSession,
  type ExecResult,
  focusClient,
  killWindow,
  listWindows,
  renderTemplate,
  sendControl,
  sendKeys,
  shellQuote,
  spawnWindow,
  switchClient,
  type TmuxExec,
  defaultTmuxSocketPath,
  tmuxSocketPath,
  unresolvedPlaceholders,
} from "../daemon/tmux.ts";
import { DEFAULT_HARNESS_TEMPLATES } from "../shared/types.ts";

/** Records every invocation and replies from a scripted queue. */
function fakeTmux(script: Array<Partial<ExecResult>> = []): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const exec: TmuxExec = (args) => {
    calls.push(args);
    const next = script[i++] ?? {};
    return { ok: next.ok ?? true, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { exec, calls };
}

// ─── Quoting ─────────────────────────────────────────────────────────

test("shellQuote survives spaces, quotes, and shell metacharacters", () => {
  assertEquals(shellQuote("/Users/t/My Project"), "'/Users/t/My Project'");
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
  // The characters that would matter if this ever reached a shell unquoted.
  assertEquals(shellQuote("a;rm -rf /"), "'a;rm -rf /'");
  assertEquals(shellQuote("$(whoami)"), "'$(whoami)'");
  assertEquals(shellQuote("`id`"), "'`id`'");
});

// ─── Name validation ─────────────────────────────────────────────────

test("names that tmux would misread are refused, not rewritten", () => {
  // tmux targets are `session:window`, so a ':' or '.' in a name changes which pane
  // is addressed. The old code stripped them, producing a window nobody could find
  // again; refusing says what went wrong.
  for (const bad of ["has:colon", "has.dot", "has space", ""]) {
    assertThrows(() => assertSafeName("window", bad), Error);
  }
  for (const good of ["swift-ripley", "leader", "agent_1", "a-b-c"]) {
    assertSafeName("window", good);
  }
});

// ─── Argv, not shell ─────────────────────────────────────────────────

test("a cwd with spaces reaches tmux intact", () => {
  // The regression this file exists for.
  const { exec, calls } = fakeTmux([{ ok: true }]); // has-session → exists
  spawnWindow(
    { session: "mpt", window: "swift-ripley", cwd: "/Users/t/My Project", command: "pi --ppt-worker" },
    exec,
  );
  const sendKeysCall = calls.find((c) => c[0] === "send-keys")!;
  const typed = sendKeysCall[3]!;
  assertEquals(typed.includes("'/Users/t/My Project'"), true, `cwd was mangled: ${typed}`);
  assertEquals(typed.includes("MyProject"), false, "the space must not be stripped");
});

test("arguments are passed as argv, so nothing is interpolated into a command line", () => {
  const { exec, calls } = fakeTmux([{ ok: false }, { ok: true }]);
  ensureSession("mpt", exec);
  assertEquals(calls[0], ["has-session", "-t", "mpt"]);
  assertEquals(calls[1], ["new-session", "-d", "-s", "mpt"]);
});

// ─── Session and window lifecycle ────────────────────────────────────

test("ensureSession creates only when absent", () => {
  const present = fakeTmux([{ ok: true }]);
  assertEquals(ensureSession("mpt", present.exec), false);
  assertEquals(present.calls.length, 1, "no new-session when it already exists");

  const absent = fakeTmux([{ ok: false }, { ok: true }]);
  assertEquals(ensureSession("mpt", absent.exec), true);
});

test("a failure to create the session is reported, not swallowed", () => {
  const { exec } = fakeTmux([{ ok: false }, { ok: false, stderr: "no server running" }]);
  assertThrows(() => ensureSession("mpt", exec), Error, "no server running");
});

test("listWindows parses names and is empty for a missing session", () => {
  const ok = fakeTmux([{ ok: true, stdout: "leader\nswift-ripley\n\n" }]);
  assertEquals(listWindows("mpt", ok.exec), ["leader", "swift-ripley"]);

  const missing = fakeTmux([{ ok: false }]);
  assertEquals(listWindows("mpt", missing.exec), []);
});

test("spawning twice under one name is a no-op the second time", () => {
  // `new-window -n <name>` would create a duplicate, and then two agents answer to
  // one label — the daemon assigns names, so that would be its bug to own.
  const { exec, calls } = fakeTmux([
    { ok: true }, // has-session → exists
    { ok: true, stdout: "swift-ripley\n" }, // list-windows → already there
  ]);
  assertEquals(spawnWindow({ session: "mpt", window: "swift-ripley", cwd: "/w", command: "pi" }, exec), {
    created: false,
  });
  assertEquals(calls.some((c) => c[0] === "new-window"), false);
  assertEquals(calls.some((c) => c[0] === "send-keys"), false, "and nothing is typed into it");
});

test("a freshly created session reuses its initial window instead of stranding it", () => {
  const { exec, calls } = fakeTmux([
    { ok: false }, // has-session
    { ok: true }, // new-session
    { ok: true }, // rename-window
    { ok: true }, // send-keys
  ]);
  spawnWindow({ session: "mpt", window: "swift-ripley", cwd: "/w", command: "pi" }, exec);
  assertEquals(calls[2], ["rename-window", "-t", "mpt", "swift-ripley"]);
  assertEquals(calls.some((c) => c[0] === "new-window"), false, "no stray extra window");
});

test("if renaming fails, a window is created instead", () => {
  const { exec, calls } = fakeTmux([
    { ok: false }, // has-session
    { ok: true }, // new-session
    { ok: false }, // rename-window fails
    { ok: true }, // new-window
    { ok: true }, // send-keys
  ]);
  spawnWindow({ session: "mpt", window: "swift-ripley", cwd: "/w", command: "pi" }, exec);
  assertEquals(calls.some((c) => c[0] === "new-window"), true);
});

test("control keys are sent as keys, not typed as text", () => {
  // `send-keys C-c` with a trailing Enter would type the literal characters.
  const { exec, calls } = fakeTmux();
  sendControl("mpt", "swift-ripley", "C-c", exec);
  assertEquals(calls[0], ["send-keys", "-t", "mpt:swift-ripley", "C-c"]);
  assertEquals(calls[0]!.includes("Enter"), false);
});

test("sendKeys appends Enter, and a failure is reported", () => {
  const ok = fakeTmux();
  sendKeys("mpt", "w", "/new", ok.exec);
  assertEquals(ok.calls[0], ["send-keys", "-t", "mpt:w", "/new", "Enter"]);

  const bad = fakeTmux([{ ok: false, stderr: "can't find window" }]);
  assertThrows(() => sendKeys("mpt", "w", "/new", bad.exec), Error, "can't find window");
});

test("killWindow reports whether the window was there", () => {
  assertEquals(killWindow("mpt", "w", fakeTmux([{ ok: true }]).exec), true);
  assertEquals(killWindow("mpt", "w", fakeTmux([{ ok: false }]).exec), false);
});

// ─── Moving the user's client (mpt lead inside tmux) ─────────────────

test("switchClient moves the client to session:window, by argv", () => {
  const { exec, calls } = fakeTmux();
  assertEquals(switchClient("mpt", "leader", exec).ok, true);
  assertEquals(calls, [["switch-client", "-t", "mpt:leader"]]);
});

test("switchClient refuses a name tmux would misread as a target", () => {
  const { exec, calls } = fakeTmux();
  assertThrows(() => switchClient("mpt:x", "leader", exec), Error, "target separators");
  assertThrows(() => switchClient("mpt", "lead er", exec), Error, "target separators");
  assertEquals(calls, [], "nothing reaches tmux");
});

test("focusClient selects the window and then switches the client to it", () => {
  // select-window alone left a client in another session (e.g. mpt-services) where it was.
  const { exec, calls } = fakeTmux();
  assertEquals(focusClient("mpt", "leader", exec), null);
  assertEquals(calls, [
    ["select-window", "-t", "mpt:leader"],
    ["switch-client", "-t", "mpt:leader"],
  ]);
});

test("focusClient reports why the client could not be moved", () => {
  const { exec } = fakeTmux([{ ok: true }, { ok: false, stderr: "no current client\n" }]);
  assertEquals(focusClient("mpt", "leader", exec), "no current client");
  const silent = fakeTmux([{ ok: true }, { ok: false }]);
  assertEquals(focusClient("mpt", "leader", silent.exec), "switch-client failed");
});

// ─── Templates ───────────────────────────────────────────────────────

test("a template fills every placeholder, quoting the cwd", () => {
  const rendered = renderTemplate(DEFAULT_HARNESS_TEMPLATES.pi!.teammate, {
    name: "swift-ripley",
    url: "http://localhost:7437",
    cwd: "/Users/t/My Project",
    session: "mpt",
    window: "swift-ripley",
  });
  assertEquals(rendered.includes("--ppt-name=swift-ripley"), true);
  assertEquals(rendered.includes("--ppt-daemon=http://localhost:7437"), true);
  assertEquals(unresolvedPlaceholders(rendered), [], rendered);
});

test("a typo in a config template is reported rather than run", () => {
  // Otherwise the agent starts with a literal "{nmae}" argument and fails obscurely.
  const rendered = renderTemplate("agent --name={nmae}", {
    name: "x",
    url: "u",
    cwd: "/w",
    session: "s",
    window: "w",
  });
  assertEquals(unresolvedPlaceholders(rendered), ["{nmae}"]);
});

test("a cwd placeholder is quoted so a spaced path survives the shell", () => {
  const rendered = renderTemplate("agent --dir={cwd}", {
    name: "x",
    url: "u",
    cwd: "/Users/t/My Project",
    session: "s",
    window: "w",
  });
  assertEquals(rendered, "agent --dir='/Users/t/My Project'");
});

// ─── Which tmux server (mpt doctor's same-server check) ──────────────

test("tmuxSocketPath: a running server answers with its socket", () => {
  const { exec, calls } = fakeTmux([{ ok: true, stdout: "/tmp/tmux-501/default\n" }]);
  assertEquals(tmuxSocketPath(exec, {}), "/tmp/tmux-501/default");
  assertEquals(calls[0], ["display-message", "-p", "#{socket_path}"]);
});

test("tmuxSocketPath: with no server running, tmux's error names the socket", () => {
  const none = fakeTmux([{ ok: false, stderr: "no server running on /private/tmp/tmux-501/default\n" }]);
  assertEquals(tmuxSocketPath(none.exec, {}), "/private/tmp/tmux-501/default");
  const absent = fakeTmux([{ ok: false, stderr: "error connecting to /sandbox/tmux-501/default (No such file or directory)\n" }]);
  assertEquals(tmuxSocketPath(absent.exec, {}), "/sandbox/tmux-501/default");
});

test("tmuxSocketPath: null when tmux can't run at all", () => {
  const { exec } = fakeTmux([{ ok: false, stderr: "spawnSync tmux ENOENT" }, { ok: false, stderr: "spawnSync tmux ENOENT" }]);
  assertEquals(tmuxSocketPath(exec, {}), null);
});

test("defaultTmuxSocketPath: $TMUX wins, else TMUX_TMPDIR (resolved), else /tmp", () => {
  assertEquals(defaultTmuxSocketPath({ TMUX: "/s/tmux-1/work,123,0" }), "/s/tmux-1/work");
  const uid = process.getuid!();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mpt-tmuxdir-")));
  assertEquals(defaultTmuxSocketPath({ TMUX_TMPDIR: dir }), path.join(dir, `tmux-${uid}`, "default"));
  assertEquals(defaultTmuxSocketPath({}), path.join(fs.realpathSync("/tmp"), `tmux-${uid}`, "default"));
  fs.rmSync(dir, { recursive: true });
});


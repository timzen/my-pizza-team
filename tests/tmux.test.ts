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

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertSafeName,
  ensureSession,
  type ExecResult,
  hasSession,
  killWindow,
  listWindows,
  realTmux,
  renderTemplate,
  sendControl,
  sendKeys,
  shellQuote,
  spawnWindow,
  type TmuxExec,
  tmuxAvailable,
  unresolvedPlaceholders,
  windowExists,
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

Deno.test("shellQuote survives spaces, quotes, and shell metacharacters", () => {
  assertEquals(shellQuote("/Users/t/My Project"), "'/Users/t/My Project'");
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
  // The characters that would matter if this ever reached a shell unquoted.
  assertEquals(shellQuote("a;rm -rf /"), "'a;rm -rf /'");
  assertEquals(shellQuote("$(whoami)"), "'$(whoami)'");
  assertEquals(shellQuote("`id`"), "'`id`'");
});

// ─── Name validation ─────────────────────────────────────────────────

Deno.test("names that tmux would misread are refused, not rewritten", () => {
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

Deno.test("a cwd with spaces reaches tmux intact", () => {
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

Deno.test("arguments are passed as argv, so nothing is interpolated into a command line", () => {
  const { exec, calls } = fakeTmux([{ ok: false }, { ok: true }]);
  ensureSession("mpt", exec);
  assertEquals(calls[0], ["has-session", "-t", "mpt"]);
  assertEquals(calls[1], ["new-session", "-d", "-s", "mpt"]);
});

// ─── Session and window lifecycle ────────────────────────────────────

Deno.test("ensureSession creates only when absent", () => {
  const present = fakeTmux([{ ok: true }]);
  assertEquals(ensureSession("mpt", present.exec), false);
  assertEquals(present.calls.length, 1, "no new-session when it already exists");

  const absent = fakeTmux([{ ok: false }, { ok: true }]);
  assertEquals(ensureSession("mpt", absent.exec), true);
});

Deno.test("a failure to create the session is reported, not swallowed", () => {
  const { exec } = fakeTmux([{ ok: false }, { ok: false, stderr: "no server running" }]);
  assertThrows(() => ensureSession("mpt", exec), Error, "no server running");
});

Deno.test("listWindows parses names and is empty for a missing session", () => {
  const ok = fakeTmux([{ ok: true, stdout: "leader\nswift-ripley\n\n" }]);
  assertEquals(listWindows("mpt", ok.exec), ["leader", "swift-ripley"]);

  const missing = fakeTmux([{ ok: false }]);
  assertEquals(listWindows("mpt", missing.exec), []);
});

Deno.test("spawning twice under one name is a no-op the second time", () => {
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

Deno.test("a freshly created session reuses its initial window instead of stranding it", () => {
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

Deno.test("if renaming fails, a window is created instead", () => {
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

Deno.test("control keys are sent as keys, not typed as text", () => {
  // `send-keys C-c` with a trailing Enter would type the literal characters.
  const { exec, calls } = fakeTmux();
  sendControl("mpt", "swift-ripley", "C-c", exec);
  assertEquals(calls[0], ["send-keys", "-t", "mpt:swift-ripley", "C-c"]);
  assertEquals(calls[0]!.includes("Enter"), false);
});

Deno.test("sendKeys appends Enter, and a failure is reported", () => {
  const ok = fakeTmux();
  sendKeys("mpt", "w", "/new", ok.exec);
  assertEquals(ok.calls[0], ["send-keys", "-t", "mpt:w", "/new", "Enter"]);

  const bad = fakeTmux([{ ok: false, stderr: "can't find window" }]);
  assertThrows(() => sendKeys("mpt", "w", "/new", bad.exec), Error, "can't find window");
});

Deno.test("killWindow reports whether the window was there", () => {
  assertEquals(killWindow("mpt", "w", fakeTmux([{ ok: true }]).exec), true);
  assertEquals(killWindow("mpt", "w", fakeTmux([{ ok: false }]).exec), false);
});

// ─── Templates ───────────────────────────────────────────────────────

Deno.test("a template fills every placeholder, quoting the cwd", () => {
  const rendered = renderTemplate(DEFAULT_HARNESS_TEMPLATES.pi!, {
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

Deno.test("a typo in a config template is reported rather than run", () => {
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

Deno.test("a cwd placeholder is quoted so a spaced path survives the shell", () => {
  const rendered = renderTemplate("agent --dir={cwd}", {
    name: "x",
    url: "u",
    cwd: "/Users/t/My Project",
    session: "s",
    window: "w",
  });
  assertEquals(rendered, "agent --dir='/Users/t/My Project'");
});

// ─── Against a real tmux server ──────────────────────────────────────

const TMUX = tmuxAvailable();

Deno.test({
  name: "end to end against a real tmux server",
  ignore: !TMUX,
  async fn() {
    // Argv assertions can be self-consistently wrong; only real tmux proves these
    // are commands tmux accepts. Uses a unique session name and always tears down.
    const session = `mpt-test-${crypto.randomUUID().slice(0, 8)}`;
    try {
      assertEquals(hasSession(session), false);
      assertEquals(ensureSession(session), true);
      assertEquals(hasSession(session), true);

      // A directory with a space — the regression this whole file is about.
      const dir = await Deno.makeTempDir({ prefix: "mpt tmux test " });
      try {
        const marker = `${dir}/it-worked`;
        spawnWindow({
          session,
          window: "worker-one",
          cwd: dir,
          command: `touch ${shellQuote("it-worked")}`,
        });
        assertEquals(windowExists(session, "worker-one"), true);

        // The command ran in the right directory, space and all.
        let created = false;
        for (let i = 0; i < 50 && !created; i++) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            Deno.statSync(marker);
            created = true;
          } catch { /* not yet */ }
        }
        assertEquals(created, true, `command did not run in ${dir}`);

        // Idempotent by name.
        assertEquals(spawnWindow({ session, window: "worker-one", cwd: dir, command: "true" }).created, false);
        assertEquals(listWindows(session).filter((w) => w === "worker-one").length, 1);

        assertEquals(killWindow(session, "worker-one"), true);
        assertEquals(windowExists(session, "worker-one"), false);
      } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    } finally {
      realTmux(["kill-session", "-t", session]);
    }
  },
});

Deno.test({
  name: "a name tmux would misread never reaches tmux",
  ignore: !TMUX,
  fn() {
    assertThrows(() => hasSession("bad:name"), Error, "target separators");
  },
});

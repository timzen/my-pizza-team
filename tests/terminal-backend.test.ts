/**
 * tests/terminal-backend.test.ts — the `TerminalBackend` interface and its tmux
 * implementation (daemon/terminal/).
 *
 * Introducing the interface was a pure refactor, so what these pin is that the
 * adapter changes nothing: each backend method makes exactly the tmux calls the
 * function it wraps always made (tests/tmux.test.ts covers those functions' argv in
 * detail), and `getTerminalBackend` gives every team tmux. A fake `TmuxExec` stands
 * in for tmux; tests/e2e/tmux.test.ts drives a real one.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { getTerminalBackend } from "../daemon/terminal/index.ts";
import { createTmuxBackend, type ExecResult, type TmuxExec } from "../daemon/terminal/tmux.ts";
import { probeTerminalCapability } from "../daemon/spawner.ts";

/** Records every invocation; `reply` decides each result (default: ok, no output). */
function fakeTmux(reply: (args: string[]) => Partial<ExecResult> = () => ({})): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TmuxExec = (args) => {
    calls.push(args);
    const r = reply(args);
    return { ok: r.ok ?? true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

test("getTerminalBackend gives every team tmux, over the injected exec", () => {
  const { exec, calls } = fakeTmux();
  const terminal = getTerminalBackend({ tmuxSession: "team" }, { tmuxExec: exec });
  assertEquals(terminal.kind, "tmux");
  assertEquals(terminal.displayName, "tmux");
  assertEquals(terminal.available(), true);
  assertEquals(calls, [["-V"]]);
});

test("the tmux backend's window methods make the same tmux calls as before", () => {
  const { exec, calls } = fakeTmux((args) =>
    args[0] === "list-windows" ? { stdout: "leader\nswift-ripley\n" } : {}
  );
  const terminal = createTmuxBackend(exec);
  const ref = terminal.windowRef("team", "swift-ripley");
  assertEquals(ref, { session: "team", window: "swift-ripley" });

  assertEquals(terminal.listWindows("team"), ["leader", "swift-ripley"]);
  assertEquals(terminal.findWindow("team", "swift-ripley"), ref);
  assertEquals(terminal.findWindow("team", "gone"), null);
  terminal.sendLine(ref, "echo hi");
  terminal.sendControl(ref, "C-c");
  assertEquals(terminal.closeWindow(ref), true);
  assertEquals(terminal.focusWindow(ref), true);
  assertEquals(calls, [
    ["list-windows", "-t", "team", "-F", "#{window_name}"],
    ["list-windows", "-t", "team", "-F", "#{window_name}"],
    ["list-windows", "-t", "team", "-F", "#{window_name}"],
    ["send-keys", "-t", "team:swift-ripley", "echo hi", "Enter"],
    ["send-keys", "-t", "team:swift-ripley", "C-c"],
    ["kill-window", "-t", "team:swift-ripley"],
    ["select-window", "-t", "team:swift-ripley"],
  ]);
});

test("openWindow is spawnWindow: idempotent by name, and returns the window's ref", () => {
  const existing = fakeTmux((args) => (args[0] === "list-windows" ? { stdout: "worker\n" } : {}));
  const opened = createTmuxBackend(existing.exec).openWindow({ session: "team", window: "worker", cwd: "/p", command: "pi" });
  assertEquals(opened, { created: false, ref: { session: "team", window: "worker" } });
  assertEquals(existing.calls.some((c) => c[0] === "new-window" || c[0] === "send-keys"), false);

  const fresh = fakeTmux((args) => (args[0] === "has-session" ? { ok: false } : {}));
  const made = createTmuxBackend(fresh.exec).openWindow({ session: "team", window: "worker", cwd: "/My Project", command: "pi", env: { A: "1" } });
  assertEquals(made.created, true);
  assertEquals(fresh.calls, [
    ["has-session", "-t", "team"],
    ["new-session", "-d", "-s", "team", "-e", "A=1"],
    ["rename-window", "-t", "team", "worker"],
    ["send-keys", "-t", "team:worker", "cd '/My Project' && pi", "Enter"],
  ]);
});

test("unavailable() carries tmux's reason and fix, and the capability probe uses it", () => {
  const missing = createTmuxBackend(fakeTmux(() => ({ ok: false, stderr: "spawnSync tmux ENOENT" })).exec);
  assertEquals(missing.unavailableReason(), "not-installed");
  assertEquals(missing.unavailable()?.reason, "tmux is not on this process's PATH");
  const cap = probeTerminalCapability(missing);
  assertEquals(cap.canSpawn, false);

  const denied = createTmuxBackend(fakeTmux(() => ({ ok: false, stderr: "spawnSync tmux EACCES" })).exec);
  assertEquals(denied.unavailable()?.reason, "this process is not permitted to run tmux");

  assertEquals(probeTerminalCapability(createTmuxBackend(fakeTmux().exec)), { canSpawn: true });
});

test("identity is the tmux socket, and insideClient reads $TMUX", () => {
  const { exec } = fakeTmux((args) => (args[0] === "display-message" ? { stdout: "/tmp/tmux-1/default\n" } : {}));
  const terminal = createTmuxBackend(exec, {});
  assertEquals(terminal.identity(), "/tmp/tmux-1/default");
  assertEquals(terminal.insideClient({}), false);
  assertEquals(terminal.insideClient({ TMUX: "/tmp/tmux-1/default,123,0" }), true);
});

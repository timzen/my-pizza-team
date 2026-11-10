/**
 * tests/unmanaged-windows.test.ts — the Team tab's "Unmanaged windows": windows in the
 * team's terminal container that no online member, the leader, or a starting spawn
 * accounts for (daemon/unmanaged-windows.ts), the backends' `windowActivity`, and
 * `POST /api/unmanaged-windows/close`, which closes only a window that list holds.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, post, get } from "./_team.ts";
import { fakeHerdr } from "./_herdr.ts";
import { unmanagedWindowLabels, UnmanagedWindowTracker } from "../daemon/unmanaged-windows.ts";
import { createTmuxBackend, type ExecResult, type TmuxExec } from "../daemon/terminal/tmux.ts";
import { createHerdrBackend } from "../daemon/terminal/herdr.ts";
import type { UnmanagedWindow } from "../shared/types.ts";

const config = { tmuxSession: "team", terminal: "tmux" as const };

/** A fake tmux whose session holds `windows` (name → foreground command); kill-window removes one. */
function fakeTmux(windows: Record<string, string>) {
  const live = new Map(Object.entries(windows));
  const calls: string[][] = [];
  const exec: TmuxExec = (args): ExecResult => {
    calls.push(args);
    if (args[0] === "list-windows") {
      const withCommand = args.at(-1)!.includes("pane_current_command");
      return { ok: true, stdout: [...live].map(([w, cmd]) => (withCommand ? `${cmd}:${w}` : w)).join("\n"), stderr: "" };
    }
    if (args[0] === "kill-window") return { ok: live.delete(args[2]!.split(":")[1]!), stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  return { exec, calls, live };
}

test("unmanagedWindowLabels: a member's window, the leader and an inbound spawn are accounted for; a bonus tab isn't", () => {
  const labels = unmanagedWindowLabels({
    terminal: "tmux", session: "team", config,
    labels: ["leader", "swift-ripley", "bold-kirk", "bonus", "old-spock", "bonus"],
    members: [
      // Its window from metadata, which need not be its name.
      { name: "teammate-a", status: "idle", metadata: { terminal: "tmux", terminalSession: "team", terminalWindow: "swift-ripley" } },
      // Offline: its window is unaccounted for.
      { name: "old-spock", status: "offline", metadata: { terminal: "tmux", terminalSession: "team", terminalWindow: "old-spock" } },
    ],
    reserved: ["bold-kirk"], // a spawn within its registration grace
  });
  assertEquals(labels, ["bonus", "old-spock"]);
});

test("unmanagedWindowLabels: a member in another container or backend doesn't claim a label here", () => {
  const labels = unmanagedWindowLabels({
    terminal: "tmux", session: "team", config, reserved: [],
    labels: ["a", "b"],
    members: [
      { name: "a", status: "idle", metadata: { terminal: "tmux", terminalSession: "elsewhere", terminalWindow: "a" } },
      { name: "b", status: "idle", metadata: { terminal: "herdr", terminalSession: "team", terminalWindow: "b" } },
    ],
  });
  assertEquals(labels, ["a", "b"]);
});

test("tmux windowActivity: a shell is idle, anything else is running, an unknown window is unknown", () => {
  const t = fakeTmux({ sh: "-zsh", agent: "pi", other: "node", "my tab: two": "pi" });
  const b = createTmuxBackend(t.exec);
  // A user's own tab may be named anything tmux can't target; it is matched by name, never targeted.
  assertEquals(b.windowActivity(b.windowRef("team", "my tab: two")), { running: true, command: "pi" });
  assertEquals(b.windowActivity(b.windowRef("team", "sh")), { running: false, command: "zsh" });
  assertEquals(b.windowActivity(b.windowRef("team", "agent")), { running: true, command: "pi" });
  assertEquals(b.windowActivity(b.windowRef("team", "other")), { running: true, command: "node" });
  assertEquals(b.windowActivity(b.windowRef("team", "gone")), { running: null, command: null });
});

test("herdr windowActivity: from pane process-info (idle pane = only its shell)", () => {
  const h = fakeHerdr();
  const b = createHerdrBackend({ exec: h.exec, launch: h.launch, sleep: () => {}, serverTimeoutMs: 200 });
  b.openWindow({ session: "team", window: "busy", cwd: "/tmp", command: "pi" });
  b.openWindow({ session: "team", window: "idle", cwd: "/tmp", command: "pi" });
  h.tab("team", "idle")!.pane.idle = true;
  const busy = b.windowActivity(b.windowRef("team", "busy"));
  assertEquals(busy.running, true);
  assertEquals(typeof busy.command, "string");
  assertEquals(b.windowActivity(b.windowRef("team", "idle")).running, false);
  assertEquals(b.windowActivity(b.windowRef("team", "nope")), { running: null, command: null });
});

test("UnmanagedWindowTracker caches a scan for its TTL and rescans after", () => {
  const t = fakeTmux({ leader: "pi", bonus: "pi" });
  let now = 0;
  const tracker = new UnmanagedWindowTracker({
    backend: () => createTmuxBackend(t.exec), members: () => [], config: () => config, reserved: () => [],
  }, 10_000, () => now);
  assertEquals(tracker.list().map((w) => w.window), ["bonus"]);
  const scans = () => t.calls.filter((c) => c[0] === "list-windows" && c.at(-1) === "#{window_name}").length;
  assertEquals(scans(), 1);
  t.live.set("extra", "bash");
  now = 5_000;
  assertEquals(tracker.list().map((w) => w.window), ["bonus"]); // cached
  assertEquals(scans(), 1);
  now = 10_000;
  assertEquals(tracker.list().map((w) => w.window), ["bonus", "extra"]);
  assertEquals(scans(), 2);
});

test("GET /api/teammate-pool lists unmanaged windows; none when the scan isn't enabled", async () => {
  await withTeam(config, async ({ app, store }) => {
    const before = await (await get(app, "/api/teammate-pool")).json() as { unmanagedWindows: UnmanagedWindow[] };
    assertEquals(before.unmanagedWindows, []);

    const t = fakeTmux({ leader: "pi", "swift-ripley": "pi", "bold-kirk": "pi", bonus: "node" });
    store.setWindowBackend(() => createTmuxBackend(t.exec));
    store.registerMember("a1", "swift-ripley", undefined, { terminal: "tmux", terminalSession: "team", terminalWindow: "swift-ripley" });
    // An inbound spawn: its window is open, its teammate hasn't registered yet.
    const d = store.createLeaderDirective("spawn", { params: { name: "bold-kirk", reason: "teammate" } });
    store.updateLeaderDirective(d.id, "done");

    const res = await (await get(app, "/api/teammate-pool")).json() as { unmanagedWindows: UnmanagedWindow[]; online: number };
    assertEquals(res.unmanagedWindows, [{ window: "bonus", session: "team", terminal: "tmux", running: true, command: "node" }]);
  });
});

test("POST /api/unmanaged-windows/close closes an unmanaged window and refuses anything else", async () => {
  await withTeam(config, async ({ app, store }) => {
    const t = fakeTmux({ leader: "pi", "swift-ripley": "pi", "bold-kirk": "pi", bonus: "pi" });
    store.setWindowBackend(() => createTmuxBackend(t.exec));
    store.registerMember("a1", "swift-ripley", undefined, { terminal: "tmux", terminalSession: "team", terminalWindow: "swift-ripley" });
    store.createLeaderDirective("spawn", { params: { name: "bold-kirk", reason: "teammate" } });

    for (const window of ["leader", "swift-ripley", "bold-kirk", "nope"]) {
      const res = await post(app, "/api/unmanaged-windows/close", { window });
      assertEquals(res.status, 404, window);
      assertEquals(t.live.has(window), window !== "nope");
    }
    assertEquals(t.calls.some((c) => c[0] === "kill-window"), false);
    assertEquals((await post(app, "/api/unmanaged-windows/close", {})).status, 400);

    const res = await post(app, "/api/unmanaged-windows/close", { window: "bonus" });
    assertEquals(res.status, 200);
    assertEquals(t.live.has("bonus"), false);
    assertEquals((await res.json() as { unmanagedWindows: UnmanagedWindow[] }).unmanagedWindows, []);
  });
});

test("nothing is closed automatically: listing, polling and reconciling never close a window", async () => {
  await withTeam({ ...config, minTeammates: 0 }, async ({ app, store }) => {
    const t = fakeTmux({ leader: "pi", bonus: "pi", spare: "bash" });
    store.setWindowBackend(() => createTmuxBackend(t.exec));
    for (let i = 0; i < 3; i++) {
      await get(app, "/api/teammate-pool");
      store.reconcileTeammatePool();
    }
    assertEquals(t.calls.some((c) => c[0] === "kill-window"), false);
    assertEquals([...t.live.keys()], ["leader", "bonus", "spare"]);
  });
});

test("closing an unmanaged window tmux can't target is a 409 with the reason, not a crash", async () => {
  await withTeam(config, async ({ app, store }) => {
    const t = fakeTmux({ leader: "pi", "my tab": "bash" });
    store.setWindowBackend(() => createTmuxBackend(t.exec));
    const listed = await (await get(app, "/api/teammate-pool")).json() as { unmanagedWindows: UnmanagedWindow[] };
    assertEquals(listed.unmanagedWindows.map((w) => [w.window, w.running]), [["my tab", false]]);
    const res = await post(app, "/api/unmanaged-windows/close", { window: "my tab" });
    assertEquals(res.status, 409);
    assertEquals(t.live.has("my tab"), true);
  });
});

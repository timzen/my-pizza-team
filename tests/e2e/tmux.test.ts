/**
 * tests/e2e/tmux.test.ts — daemon/tmux.ts against a real tmux server.
 *
 * The unit tests (tests/tmux.test.ts) inject a fake exec and assert the argv. That
 * catches the bug being fixed — arguments are no longer interpolated into a shell, so
 * a cwd with a space is no longer mangled — but argv assertions can be
 * self-consistently wrong. Only a real server proves these are commands tmux accepts.
 *
 * Runs on the sandbox's **private** tmux server. It previously used uniquely named
 * sessions on the user's real server, where a collision or a stray `kill-server`
 * would have taken out their actual sessions.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  ensureSession,
  hasSession,
  killWindow,
  listWindows,
  shellQuote,
  spawnWindow,
  tmuxUnavailableReason,
  windowExists,
} from "../../daemon/tmux.ts";
import { hasTmux, sandbox } from "./_sandbox.ts";

Deno.test("tmux is probed with permission, so a skip below means tmux is truly absent", () => {
  // Guards against this file once reporting green while testing nothing: the suite
  // lacked --allow-run, the probe caught the permission error, and the real-tmux tests
  // quietly vanished.
  assertEquals(
    tmuxUnavailableReason() === "not-permitted",
    false,
    "tmux could not be probed for lack of run permission — add --allow-run to the test task",
  );
});

Deno.test({
  name: "sessions and windows work end to end, including a cwd with spaces",
  ignore: !hasTmux(),
  async fn() {
    await using sb = await sandbox("tmux");
    const exec = sb.tmuxExec;

    assertEquals(hasSession(sb.session, exec), false);
    assertEquals(ensureSession(sb.session, exec), true);
    assertEquals(hasSession(sb.session, exec), true);

    // A directory with a space — the regression this file exists for.
    const dir = await Deno.makeTempDir({ dir: sb.root, prefix: "has space " });
    spawnWindow(
      { session: sb.session, window: "worker-one", cwd: dir, command: `touch ${shellQuote("it-worked")}` },
      exec,
    );
    assertEquals(windowExists(sb.session, "worker-one", exec), true);

    // The command ran in the right directory, space and all.
    const ran = await sb.waitFor(() => {
      try {
        Deno.statSync(`${dir}/it-worked`);
        return true;
      } catch {
        return false;
      }
    }, 5000);
    assertEquals(ran, true, `command did not run in ${dir}`);

    // Idempotent by name.
    assertEquals(
      spawnWindow({ session: sb.session, window: "worker-one", cwd: dir, command: "true" }, exec).created,
      false,
    );
    assertEquals(listWindows(sb.session, exec).filter((w) => w === "worker-one").length, 1);

    assertEquals(killWindow(sb.session, "worker-one", exec), true);
    assertEquals(windowExists(sb.session, "worker-one", exec), false);
  },
});

Deno.test({
  name: "a fresh session reuses its initial window rather than stranding it",
  ignore: !hasTmux(),
  async fn() {
    // The bug `mpt lead` hit: a stray `zsh` window beside the one we asked for.
    await using sb = await sandbox("tmux-fresh");
    spawnWindow({ session: sb.session, window: "only-one", cwd: sb.projectDir, command: "true" }, sb.tmuxExec);
    assertEquals(listWindows(sb.session, sb.tmuxExec), ["only-one"]);
  },
});

Deno.test("a name tmux would misread never reaches tmux", () => {
  assertThrows(() => hasSession("bad:name"), Error, "target separators");
});

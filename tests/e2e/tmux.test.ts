/**
 * tests/e2e/tmux.test.ts — daemon/tmux.ts against a real tmux server.
 *
 * The unit tests (tests/tmux.test.ts) inject a fake exec and assert the argv. That
 * catches the bug being fixed — arguments are no longer interpolated into a shell —
 * but argv assertions can be self-consistently wrong. Only a real server proves these
 * are commands tmux accepts. Kept in the e2e suite because each run starts tmux.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  hasSession,
  ensureSession,
  killWindow,
  listWindows,
  realTmux,
  shellQuote,
  spawnWindow,
  tmuxAvailable,
  tmuxUnavailableReason,
  windowExists,
} from "../../daemon/tmux.ts";

const TMUX = tmuxAvailable();

Deno.test("the integration tests skip only because tmux is absent, never because of permissions", () => {
  // Guards against the reason this file once reported green while testing nothing:
  // the suite ran without --allow-run, `tmuxAvailable()` caught the permission
  // error, and the real-tmux tests quietly vanished.
  const reason = tmuxUnavailableReason();
  assertEquals(
    reason === "not-permitted",
    false,
    "tmux could not be probed for lack of run permission — add --allow-run to the test task",
  );
});

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

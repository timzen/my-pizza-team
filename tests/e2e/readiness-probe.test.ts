/**
 * tests/e2e/readiness-probe.test.ts — the readiness probe against a real shell.
 *
 * The unit tests inject a runner, which could be self-consistently wrong about how
 * `sh` behaves. These run real commands — exit codes, output, pipes, and a hang cut
 * off by the timeout. In the e2e suite because the timeout case waits.
 */

import { assertEquals } from "@std/assert";
import { runProbe } from "../../daemon/readiness.ts";

Deno.test("a real command's exit code and output are read correctly", async () => {
  // The injected runner could be self-consistently wrong about how sh behaves.
  assertEquals(await runProbe("exit 0"), { ready: true });

  const failed = await runProbe("echo 'vpn is down'; exit 3");
  assertEquals(failed.ready, false);
  assertEquals(failed.reason, "vpn is down");
});

Deno.test("a shell probe is run as written, pipes and all", async () => {
  // It is user config; the point is to honour what they wrote.
  assertEquals((await runProbe("echo ok | grep -q ok")).ready, true);
  assertEquals((await runProbe("echo no | grep -q yes")).ready, false);
});

Deno.test("a probe that hangs is cut off promptly and reported not ready", async () => {
  // Asserting promptness is the whole point. The first version only checked
  // `ready === false`, and on Linux it passed after waiting the full 30 seconds: the
  // timeout killed `sh`, but dash doesn't exec its last command, so `sleep` survived
  // holding the pipes. A genuinely hung probe would have stalled readiness forever.
  const started = Date.now();
  const result = await runProbe("sleep 30", { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assertEquals(result.ready, false);
  assertEquals(elapsed < 5000, true, `the timeout did not bound the probe: took ${elapsed}ms`);
  assertEquals(result.reason?.includes("timed out"), true, `reason should say it timed out: ${result.reason}`);
});

Deno.test("a pipeline that hangs is cut off too", async () => {
  // Several processes under one `sh`: the case most likely to leave something holding
  // a pipe open after the shell is killed.
  const started = Date.now();
  const result = await runProbe("sleep 30 | cat", { timeoutMs: 300 });
  assertEquals(result.ready, false);
  assertEquals(Date.now() - started < 5000, true, `took ${Date.now() - started}ms`);
});

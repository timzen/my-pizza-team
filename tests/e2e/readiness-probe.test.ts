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

Deno.test("a probe that hangs is cut off and reported not ready", async () => {
  const result = await runProbe("sleep 30", { timeoutMs: 300 });
  assertEquals(result.ready, false);
});

/**
 * tests/e2e/entry-points.test.ts — every way of starting the daemon gets the same
 * daemon.
 *
 * `deno task dev`/`start` run daemon/main.ts; `mpt start` runs the CLI. They used to
 * be separate startup routines, and the source one skipped the spawn-capability probe
 * and the readiness loop — so under `deno task dev`, /health said spawning was
 * "not probed", spawns silently fell to the leader, and a configured readiness probe
 * never ran. Both now go through daemon/start.ts; these start each for real and look
 * for the work only that routine does.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { sandbox } from "./_sandbox.ts";

for (const entry of ["cli", "source"] as const) {
  Deno.test(`${entry === "cli" ? "mpt start" : "daemon/main.ts"}: probes spawning and runs the readiness probe`, async () => {
    await using sb = await sandbox(`entry-${entry}`);
    sb.writeTeamConfig({ readinessProbe: "echo creds-expired; exit 1" });
    await sb.startDaemon(entry);

    const health = async () => await (await fetch(`http://127.0.0.1:${sb.port}/health`)).json();
    // The readiness loop's first tick runs at startup; allow it a moment.
    const probed = await sb.waitFor(async () => (await health()).notReady !== null);
    const h = await health();
    assert(probed, `readiness probe never ran: ${JSON.stringify(h.notReady)}`);
    assertEquals(h.notReady.reason, "creds-expired");
    // Probed either way — reachable tmux or a reason it isn't — never left unprobed.
    assertNotEquals(h.spawning.reason, "not probed");
  });
}

Deno.test("mpt start --daemon: runs in the background and logs to daemon.log", async () => {
  // From source, too — it used to re-execute `deno` itself as though it were `mpt`,
  // and never started. Its output went to pipes nobody read, so nothing said why.
  await using sb = await sandbox("entry-bg");
  sb.writeTeamConfig({});
  try {
    const started = await sb.mpt("start", "--daemon");
    assertEquals(started.code, 0, started.output);
    assert(started.output.includes("daemon.log"), `says where the log is: ${started.output}`);
    assert((await fetch(`http://127.0.0.1:${sb.port}/health`)).ok);
    const log = Deno.readTextFileSync(`${sb.teamDir}/daemon.log`);
    assert(log.includes("listening on"), `the daemon's own output is in the log:\n${log}`);
  } finally {
    await sb.mpt("stop");
  }
  // Restarting keeps the previous run's log.
  try {
    assertEquals((await sb.mpt("start", "--daemon")).code, 0);
    assert(Deno.readTextFileSync(`${sb.teamDir}/daemon.log.1`).includes("listening on"));
  } finally {
    await sb.mpt("stop");
  }
});

Deno.test("mpt start --daemon: a startup failure is reported, and logged", async () => {
  await using sb = await sandbox("entry-bg-fail");
  sb.writeTeamConfig({});
  // Hold the port, so the background daemon can't bind it.
  const blocker = Deno.listen({ port: sb.port, hostname: "127.0.0.1" });
  try {
    const started = await sb.mpt("start", "--daemon");
    assertNotEquals(started.code, 0, "a daemon that didn't start is a failure");
    assert(started.output.includes("daemon.log"), started.output);
    const log = Deno.readTextFileSync(`${sb.teamDir}/daemon.log`);
    assert(/AddrInUse|address already in use/i.test(log), `the reason is in the log:\n${log}`);
  } finally {
    blocker.close();
  }
});

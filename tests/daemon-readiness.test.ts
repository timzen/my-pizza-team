/**
 * tests/daemon-readiness.test.ts — the readiness probe, run by the daemon (P3-2).
 *
 * The inversion this fixes is the reason it moved. While an *agent* reported readiness,
 * an unreported team counted as ready — it has to, since a freshly booted daemon knows
 * nothing — so a machine too wedged for the leader to even start was treated as
 * **healthy**, and the scheduler kept feeding work into it. The daemon is running
 * whenever it matters, so it can answer with zero agents connected.
 *
 * The other thing asserted here: an *unrunnable* probe is "not ready", not "ready".
 * A probe confirms the machine can work; one that cannot launch confirms nothing, and
 * defaulting to ready would disable gating exactly when something is already wrong.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import {
  type ProbeRunner,
  runProbe,
  startReadinessLoop,
  type ReadinessStore,
} from "../daemon/readiness.ts";

/** A store stub recording what readiness was reported. */
function fakeStore(config: Partial<TeamConfig> = {}) {
  const reports: Array<{ ready: boolean; reason?: string }> = [];
  const store: ReadinessStore = {
    getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
    setTeamReadiness: (ready, reason) => reports.push({ ready, reason }),
  };
  return { store, reports };
}

const runner = (result: { code: number; stdout?: string; stderr?: string }): ProbeRunner =>
  () => Promise.resolve({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });

// ─── One probe run ───────────────────────────────────────────────────

Deno.test("exit 0 is ready, with no reason to show", async () => {
  assertEquals(await runProbe("true", { runner: runner({ code: 0 }) }), { ready: true });
});

Deno.test("a non-zero exit is not ready, preferring the probe's own message", async () => {
  // The probe was written to be read by a human; its stdout beats a generic string.
  const result = await runProbe("check", {
    runner: runner({ code: 1, stdout: "mwinit credentials expired\nextra detail" }),
  });
  assertEquals(result.ready, false);
  assertEquals(result.reason, "mwinit credentials expired");
});

Deno.test("stderr is used when stdout is silent", async () => {
  const result = await runProbe("check", { runner: runner({ code: 2, stderr: "  kinit: no ticket  " }) });
  assertEquals(result.reason, "kinit: no ticket");
});

Deno.test("a silent failure still reports something actionable", async () => {
  const result = await runProbe("check", { runner: runner({ code: 7 }) });
  assertEquals(result.ready, false);
  assertStringIncludes(result.reason!, "7");
});

Deno.test("a probe that cannot be launched is NOT ready", async () => {
  // The case that matters most: defaulting to ready here would disable gating at
  // precisely the moment the machine is misbehaving.
  const result = await runProbe("nonexistent-command", {
    runner: () => Promise.resolve({ code: -1, stdout: "", stderr: "command not found" }),
  });
  assertEquals(result.ready, false);
  assertStringIncludes(result.reason!, "command not found");
});

Deno.test("runProbe never throws, whatever the runner does", async () => {
  const result = await runProbe("check", {
    runner: () => Promise.resolve({ code: -1, stdout: "", stderr: "Timed out" }),
  });
  assertEquals(result.ready, false);
});

// ─── The loop ────────────────────────────────────────────────────────

Deno.test("no probe configured means nothing is reported", async () => {
  // And an unreported team counts as ready — the right default: a team with no probe
  // has nothing to be unready about.
  const { store, reports } = fakeStore({ readinessProbe: undefined });
  const stop = startReadinessLoop(store, { runner: runner({ code: 1 }) });
  assertEquals(stop, null, "no loop should start");
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(reports, []);
});

Deno.test("a whitespace-only probe counts as unconfigured", async () => {
  const { store } = fakeStore({ readinessProbe: "   " });
  assertEquals(startReadinessLoop(store, { runner: runner({ code: 0 }) }), null);
});

Deno.test("the probe runs immediately, not only after the first interval", async () => {
  // A daemon that waited 30s would schedule into a wedged machine for 30s.
  const { store, reports } = fakeStore({ readinessProbe: "check-creds" });
  const stop = startReadinessLoop(store, { runner: runner({ code: 1, stdout: "creds expired" }), intervalMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(reports.length, 1);
    assertEquals(reports[0], { ready: false, reason: "creds expired" });
  } finally {
    stop?.();
  }
});

Deno.test("recovery is reported, clearing the reason", async () => {
  const { store, reports } = fakeStore({ readinessProbe: "check-creds" });
  let code = 1;
  const stop = startReadinessLoop(store, {
    runner: () => Promise.resolve({ code, stdout: code === 0 ? "" : "expired", stderr: "" }),
    intervalMs: 10,
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    code = 0;
    await new Promise((r) => setTimeout(r, 40));
    const last = reports.at(-1)!;
    assertEquals(last.ready, true);
    assertEquals(last.reason, undefined);
  } finally {
    stop?.();
  }
});

Deno.test("a slow probe is skipped rather than queued", async () => {
  // A probe slower than the interval would otherwise pile up runs forever.
  const { store, reports } = fakeStore({ readinessProbe: "slow" });
  let started = 0;
  const stop = startReadinessLoop(store, {
    runner: () => {
      started++;
      return new Promise((r) => setTimeout(() => r({ code: 0, stdout: "", stderr: "" }), 120));
    },
    intervalMs: 10,
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(started, 1, `expected one in-flight probe, saw ${started}`);
    assertEquals(reports.length, 0, "and nothing reported until it finishes");
  } finally {
    stop?.();
  }
});

Deno.test("stopping the loop stops the probing", async () => {
  const { store, reports } = fakeStore({ readinessProbe: "check" });
  const stop = startReadinessLoop(store, { runner: runner({ code: 0 }), intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 25));
  stop?.();
  const after = reports.length;
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(reports.length, after, "no further reports after stopping");
});

// ─── Against a real shell ────────────────────────────────────────────

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

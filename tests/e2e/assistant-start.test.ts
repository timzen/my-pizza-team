/**
 * tests/e2e/assistant-start.test.ts — starting the demo team's assistant (the Pi
 * leader) the way the web UI does, under tmux and under herdr.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("The team's terminal", "Start the
 * assistant"). The demo team (tests/e2e/_demo.ts) runs its Pis on the scripted,
 * model-free provider (tests/e2e/_pi.ts), so the leader really starts, loads the
 * MPT extension and registers — with no LLM call.
 *
 *   - herdr only: the terminal is switched the way Config → General → Terminal does
 *     (PUT /api/config); /health then reports herdr, available, in the sandbox's
 *     private session — and switching back to tmux takes.
 *   - /health says the assistant is startable.
 *   - POST /api/assistant/start (the Start button) answers 201 `started` in that
 *     terminal; a second POST is 200 `already-running`, and there is exactly one
 *     leader window.
 *   - The leader connects: GET /api/agents lists `leader`.
 *
 * Isolation: the sandbox's private tmux server (tests/e2e/_sandbox.ts) and, for
 * herdr, its own config dir and named session (tests/e2e/_herdr.ts) — the user's
 * tmux and herdr are never addressed. Skips only where tmux / herdr, or
 * harnesses/pi's Pi, isn't installed.
 */

import { test } from "node:test";
import { assert, assertEquals } from "../_assert.ts";
import { hasTmux, sandbox } from "./_sandbox.ts";
import { hasHerdr, herdrSandbox } from "./_herdr.ts";
import { hasPi } from "./_pi.ts";
import { api, demoTeam, type Json, putTerminal, switchToHerdr, type Terminal, teamWindows, useScriptedPi, windowText } from "./_demo.ts";

const SKIP: Record<Terminal, boolean> = { tmux: !hasTmux() || !hasPi(), herdr: !hasHerdr() || !hasPi() };

for (const terminal of ["tmux", "herdr"] as const) {
  test(`${terminal}: POST /api/assistant/start starts the leader once; it connects`, { skip: SKIP[terminal] }, async () => {
    await using sb = await sandbox(`assistant-${terminal}`);
    // Declared after the sandbox, so it is torn down first: stopping the herdr
    // server ends the agents in its panes before the sandbox reaps and removes.
    await using hs = terminal === "herdr" ? await herdrSandbox() : undefined;
    const team = demoTeam(sb);
    useScriptedPi(sb, team, { default: [{ name: "fallback", turns: [{ text: "scripted leader here" }] }] }, hs);
    await sb.startDaemon("source", { env: hs?.daemonEnv ?? {} });
    const a = api(sb);

    if (hs) await switchToHerdr(a, hs);

    const startable = (await a.get("/health")).body.assistantStartable;
    assertEquals(startable?.ok, true, `the daemon can't start the assistant: ${JSON.stringify(startable)}`);

    const first = await a.post("/api/assistant/start");
    assertEquals([first.status, first.body.status, first.body.terminal], [201, "started", terminal], JSON.stringify(first.body));
    const again = await a.post("/api/assistant/start");
    assertEquals([again.status, again.body.status], [200, "already-running"], JSON.stringify(again.body));
    assertEquals((await teamWindows(sb, terminal, hs)).filter((w) => w === "leader").length, 1, "expected one leader window");

    const connected = await sb.waitFor(async () => ((await a.get("/api/agents")).body.agents as Json[]).some((m) => m.id === "leader"), 30_000);
    assert(connected, `the leader never registered:\n${await windowText(sb, terminal, "leader", hs)}`);

    if (hs) {
      // Back to the default, as run-e2e.sh's restore did: the API switch takes.
      assertEquals(await putTerminal(a, null), 200);
      assertEquals((await a.get("/health")).body.terminal, "tmux");
    }
  });
}

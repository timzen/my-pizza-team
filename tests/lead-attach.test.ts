/**
 * tests/lead-attach.test.ts — how `mpt assistant` hands over the user's terminal
 * (cli/lead-attach.ts), per backend and environment.
 *
 * The rules that matter: inside the backend's own client, move it (never nest); tmux
 * elsewhere attaches as it always has; herdr inside tmux, or inside another herdr
 * server's pane, prints the attach command instead of nesting one terminal in
 * another. `--no-attach` prints the backend's own attach and switch hints.
 * tests/e2e/herdr-backend.test.ts runs the real CLI through these paths.
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { fakeHerdr } from "./_herdr.ts";
import { attachPlan, noAttachHints } from "../cli/lead-attach.ts";
import { createHerdrBackend } from "../daemon/terminal/herdr.ts";
import { createTmuxBackend } from "../daemon/terminal/tmux.ts";

const SOCKET = "/tmp/herdr-sandbox/c/herdr/sessions/mpt-sandbox/herdr.sock";
const herdr = (session?: string) => {
  const h = fakeHerdr();
  return createHerdrBackend({ exec: h.exec, launch: h.launch, session, sleep: () => {} });
};
const tmux = () => createTmuxBackend(() => ({ ok: true, stdout: "", stderr: "" }), {});

test("tmux: inside tmux moves the client; anywhere else (even a herdr pane) attaches", () => {
  assertEquals(attachPlan(tmux(), { TMUX: "/tmp/tmux-1/default,1,0" }), { action: "focus" });
  assertEquals(attachPlan(tmux(), {}), { action: "attach" });
  assertEquals(attachPlan(tmux(), { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET }), { action: "attach" });
});

test("herdr: inside the team's herdr focuses the tab; a plain terminal attaches", () => {
  assertEquals(attachPlan(herdr(), { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET }), { action: "focus" });
  assertEquals(attachPlan(herdr(), {}), { action: "attach" });
});

test("herdr: inside tmux, or another herdr server's pane, prints instead of nesting", () => {
  const inTmux = attachPlan(herdr(), { TMUX: "/tmp/tmux-1/default,1,0" });
  assertEquals(inTmux.action, "print");
  if (inTmux.action === "print") assertStringIncludes(inTmux.why, "inside tmux");
  const otherHerdr = attachPlan(herdr(), { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/elsewhere/herdr.sock" });
  assertEquals(otherHerdr.action, "print");
  if (otherHerdr.action === "print") assertStringIncludes(otherHerdr.why, "different herdr server");
});

test("--no-attach hints: the backend's attach command, and how to get there from inside it", () => {
  const t = tmux();
  assertEquals(noAttachHints(t, t.windowRef("mpt", "leader")), [
    "Attach with: tmux attach -t mpt:leader",
    "From inside tmux: tmux switch-client -t mpt:leader",
  ]);
  const h = herdr("mine");
  const [attach, inside] = noAttachHints(h, h.windowRef("mpt", "leader"));
  assertEquals(attach, "Attach with: herdr session attach mine");
  assertStringIncludes(inside!, 'From inside herdr: switch to the "leader" tab');
});

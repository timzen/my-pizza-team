/**
 * tests/start-assistant-ui.test.ts — "Start the assistant" (ui/src/lib/start-assistant.ts,
 * rendered by ui/src/components/assistant/StartAssistant.tsx): the button is
 * offered unless `/health` says the daemon can't start the assistant (then its
 * reason and fix are), a start or an already-running leader is "Starting…", a
 * refusal is the daemon's reason and fix, and every screen that used to send the
 * user to a terminal renders the shared button instead of the bare command.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import { START_UNREACHABLE, startAvailability, startOutcome } from "../ui/src/lib/start-assistant.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_SRC = path.join(ROOT, "ui/src");

test("startAvailability: offered until /health says otherwise", () => {
  assertEquals(startAvailability(null), { canStart: true });
  assertEquals(startAvailability({}), { canStart: true }); // an older daemon
  assertEquals(startAvailability({ assistantStartable: { ok: true } }), { canStart: true });
  assertEquals(
    startAvailability({ assistantStartable: { ok: false, reason: "tmux is not installed", fix: "install tmux" } }),
    { canStart: false, reason: "tmux is not installed", fix: "install tmux" },
  );
  // A refusal without words still says something.
  const bare = startAvailability({ assistantStartable: { ok: false } });
  assertEquals(bare.canStart, false);
  if (!bare.canStart) assertEquals(bare.reason.length > 0 && bare.fix.length > 0, true);
});

test("startOutcome: started and already-running are both Starting…", () => {
  assertEquals(
    startOutcome({ success: true, status: "started", session: "mpt", window: "leader" }),
    { kind: "starting", where: "mpt:leader", already: false },
  );
  assertEquals(
    startOutcome({ success: true, status: "already-running", session: "mpt", window: "leader" }),
    { kind: "starting", where: "mpt:leader", already: true },
  );
  assertEquals(startOutcome({ success: true, status: "started" }), { kind: "starting", where: null, already: false });
});

test("startOutcome: a refusal is the daemon's reason and fix", () => {
  assertEquals(
    startOutcome({ success: false, status: "error", reason: "tmux is not installed", fix: "install tmux" }),
    { kind: "error", message: "Couldn't start the assistant: tmux is not installed. To fix it, install tmux." },
  );
  assertEquals(startOutcome({ success: false, reason: "no template" }), {
    kind: "error", message: "Couldn't start the assistant: no template.",
  });
  assertEquals(startOutcome({ success: false, error: "Unauthorized" }), {
    kind: "error", message: "Couldn't start the assistant: Unauthorized.",
  });
  assertEquals(startOutcome(null), { kind: "error", message: "Couldn't start the assistant." });
  assertEquals(START_UNREACHABLE.length > 0, true);
});

/** Every .tsx file under ui/src, relative. */
function tsxFiles(dir = UI_SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : e.name.endsWith(".tsx") ? [path.relative(UI_SRC, p)] : [];
  });
}

test("every screen that sends the user to start the leader offers the button", () => {
  const hosts = [
    "components/onboarding/WelcomeCard.tsx",
    "components/team/TeamEmpty.tsx",
    "components/TeamSizeDialog.tsx",
    "components/assistant/AssistantPane.tsx",
  ];
  for (const f of hosts) {
    const src = fs.readFileSync(path.join(UI_SRC, f), "utf8");
    assertEquals(src.includes("<StartAssistant"), true, `${f} renders <StartAssistant>`);
  }
  // The bare command lives only in the shared button's "Or from a terminal".
  const showing = tsxFiles().filter((f) => fs.readFileSync(path.join(UI_SRC, f), "utf8").includes("LEADER_COMMAND"));
  assertEquals(showing, ["components/assistant/StartAssistant.tsx"]);
});

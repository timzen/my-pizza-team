/**
 * tests/a11y-labels-ui.test.ts — The words the web UI gives controls whose
 * pictures say the rest (docs/ACCESSIBILITY.md "Rules for new UI code"): the
 * Pizza Team home link's name and tooltip, which say what its number-only
 * badges count (ui/src/lib/inbox.ts), and a teammate's summary — status first,
 * as text — which names its row link and rail avatar (ui/src/lib/team.ts).
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { homeLinkCounts, homeLinkLabel } from "../ui/src/lib/inbox.ts";
import { teammateSummary, type Teammate } from "../ui/src/lib/team.ts";

const teammate = (over: Partial<Teammate> = {}): Teammate => ({
  id: "m1", name: "worker-1", status: "idle", currentWork: null, lastHeartbeat: 0,
  session: null, workItemId: null, persona: null, ...over,
});

test("homeLinkLabel: the visible name first, then the badges' counts in words", () => {
  assertEquals(homeLinkLabel(undefined, undefined), "Pizza Team");
  assertEquals(homeLinkLabel(0, 0), "Pizza Team");
  assertEquals(homeLinkLabel(2, 3), "Pizza Team · 3 unread in Inbox · 2 queued");
  assertEquals(homeLinkLabel(150, null), "Pizza Team · 150 queued"); // the real count, not the badge's 99+
});

test("homeLinkCounts: only the counts a badge would show", () => {
  assertEquals(homeLinkCounts(null, null), []);
  assertEquals(homeLinkCounts(0, 1), ["1 unread in Inbox"]);
  assertEquals(homeLinkCounts(4, -1), ["4 queued"]);
});

test("teammateSummary: name and status always, then whatever the row shows", () => {
  assertEquals(teammateSummary(teammate()), "worker-1 · Waiting for work");
  assertEquals(teammateSummary(teammate({ status: "offline" })), "worker-1 · Lost contact");
  assertEquals(
    teammateSummary(teammate({
      status: "working",
      currentWork: "Fix the build",
      persona: { id: "reviewer", title: "Reviewer", origin: "team", via: "workflow-state" },
      session: {
        model: { name: "Claude Sonnet", id: "claude-sonnet", provider: "anthropic" },
        contextTokens: 84_000, contextWindow: 200_000, contextPercent: 42, costUsd: 1.25, at: 0,
      },
    })),
    "worker-1 · Working · Claude Sonnet · ⚙️ Fix the build · as Reviewer · 42% context · $1.25",
  );
});

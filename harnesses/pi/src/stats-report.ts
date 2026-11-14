// Session stats for the Team tab — the model, context fill and session cost —
// reported by every role (teammate and leader) the same way.
//
// Reported after every turn (that's when the context grows and cost accrues),
// after compaction (which shrinks the context), and when the model is switched
// (`model_select`: a `/model`, a persona's model, a `set-model` directive), so
// the Team tab's model follows a switch at once. Unchanged numbers aren't
// re-sent. The first report is the fresh session's baseline (system prompt).
// The arithmetic is runtime/session-stats.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./runtime/client.js";
import { readSessionStats, sameStats, type SessionStats } from "./runtime/session-stats.js";

/** The reporter `attachSessionStats` returns. */
export interface SessionStatsReporter {
  /** Send the last report again (a re-registration cleared the daemon's copy). */
  resend(): void;
}

/** Hook the stats reports onto `pi`'s events and send the baseline from `ctx`. */
export function attachSessionStats(pi: ExtensionAPI, client: DaemonClient, ctx: unknown): SessionStatsReporter {
  let last: SessionStats | null = null;
  const report = (c: unknown, model?: { id?: string; name?: string; provider?: string }) => {
    const stats = readSessionStats(c as Parameters<typeof readSessionStats>[0], model);
    if (sameStats(last, stats)) return;
    last = stats;
    client.reportSessionStats(stats).catch(() => {});
  };
  pi.on("turn_end", async (_event, c) => { report(c); });
  pi.on("agent_end", async (_event, c) => { report(c); });
  pi.on("session_compact", async (_event, c) => { report(c); });
  pi.on("model_select", async (event, c) => { report(c, event.model); });
  report(ctx);
  return {
    resend: () => { if (last) client.reportSessionStats(last).catch(() => {}); },
  };
}

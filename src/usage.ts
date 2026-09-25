// Run usage: what one Pi agent run cost, for the daemon's token-usage ledger
//
// Every run (a teammate's work item, a pairing exchange, the leader answering
// the chat) is reported once, on agent_end, via POST /api/agents/:id/usage
// (my-pizza-team daemon/routes/usage.ts), labelled with its kind. This module
// only does the arithmetic, so it's unit-tested (tests/usage.test.mjs).
//
// **Cache tokens count.** Pi's `usage.input` is only the *uncached* input; with
// prompt caching most input is `cacheRead`/`cacheWrite`. Reporting input+output
// alone made a real Opus run show "3 input tokens". Cost was always right —
// it's Pi's own cache-aware `usage.cost.total`.

/** Loose view of Pi's AgentMessage (content is a union; usage only on assistant messages). */
interface MessageLike {
  role?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }> | string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Pi's cache-aware total — the real cost. */
  costUsd: number;
  model: string;
  /** The run's last assistant prose (a work item's completion summary). */
  lastText: string;
}

/** Sum a run's assistant-message usage and find its last prose. */
export function summarizeRun(messages: MessageLike[] | undefined): RunUsage {
  const out: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: "unknown", lastText: "" };
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") continue;
    const u = msg.usage;
    if (u) {
      out.inputTokens += u.input || 0;
      out.outputTokens += u.output || 0;
      out.cacheReadTokens += u.cacheRead || 0;
      out.cacheWriteTokens += u.cacheWrite || 0;
      out.costUsd += u.cost?.total || 0;
    }
    if (msg.model && out.model === "unknown") out.model = msg.model;
    if (!out.lastText && Array.isArray(msg.content)) {
      const part = msg.content.find((p) => p.type === "text" && typeof p.text === "string");
      if (part) out.lastText = part.text as string;
    }
  }
  return out;
}

/** Did the run use anything worth a ledger row? */
export function hasUsage(u: RunUsage): boolean {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0 || u.costUsd > 0;
}

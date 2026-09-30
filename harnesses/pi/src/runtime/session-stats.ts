// Session stats: the model this agent is running, how full its context window
// is, and what its session has cost so far — what Pi's own footer shows — for
// the web UI's Team tab. Reported after every turn via POST /api/agents/:id/session-stats
// (my-pizza-team daemon/routes/agents.ts; shared/types.ts MemberSessionStats).
//
// This module only does the arithmetic, so it's unit-tested
// (tests/session-stats.test.mjs). The cost walk mirrors Pi's footer
// (modes/interactive/components/footer.js): the *whole* session's entries, not
// just the post-compaction context, so compacting never makes the cost go down.

/** Pi's ctx.getContextUsage() result (extensions/types.d.ts ContextUsage). */
export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Loose view of a Pi session entry — only the fields that carry usage. */
interface EntryLike {
  type?: string;
  usage?: { cost?: { total?: number } };
  message?: { role?: string; usage?: { cost?: { total?: number } } };
}

/** Loose view of Pi's Model (pi-ai BaseModel): only what the Team tab shows. */
export interface ModelLike {
  id?: string;
  name?: string;
  provider?: string;
}

export interface SessionStats {
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  costUsd: number;
  model: { id: string; name: string; provider: string } | null;
}

/** The model's id/name/provider, or null without an id. */
export function modelInfo(m: ModelLike | undefined | null): SessionStats["model"] {
  if (!m?.id) return null;
  return { id: m.id, name: m.name || m.id, provider: m.provider || "" };
}

/** The session's cumulative cost: every entry Pi's footer counts. */
export function sessionCost(entries: EntryLike[] | undefined): number {
  let total = 0;
  for (const e of entries || []) {
    let cost: number | undefined;
    if (e.type === "usage" || e.type === "branch_summary" || e.type === "compaction") cost = e.usage?.cost?.total;
    else if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) cost = e.message.usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** Combine Pi's context usage and the session's entries into one report. */
export function sessionStats(usage: ContextUsageLike | undefined, entries: EntryLike[] | undefined, model?: ModelLike | null): SessionStats {
  return {
    contextTokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow || null,
    contextPercent: usage?.percent ?? null,
    costUsd: sessionCost(entries),
    model: modelInfo(model),
  };
}

/**
 * Read the stats off a Pi extension context. Never throws (a torn-down ctx
 * yields empty stats). `model` overrides `ctx.model` — a model_select event
 * carries the new model before the context necessarily reflects it.
 */
export function readSessionStats(ctx: {
  getContextUsage?: () => ContextUsageLike | undefined;
  sessionManager?: { getEntries?: () => EntryLike[] };
  model?: ModelLike;
}, model?: ModelLike): SessionStats {
  let usage: ContextUsageLike | undefined;
  let entries: EntryLike[] | undefined;
  let current: ModelLike | undefined = model;
  try { usage = ctx.getContextUsage?.(); } catch { /* unknown */ }
  try { entries = ctx.sessionManager?.getEntries?.(); } catch { /* unknown */ }
  try { current ??= ctx.model; } catch { /* unknown */ }
  return sessionStats(usage, entries, current);
}

/** Same numbers? (Skips re-sending an unchanged report.) */
export function sameStats(a: SessionStats | null, b: SessionStats): boolean {
  return !!a && a.contextTokens === b.contextTokens && a.contextWindow === b.contextWindow &&
    a.contextPercent === b.contextPercent && a.costUsd === b.costUsd &&
    a.model?.id === b.model?.id && a.model?.provider === b.model?.provider;
}

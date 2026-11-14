/**
 * shared/failover.ts — The failover policy's pure rules (docs/DESIGN.md "Model
 * Failover"): checking a `TeamConfig.failover` from a save, and turning a chain
 * entry (a model id or a `modelAliases` name) into a harness's model id.
 *
 * The daemon's failover state machine (daemon/failover.ts) and Config → Models
 * (ui/src/components/config/ModelsTab.tsx) both use these, so the rules a
 * save is checked against and the ones the daemon runs by are the same.
 * Vendor-neutral: a model id is an opaque string; nothing here knows a provider.
 * Pure: no I/O.
 */

import { FAILOVER_TRIP_KINDS, type FailoverConfig, type TeamConfig } from "./types.ts";
import type { ModelErrorKind } from "./agent-protocol.ts";

/** The longest chain entry accepted (the daemon's bound on a model string). */
const MAX_ENTRY_LENGTH = 200;
/** The most chain entries kept: a failover chain is a handful of models. */
export const MAX_FAILOVER_CHAIN = 10;

/**
 * A chain entry as `harness` names it: the alias's model id when
 * `modelAliases.<harness>` maps it, else the entry itself (already a model id).
 */
export function resolveChainEntry(config: Pick<TeamConfig, "modelAliases">, entry: string, harness: string): string {
  const mapped = config.modelAliases?.[harness]?.[entry];
  return typeof mapped === "string" && mapped.trim() ? mapped.trim() : entry;
}

/**
 * Check a `failover` value from a save request. Unknown keys are refused (a
 * typo would otherwise be a silent no-op); `on` may not name `auth` or
 * `context`, which never trip a failover; counts are positive integers. The
 * chain is trimmed, blanks dropped, and duplicates refused. Returns the cleaned
 * policy or the first error.
 */
export function validateFailover(raw: unknown): { value: FailoverConfig } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "failover must be an object: { enabled, on, after, windowMinutes, chain, revertAfterMinutes }" };
  }
  const f = raw as Record<string, unknown>;
  const known = new Set(["enabled", "on", "after", "windowMinutes", "chain", "revertAfterMinutes"]);
  const unknown = Object.keys(f).find((k) => !known.has(k));
  if (unknown) return { error: `failover.${unknown} is not a failover setting` };
  const out: FailoverConfig = {};
  if (f.enabled !== undefined) {
    if (typeof f.enabled !== "boolean") return { error: "failover.enabled must be a boolean" };
    out.enabled = f.enabled;
  }
  if (f.on !== undefined) {
    if (!Array.isArray(f.on) || f.on.length === 0) return { error: "failover.on must be a non-empty list of error kinds" };
    for (const k of f.on) {
      if (k === "auth" || k === "context") return { error: `failover.on: "${k}" never trips a failover (readiness and the normal failure handling deal with it)` };
      if (!FAILOVER_TRIP_KINDS.includes(k as ModelErrorKind)) return { error: `failover.on: "${String(k)}" is not one of ${FAILOVER_TRIP_KINDS.join(", ")}` };
    }
    out.on = [...new Set(f.on as ModelErrorKind[])];
  }
  for (const key of ["after", "windowMinutes", "revertAfterMinutes"] as const) {
    const v = f[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { error: `failover.${key} must be a whole number of at least 1` };
    out[key] = v;
  }
  if (f.chain !== undefined) {
    if (!Array.isArray(f.chain)) return { error: "failover.chain must be a list of model ids or aliases, primary first" };
    const chain: string[] = [];
    for (const e of f.chain) {
      if (typeof e !== "string") return { error: "failover.chain entries must be model ids or aliases (strings)" };
      const entry = e.trim();
      if (!entry) continue;
      if (entry.length > MAX_ENTRY_LENGTH) return { error: `failover.chain entries must be at most ${MAX_ENTRY_LENGTH} characters` };
      if (chain.includes(entry)) return { error: `failover.chain lists "${entry}" twice` };
      chain.push(entry);
    }
    if (chain.length > MAX_FAILOVER_CHAIN) return { error: `failover.chain may have at most ${MAX_FAILOVER_CHAIN} entries` };
    out.chain = chain;
  }
  if (out.enabled && (out.chain?.length ?? 0) < 2) {
    return { error: "failover.chain needs at least two entries (the primary, then a model to fall back on) to turn failover on" };
  }
  return { value: out };
}

/** What `failoverLine` reads of a `FailoverView` (GET /api/failover, `/api/status`). */
export interface FailoverLineInput {
  active: boolean;
  from: string | null;
  to: string | null;
  since: string | null;
  trips: Array<{ kind: ModelErrorKind }>;
  exhausted?: boolean;
}

/**
 * The one line that says a failover is in effect — "Failover: <from> → <to>
 * since <time> (<kind>)", the kind being the latest switch's — or null when
 * none is. The Team tab's banner, the phone's Team tab and `mpt status` all say
 * it this way; `formatTime` renders the ISO time for its reader (a local
 * clock time in the UI and the CLI, anything fixed in tests).
 */
export function failoverLine(f: FailoverLineInput | null | undefined, formatTime: (iso: string) => string): string | null {
  if (!f?.active || !f.to) return null;
  const kind = f.trips.at(-1)?.kind;
  let line = `Failover: ${f.from ?? "the primary"} → ${f.to}`;
  if (f.since) line += ` since ${formatTime(f.since)}`;
  if (kind) line += ` (${kind})`;
  if (f.exhausted) line += ` — ${f.to} is failing too (end of the chain)`;
  return line;
}

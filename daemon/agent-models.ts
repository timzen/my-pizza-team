/**
 * daemon/agent-models.ts — Reading what harnesses and the UI send about models.
 *
 * Model switching (docs/DESIGN.md "Choosing a Model") keeps model ids opaque:
 * the harness reports the models it can use (`AvailableModel`) and validates
 * whatever is asked of it; the daemon only checks shapes. These are those
 * checks, shared by the agent routes (registration, POST /api/agents/:id/models)
 * and the model routes (POST /api/agents/:id/model, POST /api/agents/model).
 */

import type { AvailableModel, SetModelParams, SetModelSource } from "../shared/protocol.ts";

/** The longest model string accepted: an id, not a document. */
export const MAX_MODEL_REF_LENGTH = 200;
/** The most models one agent's report keeps (a catalogue that large is a bug, not a menu). */
export const MAX_AVAILABLE_MODELS = 500;
/** The longest `reason` kept on a set-model directive. */
const MAX_REASON_LENGTH = 300;

const SOURCES: readonly SetModelSource[] = ["user", "failover", "default"];

/** A trimmed, bounded string, or null. */
function text(v: unknown, max = MAX_MODEL_REF_LENGTH): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * A harness's model report, cleaned: entries without a usable id are dropped,
 * `name` falls back to the id, `ref` to `provider/id` (or the id with no
 * provider) — the form an older report would have meant — and duplicates (by
 * ref) are kept once. Null when `value` isn't a list at all (nothing reported).
 */
export function parseAvailableModels(value: unknown): AvailableModel[] | null {
  if (!Array.isArray(value)) return null;
  const out: AvailableModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    const id = text(m.id);
    if (!id) continue;
    const provider = text(m.provider) ?? "";
    const ref = text(m.ref) ?? (provider ? `${provider}/${id}` : id);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, id, name: text(m.name) ?? id, provider });
    if (out.length >= MAX_AVAILABLE_MODELS) break;
  }
  return out;
}

/**
 * The `model` of a model request: a non-empty string (trimmed), or null to
 * clear. Anything else is an error to return as a 400.
 */
export function parseModelRef(value: unknown): { value: string | null } | { error: string } {
  if (value === null) return { value: null };
  if (typeof value !== "string" || !value.trim()) return { error: "Field 'model' must be a model id string, or null to clear the pin" };
  if (value.trim().length > MAX_MODEL_REF_LENGTH) return { error: `Field 'model' must be at most ${MAX_MODEL_REF_LENGTH} characters` };
  return { value: value.trim() };
}

/** Build a set-model directive's params (the reason trimmed and bounded, absent when empty). */
export function setModelParams(model: string | null, source: SetModelSource, reason?: unknown): SetModelParams {
  const why = text(reason, MAX_REASON_LENGTH);
  return { model, source, ...(why ? { reason: why } : {}) };
}

/** Read a stored directive's params back as set-model params, or null when they aren't. */
export function readSetModelParams(params: Record<string, unknown>): SetModelParams | null {
  const source = SOURCES.find((s) => s === params.source);
  if (!source) return null;
  if (params.model !== null && typeof params.model !== "string") return null;
  return { model: params.model as string | null, source, ...(typeof params.reason === "string" ? { reason: params.reason } : {}) };
}

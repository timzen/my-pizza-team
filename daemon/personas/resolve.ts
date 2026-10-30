/**
 * daemon/personas/resolve.ts — Turning a persona id into a body, and finding who
 * references a persona.
 *
 * `resolvePersona` is the single resolver every prompt builder uses
 * (docs/DESIGN.md "Resolution: one `resolvePersona`, never fails a claim"). The
 * callers walk their own chain (state → …, mirror → source → …) to pick one id
 * and say how they got it (`via`); this turns that id into a body. **A missing
 * id never fails a claim**: it resolves to the consumer's built-in with
 * `fallbackFrom` set, and the Store logs it once per id per run.
 *
 * `personaUsage` is the "Used by" scan behind `GET /api/personas/:id` and
 * delete protection — computed on demand from the references (workflow states,
 * triage, assistant, WorkDefs, mirror overrides, per-source settings), so there
 * is no reverse index to keep consistent.
 *
 * Both are pure over their inputs, so they test without a Store.
 */

import type {
  BuiltinPersonaId, Persona, PersonaRef, PersonaUsage, PersonaVia, ResolvedPersona, TeamConfig, WorkDef, WorkflowConfig,
} from "../../shared/types.ts";
import { personaOriginLabel } from "../../shared/types.ts";

/** How the resolver looks a persona up (team, built-in, package — the Store's `getPersona`). */
export type PersonaLookup = (id: string) => Persona | null;

/** `resolvePersona`'s options: how the caller got here, and its built-in stand-in. */
export interface ResolveOptions {
  via: PersonaVia;
  /** The built-in that stands in for an id that doesn't resolve; null = no persona. */
  fallback: BuiltinPersonaId | null;
}

/**
 * Resolve one persona id. An empty `ref` means the consumer has no persona (null
 * — a consumer whose unset default is a built-in passes that built-in's id). An
 * id that doesn't resolve yields `opts.fallback` with `fallbackFrom` set, or null
 * when there is no fallback.
 */
export function resolvePersona(lookup: PersonaLookup, ref: string | undefined | null, opts: ResolveOptions): ResolvedPersona | null {
  if (!ref) return null;
  const found = lookup(ref);
  if (found) return toResolved(found, opts.via);
  if (!opts.fallback) return null;
  const stand = lookup(opts.fallback);
  if (!stand) return null;
  return { ...toResolved(stand, opts.via), fallbackFrom: ref };
}

function toResolved(p: Persona, via: PersonaVia): ResolvedPersona {
  return { id: p.id, title: p.title, origin: p.origin, body: p.content, via };
}

/** The WorkItem snapshot of a resolved persona (`WorkItem.persona`). */
export function personaRefOf(r: ResolvedPersona): PersonaRef {
  const ref: PersonaRef = { id: r.id, title: r.title, origin: personaOriginLabel(r.origin), via: r.via };
  if (r.fallbackFrom) ref.fallbackFrom = r.fallbackFrom;
  return ref;
}

/** Everything `personaUsage` scans. */
export interface PersonaUsageInput {
  workflows: Record<string, WorkflowConfig>;
  config: Pick<TeamConfig, "triage" | "assistant" | "sourcePersonas">;
  workDefs: Array<Pick<WorkDef, "id" | "title" | "persona">>;
  /** Per-mirror overrides (a source's kv `persona:<defId>`). */
  mirrorOverrides: Array<{ workDefId: string; source: string; persona: string }>;
}

/** Every reference to persona `id`, in a stable order (workflows, triage, assistant, WorkDefs, mirrors, sources). */
export function personaUsage(id: string, input: PersonaUsageInput): PersonaUsage[] {
  const out: PersonaUsage[] = [];
  for (const [workflow, wf] of Object.entries(input.workflows).sort(([a], [b]) => a.localeCompare(b))) {
    for (const s of wf.states) {
      if (s.type === "agent" && s.persona === id) out.push({ kind: "workflow-state", workflow, state: s.name });
    }
  }
  if (input.config.triage?.persona === id) out.push({ kind: "triage" });
  if (input.config.assistant?.persona === id) out.push({ kind: "assistant" });
  for (const d of input.workDefs) {
    if (d.persona === id) out.push({ kind: "workdef", workDefId: d.id, title: d.title });
  }
  for (const m of input.mirrorOverrides) {
    if (m.persona === id) out.push({ kind: "mirror-override", workDefId: m.workDefId, source: m.source });
  }
  for (const [source, setting] of Object.entries(input.config.sourcePersonas ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (setting?.persona === id) out.push({ kind: "source-setting", source, field: "persona" });
    if (setting?.triagePersona === id) out.push({ kind: "source-setting", source, field: "triagePersona" });
  }
  return out;
}

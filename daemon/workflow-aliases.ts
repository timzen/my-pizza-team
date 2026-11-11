/**
 * daemon/workflow-aliases.ts — The daemon's deprecated workflow spellings.
 *
 * DEPRECATED(worker→teammate): remove in remove-worker-aliases.
 *
 * The workflow state type `agent` became `teammate`. The old spelling keeps
 * working: every place the daemon takes in a workflow — `workflow.json` on load
 * (BoardStore, the persona "Used by" scan) and a workflow in a write body
 * (`PUT /api/config`) — goes through `normalizeWorkflowStateTypes`, so the rest
 * of the daemon only ever sees `teammate`. The alias logs a deprecation warning
 * naming its replacement **once per run**. A file is never rewritten on load;
 * it says `teammate` the next time it's saved.
 *
 * The map itself lives in shared/types.ts (`LEGACY_WORKFLOW_STATE_TYPE_ALIASES`).
 * Removing the alias means deleting this file, its few call sites, and that map.
 */

import { canonicalWorkflowStateType, LEGACY_WORKFLOW_STATE_TYPE_ALIASES } from "../shared/types.ts";

/** The aliases already warned about this run. */
const warned = new Set<string>();

/** Log the deprecation of state type `alias` (once per run). */
function warnOnce(alias: string, replacement: string): void {
  if (warned.has(alias)) return;
  warned.add(alias);
  console.warn(`[workflows] state type '${alias}' is deprecated; use '${replacement}'`);
}

/**
 * `wf` with every state's legacy `type` (`agent`) in its canonical spelling
 * (`teammate`), with a one-time warning. Anything else — a non-object, no
 * `states` array, an unknown type — is returned as is, for `validateWorkflow`
 * to judge. Returns `wf` itself when nothing needed mapping, else a copy.
 */
export function normalizeWorkflowStateTypes<T>(wf: T): T {
  const states = (wf as { states?: unknown } | null)?.states;
  if (!Array.isArray(states)) return wf;
  let changed = false;
  const next = states.map((s: unknown) => {
    const type = (s as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !Object.hasOwn(LEGACY_WORKFLOW_STATE_TYPE_ALIASES, type)) return s;
    const canonical = canonicalWorkflowStateType(type)!;
    warnOnce(type, canonical);
    changed = true;
    return { ...(s as object), type: canonical };
  });
  return changed ? { ...wf, states: next } : wf;
}

/** Forget which aliases were warned about (tests only: each asserts its own one-time warning). */
export function resetWorkflowAliasWarnings(): void {
  warned.clear();
}

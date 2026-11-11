/**
 * daemon/personas/aliases.ts — The daemon's deprecated persona spellings.
 *
 * DEPRECATED(worker→teammate): remove in remove-worker-aliases.
 *
 * The persona kind `worker` became `teammate`, and the built-in `builtin:worker`
 * became `builtin:teammate`. The old spellings keep working: every place the
 * daemon reads a persona kind (frontmatter `kinds`, `GET /api/personas?kind=`,
 * a save body) goes through `normalizePersonaKind`, and every persona id lookup
 * goes through `normalizePersonaId` (the built-in lookup, the "Used by" scan).
 * Each alias logs a deprecation warning naming its replacement **once per run**,
 * not on every request.
 *
 * The maps themselves live in shared/types.ts (`LEGACY_PERSONA_KIND_ALIASES`,
 * `LEGACY_PERSONA_ID_ALIASES`) so the UI maps the same spellings. Removing the
 * aliases means deleting this file, its few call sites, and those maps.
 */

import {
  canonicalPersonaId, canonicalPersonaKind, LEGACY_PERSONA_ID_ALIASES, LEGACY_PERSONA_KIND_ALIASES, type PersonaKind,
} from "../../shared/types.ts";

/** The aliases already warned about this run. */
const warned = new Set<string>();

/** Log the deprecation of `alias` (once per run). */
function warnOnce(alias: string, replacement: string): void {
  if (warned.has(alias)) return;
  warned.add(alias);
  console.warn(`[personas] '${alias}' is deprecated; use '${replacement}'`);
}

/**
 * A persona kind hint in its canonical spelling, or null when it names no kind.
 * A legacy spelling (`worker`) maps to its replacement, with a one-time warning.
 */
export function normalizePersonaKind(kind: unknown): PersonaKind | null {
  const canonical = canonicalPersonaKind(kind);
  if (canonical && typeof kind === "string" && Object.hasOwn(LEGACY_PERSONA_KIND_ALIASES, kind)) warnOnce(kind, canonical);
  return canonical;
}

/**
 * A persona id in its canonical spelling. A legacy built-in id
 * (`builtin:worker`) maps to its replacement, with a one-time warning; any
 * other id is returned unchanged.
 */
export function normalizePersonaId(id: string): string {
  const canonical = canonicalPersonaId(id);
  if (Object.hasOwn(LEGACY_PERSONA_ID_ALIASES, id)) warnOnce(id, canonical);
  return canonical;
}

/** Forget which aliases were warned about (tests only: each asserts its own one-time warning). */
export function resetPersonaAliasWarnings(): void {
  warned.clear();
}

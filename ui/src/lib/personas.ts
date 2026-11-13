/**
 * lib/personas.ts — The persona library as the UI sees it: wire types, routes,
 * and the pure rules behind Config → Personas, every persona picker, "Used by",
 * and the in-flight persona chip (docs/DESIGN.md "Personas: One Library,
 * Selected by Reference").
 *
 * - **Routes**: the list is `/config/personas`, one persona `/config/personas/:id`
 *   with the id `encodeURIComponent`ed (package ids contain `/`).
 * - **Origins**: a persona is the team's (editable), built-in (`builtin:*`), or a
 *   package's (`<package>/<id>`); the last two are read-only — "Duplicate to edit".
 * - **Pickers** list the personas hinted for their kind first (`kinds`), the rest
 *   after — a hint, never a restriction.
 * - **The chip** shows the persona a run recorded at claim (a snapshot): linked
 *   to its page, or marked "deleted" and unlinked when the id no longer resolves.
 *
 * Wire types are shared/types.ts's (`Persona`, `PersonaRef`, `PersonaUsage`) and
 * shared/protocol.ts's. Kept pure (no React) so the rules are
 * unit-tested (tests/personas-ui.test.ts).
 */

import type { Persona, PersonaKind, PersonaOrigin, PersonaRef, PersonaUsage, PersonaVia } from "@shared/types";
import type { DeletePersonaResponse, PersonaSettings, SavePersonaResponse, SourceView, UpdatePersonaRequest } from "@shared/protocol";
// Runtime values, so a relative path: the tests run this module under Node, which
// can't resolve the `@shared` alias (shared/types.ts has no node: imports).
import { canonicalPersonaId, PERSONA_KINDS, slugifyPersonaId } from "../../../shared/types.ts";

export type { DeletePersonaResponse, Persona, PersonaKind, PersonaOrigin, PersonaRef, PersonaUsage, PersonaVia, SavePersonaResponse };

/** Every kind hint, in display order. */
export { PERSONA_KINDS };

/**
 * DEPRECATED(worker→teammate): remove in remove-worker-aliases.
 * A stored persona id in its current spelling: a reference still naming a
 * renamed built-in (`builtin:worker`) shows as its replacement (`builtin:teammate`)
 * instead of "missing" or "deleted". The UI's one alias seam — the pickers and the
 * chip compare ids through it. The map is shared/types.ts `LEGACY_PERSONA_ID_ALIASES`.
 */
export function currentPersonaId(id: string): string {
  return canonicalPersonaId(id);
}

// ─── Routes ─────────────────────────────────────────────────────────

/** Config → Personas, the library list. */
export const PERSONAS_TAB_PATH = "/config/personas";

/** One persona's page (editor for a team persona, read-only view otherwise). */
export function personaPath(id: string): string {
  return `${PERSONAS_TAB_PATH}/${encodeURIComponent(id)}`;
}

/**
 * The persona id a Config route names (`/config/personas/:id`), or null on the
 * list. The id is normally one encoded segment; an unencoded package id
 * (`/config/personas/pkg/reviewer`, typed by hand) is the rest of the path.
 */
export function personaIdFromConfigPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "config" || segments[1] !== "personas" || segments.length < 3) return null;
  const rest = segments.slice(2).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return rest.join("/") || null;
}

// ─── Origins ────────────────────────────────────────────────────────

/** The origin badge's text: "team", "built-in", or the package's name. */
export function originLabel(origin: PersonaOrigin): string {
  if (origin.kind === "package") return origin.name;
  return origin.kind === "builtin" ? "built-in" : "team";
}

/** The same badge text for a recorded snapshot's flattened origin (`package:<name>`). */
export function refOriginLabel(origin: string): string {
  if (origin.startsWith("package:")) return origin.slice("package:".length);
  return origin === "builtin" ? "built-in" : origin;
}

/** Why a persona can't be edited here, or null when it can (team personas). */
export function readOnlyReason(persona: Pick<Persona, "readOnly" | "origin">): string | null {
  if (!persona.readOnly) return null;
  return persona.origin.kind === "package"
    ? `From the ${persona.origin.name} package — read-only. Duplicate it to make an editable copy in your team's library.`
    : "Built into MPT — read-only. Duplicate it to make an editable copy in your team's library.";
}

// ─── The library list ───────────────────────────────────────────────

/** Comma-separated tags as typed → a clean list (trimmed, empties and repeats dropped). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(",").map((s) => s.trim())) if (t && !out.includes(t)) out.push(t);
  return out;
}

// ─── Settings (tools, skills, model, requires) ──────────────────────
// docs/DESIGN.md "Persona settings": optional, harness-neutral frontmatter the
// daemon delivers with the persona; how much is enforced depends on the harness.

/** One row of the detail view's settings list: a label and its values (empty list = "none"). */
export interface PersonaSettingsRow {
  label: string;
  values: string[];
}

/** The settings a persona has, as display rows (only the fields it sets), in a fixed order. */
export function personaSettingsRows(p: PersonaSettings): PersonaSettingsRow[] {
  const rows: PersonaSettingsRow[] = [];
  if (p.tools?.allow) rows.push({ label: "Tools allowed", values: p.tools.allow });
  if (p.tools?.deny) rows.push({ label: "Tools denied", values: p.tools.deny });
  if (p.skills) rows.push({ label: "Skills", values: p.skills });
  if (p.model) rows.push({ label: "Model", values: [p.model] });
  if (p.requires?.mcp) rows.push({ label: "Requires MCP", values: p.requires.mcp });
  return rows;
}

/** The editor's settings fields as typed: comma-separated lists, and the model alias. */
export interface PersonaSettingsDraft {
  allow: string;
  deny: string;
  skills: string;
  model: string;
  mcp: string;
}

/** The editor's starting text for a persona's settings (blank for a new one). */
export function settingsDraftOf(p: PersonaSettings | null): PersonaSettingsDraft {
  return {
    allow: p?.tools?.allow?.join(", ") ?? "",
    deny: p?.tools?.deny?.join(", ") ?? "",
    skills: p?.skills?.join(", ") ?? "",
    model: p?.model ?? "",
    mcp: p?.requires?.mcp?.join(", ") ?? "",
  };
}

/** The settings part of a save request. */
export type PersonaSettingsRequest = Pick<UpdatePersonaRequest, "tools" | "skills" | "model" | "requires">;

/**
 * The settings fields to send for `draft`: only those that changed from
 * `original` (the persona being edited; null creates one), so an untouched
 * field — even one the editor can't show exactly, like an explicit empty
 * `allow` — is kept as written. A blank field means "not set": null on update,
 * left out on create.
 */
export function settingsRequestOf(draft: PersonaSettingsDraft, original: PersonaSettings | null): PersonaSettingsRequest {
  const before = settingsDraftOf(original);
  const changed = (k: keyof PersonaSettingsDraft) => draft[k].trim() !== before[k].trim();
  const out: PersonaSettingsRequest = {};
  const set = <K extends keyof PersonaSettingsRequest>(key: K, value: PersonaSettingsRequest[K]) => {
    if (value !== null || original) out[key] = value;
  };
  if (changed("allow") || changed("deny")) {
    const allow = parseTags(draft.allow);
    const deny = parseTags(draft.deny);
    // A field left as it was keeps its exact value (an explicit empty list stays one).
    const tools = {
      ...(changed("allow") ? (allow.length ? { allow } : {}) : original?.tools?.allow ? { allow: original.tools.allow } : {}),
      ...(changed("deny") ? (deny.length ? { deny } : {}) : original?.tools?.deny ? { deny: original.tools.deny } : {}),
    };
    set("tools", tools.allow || tools.deny ? tools : null);
  }
  if (changed("skills")) {
    const skills = parseTags(draft.skills);
    set("skills", skills.length ? skills : null);
  }
  if (changed("model")) set("model", draft.model.trim() || null);
  if (changed("mcp")) {
    const mcp = parseTags(draft.mcp);
    set("requires", mcp.length ? { mcp } : null);
  }
  return out;
}

/** Has the editor's settings draft changed from the persona's? (The unsaved-changes guard.) */
export function settingsDraftDirty(draft: PersonaSettingsDraft, original: PersonaSettings | null): boolean {
  const before = settingsDraftOf(original);
  return (Object.keys(before) as Array<keyof PersonaSettingsDraft>).some((k) => draft[k].trim() !== before[k].trim());
}

/** Every tag in the library with its count, alphabetical — the filter chips. */
export function personaTagCounts(personas: Pick<Persona, "tags">[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const p of personas) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * The list's filter: a tag chip plus free text over id, title, description,
 * tags, origin and body. Order is kept (team first, as the daemon lists them).
 */
export function filterPersonas<P extends Persona>(personas: P[], query: string, tag: string | null): P[] {
  const q = query.trim().toLowerCase();
  return personas.filter((p) => {
    if (tag && !p.tags.includes(tag)) return false;
    if (!q) return true;
    return [p.id, p.title, p.description, p.content, originLabel(p.origin), ...p.tags]
      .some((s) => s.toLowerCase().includes(q));
  });
}

// ─── Pickers ────────────────────────────────────────────────────────

/**
 * A picker's options: personas hinted for `kind` first, then the rest, each
 * group in library order. `exclude` drops ids the picker shows another way
 * (the Assistant's "Default" is `builtin:assistant`).
 */
export function pickerGroups<P extends Pick<Persona, "id" | "kinds">>(
  personas: P[], kind: PersonaKind | undefined, exclude: string[] = [],
): { hinted: P[]; rest: P[] } {
  const usable = personas.filter((p) => !exclude.includes(p.id));
  if (!kind) return { hinted: [], rest: usable };
  return {
    hinted: usable.filter((p) => p.kinds?.includes(kind)),
    rest: usable.filter((p) => !p.kinds?.includes(kind)),
  };
}

/**
 * A picker option's text: the title, with the origin when it isn't the team's
 * (unless the title already says it — the built-ins' titles end "(built-in)").
 */
export function optionLabel(p: Pick<Persona, "title" | "origin">): string {
  if (p.origin.kind === "team") return p.title;
  const origin = originLabel(p.origin);
  return p.title.toLowerCase().includes(origin.toLowerCase()) ? p.title : `${p.title} (${origin})`;
}

/**
 * A selected id the library doesn't have (deleted, or its package is gone): the
 * picker still shows it, flagged, so saving the form doesn't silently clear it.
 */
export function missingSelection(value: string | null | undefined, personas: Pick<Persona, "id">[] | null): string | null {
  if (!value || !personas) return null;
  const id = currentPersonaId(value);
  return personas.some((p) => p.id === id) ? null : value;
}

// ─── "Used by" ──────────────────────────────────────────────────────

/** One "Used by" row: what references the persona, and where to go to re-point it. */
export function usageLabel(u: PersonaUsage): string {
  switch (u.kind) {
    case "workflow-state": return `Workflow ${u.workflow} — state ${u.state}`;
    case "triage": return "Note triage";
    case "assistant": return "The assistant";
    case "workdef": return `Task “${u.title}”`;
    case "mirror-override": return `Item ${u.workDefId} from ${u.source} (override)`;
    case "source-setting": return `Source ${u.source} — ${u.field === "triagePersona" ? "triage persona" : "work persona"}`;
  }
}

/** Where a "Used by" row links — the place its reference is edited. */
export function usageHref(u: PersonaUsage): string {
  switch (u.kind) {
    case "workflow-state": return `/config/workflows/${encodeURIComponent(u.workflow)}`;
    case "triage": return "/config/triage";
    case "assistant": return "/config";
    case "workdef":
    case "mirror-override": return `/work-defs/${encodeURIComponent(u.workDefId)}`;
    case "source-setting": return `/config/sources/${encodeURIComponent(u.source)}`;
  }
}

/** Why Delete is off for a persona, or null when it may be deleted. */
export function deleteBlockedReason(persona: Pick<Persona, "readOnly">, usedBy: PersonaUsage[] | null | undefined): string | null {
  if (persona.readOnly) return "Built-in and package personas can't be deleted.";
  const n = usedBy?.length ?? 0;
  if (n > 0) return `In use by ${n} ${n === 1 ? "thing" : "things"} — re-point ${n === 1 ? "it" : "them"} first (see Used by).`;
  return null;
}

// ─── The in-flight chip ─────────────────────────────────────────────

/** How the run chose its persona, in words (the chip's tooltip). */
export function viaLabel(via: PersonaVia): string {
  switch (via) {
    case "workflow-state": return "from the workflow state";
    case "task": return "set on the task";
    case "schedule": return "set on the schedule";
    case "workdef": return "set on the item";
    case "source-setting": return "the team's choice for its source";
    case "source-default": return "its source's default";
    case "triage": return "triage";
    case "assistant": return "the assistant";
  }
}

/** What a persona chip shows: text, tooltip, and a link unless the persona is gone. */
export interface PersonaChipView {
  label: string;
  title: string;
  /** The persona's page; null when it no longer resolves (deleted, package removed). */
  href: string | null;
  deleted: boolean;
}

/**
 * The chip for a recorded persona. `library` is the current library (null while
 * it loads — assumed present, so a chip doesn't flash "deleted"). The recorded
 * title is always what's shown: the snapshot is history, not today's name.
 */
export function personaChip(ref: PersonaRef, library: Pick<Persona, "id">[] | null): PersonaChipView {
  const id = currentPersonaId(ref.id);
  const deleted = library !== null && !library.some((p) => p.id === id);
  const parts = [`Persona: ${ref.title} (${refOriginLabel(ref.origin)}) — ${viaLabel(ref.via)}`];
  if (ref.fallbackFrom) parts.push(`stands in for missing “${ref.fallbackFrom}”`);
  if (deleted) parts.push("this persona has since been deleted");
  return {
    label: deleted ? `${ref.title} (deleted)` : ref.title,
    title: parts.join(" · "),
    href: deleted ? null : personaPath(id),
    deleted,
  };
}

// ─── Work Sources ───────────────────────────────────────────────────

/** The persona fields of `GET /api/sources`. */
export type SourcePersonaFields = Pick<SourceView, "mode" | "persona" | "defaultPersona" | "triagePersona" | "defaultTriagePersona" | "personaError">;

/**
 * What a source's items run with when no item overrides it — the team's
 * setting, else the source's declared default — for work and triage mode.
 * `null` = none (work: no persona block; triage: the source can't sync).
 */
export function effectiveSourcePersonas(s: SourcePersonaFields): {
  work: { id: string; from: "setting" | "declared" } | null;
  triage: { id: string; from: "setting" | "declared" } | null;
} {
  const pick = (setting: string | null, declared: string | null) =>
    setting ? { id: setting, from: "setting" as const } : declared ? { id: declared, from: "declared" as const } : null;
  return { work: pick(s.persona, s.defaultPersona), triage: pick(s.triagePersona, s.defaultTriagePersona) };
}

/**
 * The id a new team persona would get from its title (shared/types.ts
 * `slugifyPersonaId`; the daemon adds `-2`… on a collision). A placeholder only.
 */
export function slugHint(title: string): string {
  return slugifyPersonaId(title);
}

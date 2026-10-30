/**
 * daemon/sources/persona.ts — Which persona a Work Source's mirrored items run
 * with: the per-item → per-source → source-declared chain, and the triage-mode
 * requirement. See docs/DESIGN.md "Work Source personas: default + per-WorkDef
 * override".
 *
 *   work-mode mirror:   kv persona:<defId> → ExternalDef.persona (mirror frontmatter)
 *                       → sourcePersonas.<id>.persona → WorkSource.defaultPersona → none
 *   triage-mode mirror: kv persona:<defId> → ExternalDef.persona
 *                       → sourcePersonas.<id>.triagePersona → WorkSource.triagePersona → (required)
 *
 * A chain is "the first non-empty id", so it lives here as pure functions over
 * its inputs (the Store supplies them) and `resolvePersona` turns the id into a
 * body (daemon/personas/resolve.ts). Nothing here reads the disk.
 */

import type { PersonaVia, SourcePersonaSetting } from "../../shared/types.ts";
import type { WorkSource, WorkSourceMode } from "./types.ts";

/**
 * kv key (the source's `sources/<id>.json`): a person's persona override for
 * one mirror. Kept in the kv, not the mirror's `workdef.md`, because only sync
 * writes a mirror's file — so the override survives every re-sync.
 */
export function mirrorPersonaKey(defId: string): string {
  return `persona:${defId}`;
}

/** A persona reference a chain picked, and how (`PersonaVia`, recorded on the WorkItem). */
export interface PersonaPick {
  ref: string;
  via: PersonaVia;
}

/** What a mirror's chain reads. */
export interface MirrorPersonaInput {
  /** The item's effective mode (its recorded `mode:<defId>`). */
  mode: WorkSourceMode;
  /** A person's override (kv `persona:<defId>`). */
  override?: string;
  /** The source's suggestion for this item (`ExternalDef.persona`, in the mirror's frontmatter). */
  suggestion?: string;
  /** The team's per-source setting (`config.json` `sourcePersonas.<id>`). */
  setting?: SourcePersonaSetting;
  /** The source's declaration (absent when the source isn't registered any more). */
  source?: Pick<WorkSource, "defaultPersona" | "triagePersona">;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The source-level persona for one mode: the per-source setting, else the
 * source's declaration; null when neither names one.
 */
export function sourcePersonaPick(
  mode: WorkSourceMode, setting: SourcePersonaSetting | undefined, source: Pick<WorkSource, "defaultPersona" | "triagePersona"> | undefined,
): PersonaPick | null {
  const own = mode === "triage" ? setting?.triagePersona : setting?.persona;
  if (nonEmpty(own)) return { ref: own, via: "source-setting" };
  const declared = mode === "triage" ? source?.triagePersona : source?.defaultPersona;
  if (nonEmpty(declared)) return { ref: declared, via: "source-default" };
  return null;
}

/** A mirror's persona reference, walking its chain; null = none named. */
export function mirrorPersonaPick(input: MirrorPersonaInput): PersonaPick | null {
  if (nonEmpty(input.override)) return { ref: input.override, via: "workdef" };
  if (nonEmpty(input.suggestion)) return { ref: input.suggestion, via: "workdef" };
  return sourcePersonaPick(input.mode, input.setting, input.source);
}

/** Where a person fixes a missing triage persona, appended to every message below. */
const TRIAGE_FIX = "set one on Config → Sources, or declare triagePersona";

/**
 * Why a triage-mode source can't sync, or null when it can: its source-level
 * triage persona (per-source setting, else declared) is missing, or doesn't
 * resolve. `exists` is the persona library's lookup.
 */
export function triagePersonaProblem(
  sourceId: string, setting: SourcePersonaSetting | undefined, source: Pick<WorkSource, "defaultPersona" | "triagePersona">,
  exists: (id: string) => boolean,
): string | null {
  const pick = sourcePersonaPick("triage", setting, source);
  if (!pick) return `triage-mode source ${sourceId} needs a triage persona — ${TRIAGE_FIX}`;
  if (!exists(pick.ref)) return `triage-mode source ${sourceId}'s triage persona "${pick.ref}" doesn't exist — ${TRIAGE_FIX}`;
  return null;
}

/**
 * The status message of a work-mode source with triage-mode items it can't run
 * (each has no triage persona of its own and the source has none).
 */
export function heldTriageItemsMessage(sourceId: string, count: number): string {
  return `source ${sourceId} has ${count} triage-mode item${count === 1 ? "" : "s"} waiting for a triage persona — ${TRIAGE_FIX}`;
}

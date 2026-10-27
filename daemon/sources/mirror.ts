/**
 * daemon/sources/mirror.ts — Mirrored WorkDefs: the read-only local copy of an
 * item an external (pull-only) Work Source supplies.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 * A mirror is an ordinary WorkDef on disk (`tasks/<id>/workdef.md`, with its own
 * `comments.jsonl` and `attachments/`), so the prompt, the thread, and the UI
 * work offline and need no special casing. What marks it is its parent:
 * `{ kind: "external", id: <externalId>, source: <sourceId> }`, plus a `url`
 * back to the external item.
 *
 * **Who writes it.** Only the source's sync, through `upsertMirror` — MPT never
 * authors a mirror (the WorkDef edit/delete/create routes refuse). That is the
 * one exception to "`workdef.md` is authored content only": the content *is*
 * authored, just elsewhere. The runtime state about a mirror lives in the
 * source's kv (`sources/<sourceId>.json`), never in the file:
 *   - `mirror:<defId>`   — the revision currently mirrored (re-sync of it is a no-op);
 *   - `revision:<defId>` — the revision last handed to a WorkItem (revision.ts);
 *   - `vanished:<defId>` — when sync archived it for no longer being reported;
 *   - `disconnected:<defId>` — when a **disconnect** (switching the source off
 *     and archiving its mirrors; daemon/features.ts `disconnectSource`) archived
 *     it. Like `vanished`, it brings the mirror back when the source, switched
 *     on again, reports the item — a person's archive stays put;
 *   - `mode:<defId>`     — `"triage"` while the item is in triage mode (its
 *     `ExternalDef.mode`, else its source's `WorkSource.mode`); absent = "work".
 *     Kept here rather than in `workdef.md` so it survives a restart without a
 *     frontmatter field, and is refreshed on every sync — even an unchanged
 *     revision — so a source switching mode takes effect at once.
 */

import type { WorkDef } from "../../shared/types.ts";
import { getWorkDef, writeWorkDef } from "../store/workdefs.ts";
import type { ExternalDef, SourceKv, WorkSourceMode } from "./types.ts";

/** Separates the source id from the encoded external id; neither half can contain it. */
const ID_SEPARATOR = "~";

/**
 * Encode an external id for a directory name: letters, digits, and `-` pass
 * through; every other byte (UTF-8) becomes `_XX`. Injective — `_` itself is
 * always escaped — and never yields `.`/`..` or a path separator.
 */
function encodeExternalId(externalId: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(externalId)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9-]/.test(ch) ? ch : `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The local WorkDef id of a mirrored item: `<sourceId>~<encoded externalId>`
 * (e.g. `jira~PROJ-123`). Namespaced, so two sources never collide with each
 * other or with an authored WorkDef (authored ids are slugs, without `~`), and
 * file-system safe. Deterministic, so every sync lands on the same def.
 */
export function mirroredWorkDefId(sourceId: string, externalId: string): string {
  return `${sourceId}${ID_SEPARATOR}${encodeExternalId(externalId)}`;
}

/** kv key: the revision currently mirrored for a def. */
export function mirrorRevisionKey(defId: string): string {
  return `mirror:${defId}`;
}

/** kv key: set while sync has archived a def for vanishing from the source. */
export function vanishedKey(defId: string): string {
  return `vanished:${defId}`;
}

/** kv key: set while a disconnect (the source switched off) has archived a def. */
export function disconnectedKey(defId: string): string {
  return `disconnected:${defId}`;
}

/** kv key: the item's effective mode, while it is "triage" (absent = "work"). */
export function mirrorModeKey(defId: string): string {
  return `mode:${defId}`;
}

/** An item's effective mode: its own, else its source's, else "work". */
export function effectiveMode(ext: Pick<ExternalDef, "mode">, sourceMode?: WorkSourceMode): WorkSourceMode {
  const own = ext.mode === "triage" || ext.mode === "work" ? ext.mode : undefined;
  return own ?? (sourceMode === "triage" ? "triage" : "work");
}

/** A mirror's recorded mode (what the last sync said), from its source's kv. */
export function mirrorMode(kv: Pick<SourceKv, "get">, defId: string): WorkSourceMode {
  return kv.get(mirrorModeKey(defId)) === "triage" ? "triage" : "work";
}

/** Why an `ExternalDef` from a source can't be mirrored, or null when it can. */
export function invalidExternalDef(def: unknown): string | null {
  if (!def || typeof def !== "object") return "not an object";
  const d = def as Record<string, unknown>;
  for (const key of ["externalId", "revision", "title"] as const) {
    if (typeof d[key] !== "string" || (d[key] as string).trim() === "") return `missing '${key}'`;
  }
  if (d.goal !== undefined && typeof d.goal !== "string") return "'goal' is not a string";
  if (d.mode !== undefined && d.mode !== "work" && d.mode !== "triage") return "'mode' must be \"work\" or \"triage\"";
  return null;
}

/** The result of `upsertMirror`. */
export interface MirrorResult {
  def: WorkDef;
  /** The file was (re)written: new, a moved revision, or brought back from vanished. */
  changed: boolean;
}

/**
 * Write (or refresh) the mirror of one external item. A revision equal to the
 * one already mirrored is a no-op (no write, so the team dir stays clean). A
 * mirror sync had archived for vanishing (or a disconnect archived) comes back
 * active when the item is reported again; one a *person* archived stays archived. Returns null when the
 * def is invalid, or its id is taken by a WorkDef that isn't this source's mirror.
 *
 * The item's effective mode (`effectiveMode(ext, sourceMode)`) is recorded every
 * time, unchanged revision or not (see the file header).
 */
export function upsertMirror(
  teamDir: string, sourceId: string, kv: SourceKv, ext: ExternalDef, sourceMode?: WorkSourceMode,
): MirrorResult | null {
  if (invalidExternalDef(ext)) return null;
  const id = mirroredWorkDefId(sourceId, ext.externalId);
  const existing = getWorkDef(teamDir, id);
  if (existing && (existing.parent?.kind !== "external" || existing.parent.source !== sourceId)) return null;

  const mode = effectiveMode(ext, sourceMode);
  if (mode !== mirrorMode(kv, id)) {
    if (mode === "triage") kv.set(mirrorModeKey(id), "triage");
    else kv.delete(mirrorModeKey(id));
  }

  // Archived by sync (vanished) or by a disconnect: either way not a person's call, so it comes back.
  const vanished = kv.get(vanishedKey(id)) !== undefined || kv.get(disconnectedKey(id)) !== undefined;
  const restore = existing?.status === "archived" && vanished;
  if (existing && !restore && kv.get(mirrorRevisionKey(id)) === ext.revision) return { def: existing, changed: false };

  const def: WorkDef = {
    id,
    title: ext.title.trim(),
    parent: { kind: "external", id: ext.externalId, source: sourceId },
    goal: (ext.goal ?? "").trim(),
    acceptanceCriteria: (ext.acceptanceCriteria ?? "").trim(),
    // Archived only when a person archived it; a vanished one is coming back.
    status: existing?.status === "archived" && !restore ? "archived" : "active",
  };
  if (ext.additionalContext?.trim()) def.additionalContext = ext.additionalContext.trim();
  if (ext.directory?.trim()) def.directory = ext.directory.trim();
  if (ext.url?.trim()) def.url = ext.url.trim();
  writeWorkDef(teamDir, def);
  kv.set(mirrorRevisionKey(id), ext.revision);
  if (vanished) {
    kv.delete(vanishedKey(id));
    kv.delete(disconnectedKey(id));
  }
  return { def, changed: true };
}

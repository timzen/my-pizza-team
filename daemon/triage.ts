/**
 * daemon/triage.ts — The auto-triage rules: which notes are due for analysis,
 * and what their WorkDef and WorkItem are called. See TODO.md "Auto Triage".
 *
 * Pure functions with no Store or IO, like cron.ts beside the scheduler, so the
 * turn rule — the fiddly part — is unit-testable (tests/triage.test.ts).
 *
 * The turn rule in one line: **you edit the note, the teammate comments.** A note
 * is due when its text has moved on since the version last handed to triage.
 */

import type { Thought } from "../shared/types.ts";

/** Id prefix for a note's triage WorkDef: one per note, derived from its id. */
export const TRIAGE_WORKDEF_PREFIX = "triage-";

/** The triage WorkDef id for a note (stable, so it's found rather than duplicated). */
export function triageWorkDefId(thoughtId: string): string {
  return `${TRIAGE_WORKDEF_PREFIX}${thoughtId}`;
}

/** The note a triage WorkDef id belongs to, or null if it isn't one. */
export function thoughtIdFromTriageWorkDef(workDefId: string): string | null {
  return workDefId.startsWith(TRIAGE_WORKDEF_PREFIX) ? workDefId.slice(TRIAGE_WORKDEF_PREFIX.length) : null;
}

/** Title of a note's triage WorkDef — generic: the note's text lives in the note. */
export function triageWorkDefTitle(thoughtId: string): string {
  return `Triage note ${thoughtId}`;
}

/** First non-empty line of a note, stripped of markdown heading/bullet marks. */
export function noteFirstLine(content: string, max = 60): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The WorkItem's title, resolved at enqueue so the queue and Inbox read as the
 * note rather than as "Triage note th-1790…".
 */
export function triageWorkItemTitle(note: Pick<Thought, "id" | "content">): string {
  const first = noteFirstLine(note.content);
  return first ? `Triage: ${first}` : `Triage note ${note.id}`;
}

/** Why a note isn't due for triage, or null when it is. */
export type TriageSkipReason =
  | "archived"
  | "empty"
  | "in-flight"
  | "unchanged"
  | "too-fresh";

export interface TriageDueInput {
  note: Pick<Thought, "status" | "content" | "updatedAt" | "triagedVersion">;
  /** Does this note already have a READY or IN_PROGRESS triage WorkItem? */
  inFlight: boolean;
  /** Now, as epoch ms. */
  now: number;
  /** Leave a note alone for this many minutes after its last edit. */
  quietMinutes: number;
}

/**
 * Is this note due for a triage run? `null` means yes; otherwise the reason not.
 *
 * - **archived / empty** — never eligible.
 * - **in-flight** — one run at a time per note; the next sweep picks up any edit
 *   made meanwhile (which is why the version is stamped at enqueue).
 * - **unchanged** — its text hasn't moved since the version last handed over.
 *   A *failed* run therefore doesn't retry every sweep: the stamp happened when
 *   it was enqueued (TODO.md "Auto Triage" Decision 3). **Triage now** overrides.
 * - **too-fresh** — edited within the quiet period, so the sweep doesn't read a
 *   half-written thought. It goes in the next sweep.
 */
export function triageSkipReason(input: TriageDueInput): TriageSkipReason | null {
  const { note, inFlight, now, quietMinutes } = input;
  if (note.status !== "active") return "archived";
  if (note.content.trim() === "") return "empty";
  if (inFlight) return "in-flight";
  if (note.triagedVersion && note.triagedVersion >= (note.updatedAt || "")) return "unchanged";
  const editedAt = Date.parse(note.updatedAt || "");
  if (Number.isFinite(editedAt) && now - editedAt < quietMinutes * 60 * 1000) return "too-fresh";
  return null;
}

/** Sugar for the sweep. */
export function isTriageDue(input: TriageDueInput): boolean {
  return triageSkipReason(input) === null;
}

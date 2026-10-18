/**
 * daemon/store/schedules.ts — On-disk IO for Schedules (cron enqueuers).
 * See docs/DESIGN.md "WorkDefs & Parents".
 *
 * A Schedule is a flat `schedules/<id>.json` file: `{ id, title?, cron,
 * lastEnqueuedAt?, heldForReadiness?, pending?, resumedAt? }`. It owns no
 * content — it's a *parent* that fires a WorkItem for each WorkDef whose
 * `parent` points at it (`{ kind: "schedule", id }`). Its runtime bits
 * (`lastEnqueuedAt`, `heldForReadiness`, `resumedAt`) are kept here, not on the
 * authored WorkDef markdown.
 *
 * `pending` is reversible (docs/DESIGN.md "Pending schedules: reversible, no
 * catch-up"); `updateSchedule` owns the transition side effects so every caller
 * (PUT, /pending, /activate) gets them.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { slugify, type Schedule, SCHEDULES_DIR } from "../../shared/types.ts";

function dir(teamDir: string): string {
  return path.join(teamDir, SCHEDULES_DIR);
}

function file(teamDir: string, id: string): string {
  return path.join(dir(teamDir), `${id}.json`);
}

export function listSchedules(teamDir: string): Schedule[] {
  const d = dir(teamDir);
  if (!existsSync(d)) return [];
  const out: Schedule[] = [];
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(d, entry.name), "utf8")) as Schedule);
    } catch {
      // Skip malformed schedule files.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getSchedule(teamDir: string, id: string): Schedule | null {
  const f = file(teamDir, id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Schedule;
  } catch {
    return null;
  }
}

export function writeSchedule(teamDir: string, sched: Schedule): void {
  fs.mkdirSync(dir(teamDir), { recursive: true });
  fs.writeFileSync(file(teamDir, sched.id), JSON.stringify(sched, null, 2) + "\n");
}

/** Create a Schedule; id derived from title (deduped) unless supplied. */
export function saveSchedule(teamDir: string, input: { id?: string; title?: string; cron: string; pending?: boolean }): Schedule {
  let id = input.id;
  if (!id) {
    const base = slugify(input.title || "") || "schedule";
    id = base;
    let n = 2;
    while (existsSync(file(teamDir, id))) { id = `${base}-${n}`; n++; }
  }
  const sched: Schedule = { id, cron: input.cron };
  if (input.title) sched.title = input.title;
  if (input.pending) sched.pending = true;
  writeSchedule(teamDir, sched);
  return sched;
}

/**
 * Patch a Schedule file. A `pending` change carries side effects that keep a
 * reactivated schedule from bursting (docs/DESIGN.md "Pending schedules:
 * reversible, no catch-up"):
 *   - active → pending clears `heldForReadiness`, so a held occurrence isn't
 *     fired later as a catch-up run;
 *   - pending → active stamps `resumedAt`, which the scheduler uses as a cursor
 *     so only cron minutes after the activation can fire.
 * Setting `pending` to its current value is a no-op (no new `resumedAt`).
 */
export function updateSchedule(teamDir: string, id: string, updates: { title?: string | null; cron?: string; lastEnqueuedAt?: string; heldForReadiness?: boolean; pending?: boolean }, now: Date = new Date()): Schedule | null {
  const sched = getSchedule(teamDir, id);
  if (!sched) return null;
  if (updates.title !== undefined) { if (updates.title) sched.title = updates.title; else delete sched.title; }
  if (updates.cron !== undefined) sched.cron = updates.cron;
  if (updates.lastEnqueuedAt !== undefined) sched.lastEnqueuedAt = updates.lastEnqueuedAt;
  // Persist the readiness-hold marker; drop it from disk when cleared to keep files tidy.
  if (updates.heldForReadiness !== undefined) {
    if (updates.heldForReadiness) sched.heldForReadiness = true;
    else delete sched.heldForReadiness;
  }
  if (updates.pending !== undefined && updates.pending !== (sched.pending === true)) {
    if (updates.pending) {
      sched.pending = true;
      delete sched.heldForReadiness;
    } else {
      delete sched.pending;
      sched.resumedAt = now.toISOString();
    }
  }
  writeSchedule(teamDir, sched);
  return sched;
}

export function deleteSchedule(teamDir: string, id: string): boolean {
  const f = file(teamDir, id);
  if (!existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

/**
 * The scheduler's cron cursor: the later of `lastEnqueuedAt` (last genuine
 * firing) and `resumedAt` (last reactivation). `isCronDue` only fires a minute
 * strictly after the cursor's, which is what keeps a reactivated Schedule from
 * firing its activation minute or anything it skipped while pending.
 */
export function scheduleCursor(sched: Schedule): string | undefined {
  const a = sched.lastEnqueuedAt, b = sched.resumedAt;
  if (!a) return b;
  if (!b) return a;
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (isNaN(tb)) return a;
  if (isNaN(ta)) return b;
  return tb > ta ? b : a;
}

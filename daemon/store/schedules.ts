/**
 * daemon/store/schedules.ts — On-disk IO for Schedules (cron enqueuers).
 * See docs/WORKDEF_UNIFICATION.md.
 *
 * A Schedule is a flat `schedules/<id>.json` file: `{ id, title?, cron,
 * lastEnqueuedAt? }`. It owns no content — it's a *parent* that fires a
 * WorkItem for each WorkDef whose `parent` points at it (`{ kind: "schedule",
 * id }`). `lastEnqueuedAt` is the only mutable runtime bit, kept here (not on
 * the authored WorkDef markdown).
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
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
  for (const entry of Deno.readDirSync(d)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(Deno.readTextFileSync(path.join(d, entry.name))) as Schedule);
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
    return JSON.parse(Deno.readTextFileSync(f)) as Schedule;
  } catch {
    return null;
  }
}

export function writeSchedule(teamDir: string, sched: Schedule): void {
  Deno.mkdirSync(dir(teamDir), { recursive: true });
  Deno.writeTextFileSync(file(teamDir, sched.id), JSON.stringify(sched, null, 2) + "\n");
}

/** Create a Schedule; id derived from title (deduped) unless supplied. */
export function saveSchedule(teamDir: string, input: { id?: string; title?: string; cron: string }): Schedule {
  let id = input.id;
  if (!id) {
    const base = slugify(input.title || "") || "schedule";
    id = base;
    let n = 2;
    while (existsSync(file(teamDir, id))) { id = `${base}-${n}`; n++; }
  }
  const sched: Schedule = { id, cron: input.cron };
  if (input.title) sched.title = input.title;
  writeSchedule(teamDir, sched);
  return sched;
}

export function updateSchedule(teamDir: string, id: string, updates: { title?: string | null; cron?: string; lastEnqueuedAt?: string; heldForReadiness?: boolean }): Schedule | null {
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
  writeSchedule(teamDir, sched);
  return sched;
}

export function deleteSchedule(teamDir: string, id: string): boolean {
  const f = file(teamDir, id);
  if (!existsSync(f)) return false;
  Deno.removeSync(f);
  return true;
}

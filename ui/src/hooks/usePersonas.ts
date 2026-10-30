/**
 * usePersonas — The persona library (`GET /api/personas`), shared by every
 * picker and chip on screen.
 *
 * One fetch serves them all: a Team tab of six teammates, each with a chip,
 * must not mean six requests. The list is cached at module level, refreshed
 * when it's older than `STALE_MS` and something mounts, and after any edit
 * (`notifyPersonasChanged`, called by the Personas tab's saves), so a persona
 * just created shows up in the pickers without a reload.
 */

import { useEffect, useSyncExternalStore } from "react";
import type { Persona } from "@/lib/personas";
import { shareStructure } from "@/lib/structural";

/** How long a fetched library is fresh enough to reuse. */
const STALE_MS = 30_000;

let personas: Persona[] | null = null;
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function load(force = false): Promise<void> {
  if (inFlight) return force ? inFlight.then(() => load(true)) : inFlight;
  if (!force && personas && Date.now() - fetchedAt < STALE_MS) return Promise.resolve();
  inFlight = fetch("/api/personas")
    .then((r) => (r.ok ? r.json() as Promise<{ personas: Persona[] }> : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body) => {
      fetchedAt = Date.now();
      // An unchanged library keeps its reference, so no picker re-renders
      // (docs/DESIGN.md "Polling Never Disturbs the Reader").
      const next = shareStructure(personas, body.personas);
      if (next === personas) return;
      personas = next;
      emit();
    })
    .catch(() => { /* keep the last list; a chip falls back to "linked" while null */ })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The library (team, built-in, package), or null until the first load. */
export function usePersonas(): Persona[] | null {
  const list = useSyncExternalStore(subscribe, () => personas);
  useEffect(() => { void load(); }, []);
  return list;
}

/** Refetch the library now — after a create, edit, duplicate, or delete. */
export function notifyPersonasChanged(): Promise<void> {
  return load(true);
}

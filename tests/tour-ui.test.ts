/**
 * tests/tour-ui.test.ts — The guided tour's rules (ui/src/lib/tour.ts): one step
 * per stop, each a short title and two sentences; steps whose area isn't on
 * screen (a feature toggle, a narrow window) are skipped in order, and the
 * phone gets none; the "Step n of N" label and its announcement; completion
 * remembered in (and tolerant of) storage; and the highlighted element's
 * `aria-describedby` gaining and losing the step's text without losing its own.
 * Also that every stop is marked somewhere in the desktop shell's source.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  TOUR_DONE_KEY, TOUR_STEPS, TOUR_STEP_IDS, addDescribedBy, markTourDone, readTourDone, removeDescribedBy,
  tourPositionLabel, tourStepAnnouncement, tourTargetSelector, visibleTourSteps, type TourStepId,
} from "../ui/src/lib/tour.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("TOUR_STEPS: one per stop, in order, a short title and two sentences each", () => {
  assertEquals(TOUR_STEPS.map((s) => s.id), [...TOUR_STEP_IDS]);
  assertEquals(TOUR_STEPS.length >= 5 && TOUR_STEPS.length <= 7, true);
  const bad: string[] = [];
  for (const { id, title, text } of TOUR_STEPS) {
    if (title.length > 24) bad.push(`${id}: title is ${title.length} characters`);
    if (/[.!?]$/.test(title)) bad.push(`${id}: title ends in punctuation`);
    if (!text.endsWith(".")) bad.push(`${id}: doesn't end with a period`);
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/).length;
    if (sentences !== 2) bad.push(`${id}: ${sentences} sentence(s), expected 2`);
    if (text.length > 200) bad.push(`${id}: ${text.length} characters (keep it under 200)`);
  }
  assertEquals(bad, []);
});

test("visibleTourSteps: keeps the steps whose area is shown, in order", () => {
  const all = visibleTourSteps(TOUR_STEPS, () => true);
  assertEquals(all.map((s) => s.id), [...TOUR_STEP_IDS]);
  // Every work-item kind switched off: no Work link, so no Work stop.
  const noWork = visibleTourSteps(TOUR_STEPS, (id) => id !== "work");
  assertEquals(noWork.map((s) => s.id), ["nav", "dock", "home", "thoughts", "config", "help"]);
  // Off Home (or the tabs not rendered yet): no Queue and Inbox stop.
  const shown = new Set<TourStepId>(["dock", "help"]);
  assertEquals(visibleTourSteps(TOUR_STEPS, (id) => shown.has(id)).map((s) => s.id), ["dock", "help"]);
  assertEquals(visibleTourSteps(TOUR_STEPS, () => false), []);
});

test("visibleTourSteps: the phone view has no tour, whatever is on screen", () => {
  assertEquals(visibleTourSteps(TOUR_STEPS, () => true, { phone: true }), []);
  assertEquals(visibleTourSteps(TOUR_STEPS, () => true, { phone: false }).length, TOUR_STEPS.length);
});

test("tourPositionLabel and tourStepAnnouncement: 1-based, with the step's title", () => {
  assertEquals(tourPositionLabel(0, 7), "Step 1 of 7");
  assertEquals(tourPositionLabel(6, 7), "Step 7 of 7");
  assertEquals(tourStepAnnouncement(TOUR_STEPS[1]!, 1, 6), "Tour, step 2 of 6: The side dock");
});

test("tourTargetSelector: the data-tour attribute", () => {
  assertEquals(tourTargetSelector("dock"), '[data-tour="dock"]');
});

test("readTourDone / markTourDone: remembered per browser, storage errors ignored", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assertEquals(readTourDone(storage), null);
  const when = new Date("2025-01-02T03:04:05.000Z");
  assertEquals(markTourDone(storage, when), "2025-01-02T03:04:05.000Z");
  assertEquals(store.get(TOUR_DONE_KEY), "2025-01-02T03:04:05.000Z");
  assertEquals(readTourDone(storage), "2025-01-02T03:04:05.000Z");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assertEquals(readTourDone(broken), null);
  assertEquals(markTourDone(broken, when), "2025-01-02T03:04:05.000Z");
  assertEquals(readTourDone(undefined), null);
});

test("addDescribedBy / removeDescribedBy: the step's text joins and leaves, the element's own ids stay", () => {
  assertEquals(addDescribedBy(null, "t1"), "t1");
  assertEquals(addDescribedBy("hint", "t1"), "hint t1");
  assertEquals(addDescribedBy("hint t1", "t1"), "hint t1");
  assertEquals(removeDescribedBy("hint t1", "t1"), "hint");
  assertEquals(removeDescribedBy("t1", "t1"), null);
  assertEquals(removeDescribedBy(null, "t1"), null);
  assertEquals(removeDescribedBy("  a   t1 b ", "t1"), "a b");
});

test("every stop is marked with data-tour in the desktop shell", () => {
  const files = ["ui/src/components/NavBar.tsx", "ui/src/components/dock/SideDock.tsx", "ui/src/pages/RootPage.tsx"];
  const source = files.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const missing = TOUR_STEP_IDS.filter((id) => !source.includes(`data-tour="${id}"`) && !source.includes(`tour: "${id}"`));
  assertEquals(missing, []);
});

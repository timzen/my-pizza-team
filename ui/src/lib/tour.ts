/**
 * lib/tour.ts — The optional guided tour's words and rules (docs/DESIGN.md
 * "First run: a checklist, not a tour" — "…and a tour, if you ask").
 *
 * The tour is a handful of coach marks over the desktop shell — the nav, the
 * side dock, Home's Queue and Inbox, Work, Thoughts, Config and Help — each a
 * title and two sentences beside the area it names. It is offered (the
 * Welcome card, the Help panel, /help), never started for you, and the phone
 * view has none: its four labelled tabs are the whole of it ("A Phone Is a
 * Peek").
 *
 * This module holds the copy (`TOUR_STEPS`, so a test can hold each step to a
 * short title and two sentences) and the pure rules the overlay
 * (components/tour/TourProvider) uses: which steps have something on screen to
 * point at (`visibleTourSteps` — a step whose area is hidden by a feature
 * toggle or a narrow window is skipped, not shown pointing at nothing), the
 * "Step 2 of 7" label, the remembered "taken" time (localStorage: it's per
 * browser, like the dock's width), and adding/removing the step's text from the
 * highlighted element's `aria-describedby` without losing what was there.
 * No React or DOM, so it's unit-tested directly (tests/tour-ui.test.ts).
 */

/** The attribute an area of the shell carries to be a tour stop: `data-tour="<step id>"`. */
export const TOUR_ATTR = "data-tour";

/** localStorage key: when the tour was last finished or skipped (an ISO time). */
export const TOUR_DONE_KEY = "mpt.tour.doneAt";

/** Every tour stop, in order. */
export const TOUR_STEP_IDS = ["nav", "dock", "home", "work", "thoughts", "config", "help"] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

/** One coach mark's words. */
export interface TourStep {
  id: TourStepId;
  /** A few words, no period ("The side dock"). */
  title: string;
  /** Two sentences: what the area is, and what you do there. */
  text: string;
}

/** The tour, in order: the shell's areas from the top bar round to Help. */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "nav",
    title: "Getting around",
    text: "The top bar changes what's in the middle of the screen: the pizza is Home, then Work and Thoughts. The lit link always says where you are.",
  },
  {
    id: "dock",
    title: "The side dock",
    text: "The dock stays beside every page, with the assistant's chat, your team, and help. Its + starts new work, and the queue summary beside it counts what's in flight.",
  },
  {
    id: "home",
    title: "Queue and Inbox",
    text: "Home's Queue is work waiting or running, with the teammate that has it. The Inbox is finished work, unread until you open it and review the result.",
  },
  {
    id: "work",
    title: "Work",
    text: "Work holds everything written down: the Board of stories, Tasks, the Schedule of recurring jobs, and Pending. Pending work waits for your review and runs only once you activate it.",
  },
  {
    id: "thoughts",
    title: "Thoughts",
    text: "Thoughts is a board of sticky notes for ideas that aren't work yet. A teammate reads the notes you change and suggests what could become work.",
  },
  {
    id: "config",
    title: "Config",
    text: "Config holds the team's settings: teammates, sources, workflows, personas, and which kinds of work are on. Most teams change little here at first.",
  },
  {
    id: "help",
    title: "Help on every page",
    text: "The ? on every page opens the guide's section for that page, beside it in the dock. Press ? anywhere you aren't typing, and take this tour again from Help.",
  },
];

/** The CSS selector for a step's area: `[data-tour="dock"]`. */
export function tourTargetSelector(id: TourStepId): string {
  return `[${TOUR_ATTR}="${id}"]`;
}

/**
 * The steps to show: none on the phone view, otherwise those whose area is on
 * screen right now (`isShown` — present and laid out: not switched off, not
 * hidden at this width). Order is kept.
 */
export function visibleTourSteps(
  steps: readonly TourStep[],
  isShown: (id: TourStepId) => boolean,
  { phone = false }: { phone?: boolean } = {},
): TourStep[] {
  if (phone) return [];
  return steps.filter((s) => isShown(s.id));
}

/** "Step 2 of 7" (`index` is 0-based). */
export function tourPositionLabel(index: number, total: number): string {
  return `Step ${index + 1} of ${total}`;
}

/** What the live region says when a step comes up: "Tour, step 2 of 7: The side dock". */
export function tourStepAnnouncement(step: TourStep, index: number, total: number): string {
  return `Tour, ${tourPositionLabel(index, total).toLowerCase()}: ${step.title}`;
}

/** The slice of `Storage` the tour reads and writes (so tests pass a plain object). */
export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** When this browser last finished or skipped the tour, or null if it never has (or storage is unavailable). */
export function readTourDone(storage: TourStorage | undefined | null): string | null {
  try {
    const v = storage?.getItem(TOUR_DONE_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Remember that the tour was finished or skipped at `when`; returns the stored value. Storage errors (private mode) are ignored. */
export function markTourDone(storage: TourStorage | undefined | null, when: Date): string {
  const value = when.toISOString();
  try { storage?.setItem(TOUR_DONE_KEY, value); } catch { /* private mode */ }
  return value;
}

/** `aria-describedby` with `id` added (once) after whatever ids it already had. */
export function addDescribedBy(existing: string | null | undefined, id: string): string {
  const ids = (existing ?? "").split(/\s+/).filter(Boolean);
  return ids.includes(id) ? ids.join(" ") : [...ids, id].join(" ");
}

/** `aria-describedby` with `id` taken out; null when nothing is left (remove the attribute). */
export function removeDescribedBy(existing: string | null | undefined, id: string): string | null {
  const ids = (existing ?? "").split(/\s+/).filter((t) => t && t !== id);
  return ids.length ? ids.join(" ") : null;
}

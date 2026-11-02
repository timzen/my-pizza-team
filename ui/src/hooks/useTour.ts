/**
 * useTour — the optional guided tour's shared state (lib/tour.ts;
 * docs/DESIGN.md "First run: a checklist, not a tour"): whether it's running,
 * when this browser last finished or skipped it, and `startTour()`.
 *
 * The tour is offered from several places — the Welcome card, the side dock's
 * Help panel, the Help page — and drawn once, over the whole desktop shell, so
 * a small context beats prop-drilling. The provider and the overlay are in
 * `components/tour/TourProvider.tsx` (this file stays component-free so fast
 * refresh keeps working). Outside a provider — the phone view, which has no
 * tour — `useTour()` returns null and the offers render nothing.
 */

import { createContext, useContext } from "react";

export interface TourValue {
  /** Is the tour on screen? */
  active: boolean;
  /** When this browser last finished or skipped the tour (ISO), or null. */
  doneAt: string | null;
  /** Start the tour (from its first step, on Home). Focus goes back to the caller's element when it ends. */
  startTour: () => void;
}

export const TourContext = createContext<TourValue | null>(null);

/** The tour's state and `startTour`, or null where there is no tour (the phone view). */
export function useTour(): TourValue | null {
  return useContext(TourContext);
}

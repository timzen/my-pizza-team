/**
 * TakeTourButton — "Take the tour": starts the optional guided tour of the
 * desktop UI (components/tour/TourProvider, lib/tour.ts; docs/DESIGN.md "First
 * run: a checklist, not a tour"). Offered on the Welcome card (until this
 * browser has finished or skipped the tour — `onlyIfNew`), in the side dock's
 * Help panel, and under the Help page's contents. Outside the tour's provider
 * — the phone view, which has no tour — it renders nothing.
 */

import { Compass } from "lucide-react";
import { useTour } from "@/hooks/useTour";
import { cn } from "@/lib/utils";

export function TakeTourButton({ onlyIfNew = false, className }: {
  /** Hide once this browser has finished or skipped the tour (the Welcome card's offer). */
  onlyIfNew?: boolean;
  className?: string;
}) {
  const tour = useTour();
  if (!tour || (onlyIfNew && tour.doneAt)) return null;
  return (
    <button
      type="button"
      onClick={tour.startTour}
      disabled={tour.active}
      className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-accent/50 hover:underline disabled:opacity-50", className)}
    >
      <Compass className="h-3.5 w-3.5" aria-hidden />Take the tour
    </button>
  );
}

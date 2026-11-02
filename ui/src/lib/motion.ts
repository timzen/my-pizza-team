/**
 * motion.ts — The user's reduced-motion preference, for motion that CSS can't
 * switch off (docs/ACCESSIBILITY.md "Motion").
 *
 * index.css stills every CSS animation and transition under
 * `prefers-reduced-motion: reduce`. What's left is motion started from script —
 * a smooth `scrollTo` / `scrollIntoView` (the chat following a reply, jumping
 * to a quoted message) — which asks here for its `behavior`.
 * The Thoughts canvas's pans and zooms are already instant (a transform set per
 * gesture, never tweened), so they need nothing.
 */

/** The media query for the OS-level "reduce motion" setting. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Has the user asked for less motion? (False where `matchMedia` doesn't exist, e.g. tests.) */
export function prefersReducedMotion(): boolean {
  // Typed by hand: the root typecheck (tests import this) has no DOM lib.
  const g = globalThis as { matchMedia?: (query: string) => { matches: boolean } };
  return g.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/** The scroll `behavior` to use: "smooth", or "auto" (a jump) when the user wants less motion. */
export function scrollBehavior(): "auto" | "smooth" {
  return prefersReducedMotion() ? "auto" : "smooth";
}

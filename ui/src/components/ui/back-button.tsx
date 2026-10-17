/**
 * BackButton — A back control that returns to wherever you actually came from.
 *
 * Uses the router history (`navigate(-1)`) so, e.g., a task opened from the
 * backlog goes back to the backlog rather than always to the board. On a fresh
 * page load (no in-app history), it falls back to the provided `fallback` route
 * so the button is never a dead end. "In-app history" is read from the router's
 * `history.state.idx` (lib/nav-section.ts `canGoBackInApp`), not `location.key`:
 * the key changes on any replace (e.g. switching Details/Thread), which made a
 * fresh-load Back leave the app instead of using the fallback.
 *
 * Two shapes: icon-only (default) or with a text `label`.
 */

import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { canGoBackInApp } from "@/lib/nav-section";

export function BackButton({
  fallback,
  label,
  title,
  className,
}: {
  /** Route to use when there's no in-app history to go back to. */
  fallback: string;
  /** Optional text beside the arrow (e.g. "Back to board"). */
  label?: string;
  title?: string;
  className?: string;
}) {
  const navigate = useNavigate();

  const goBack = () => {
    if (canGoBackInApp(globalThis.history?.state)) navigate(-1);
    // replace: the fallback stands in for "back", so it shouldn't leave this
    // page behind as a forward-only entry the next Back would bounce into.
    else navigate(fallback, { replace: true });
  };

  const base = label
    ? "flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    : "text-muted-foreground hover:text-foreground transition-colors";

  return (
    <button type="button" onClick={goBack} className={className ?? base} title={title ?? "Back"}>
      <ArrowLeft className={label ? "h-4 w-4" : "h-5 w-5"} />
      {label}
    </button>
  );
}

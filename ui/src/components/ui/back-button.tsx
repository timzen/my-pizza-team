/**
 * BackButton — A back control that returns to wherever you actually came from.
 *
 * Uses the router history (`navigate(-1)`) so, e.g., a task opened from the
 * backlog goes back to the backlog rather than always to the board. On a fresh
 * page load (no in-app history — `location.key === "default"`), it falls back to
 * the provided `fallback` route so the button is never a dead end.
 *
 * Two shapes: icon-only (default) or with a text `label`.
 */

import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

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
  const location = useLocation();

  const goBack = () => {
    if (location.key !== "default") navigate(-1);
    else navigate(fallback);
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

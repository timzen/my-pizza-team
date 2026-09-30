/**
 * TriageBadge — The one mark auto triage leaves on a note (docs/DESIGN.md "Auto
 * Triage: a Note Is a Parent").
 *
 * Notes are for thinking; triage is for the moment you promote one to work. So a
 * note's own view gains nothing, and this is the whole footprint: a small badge on
 * the card and the list row that links to the note's triage page.
 *
 * It shows the **latest analysis's outcome, not a count** — a lightbulb when
 * there's work waiting on your decision, a question mark when the teammate needs
 * something from you, a dash when it read the note and found nothing to create —
 * and shape, not color, carries the meaning (as with teammate status). Once every
 * proposal in the latest analysis has been decided, the badge is gone.
 */

import { Link } from "react-router-dom";
import { Lightbulb, HelpCircle, Minus } from "lucide-react";
import { badgeTitle, triagePath, type TriageBadge as Badge } from "@/lib/triage";

const ICON = {
  proposal: Lightbulb,
  question: HelpCircle,
  nothing: Minus,
} as const;

export function TriageBadge({ noteId, badge, className, onPointerDown }: {
  noteId: string;
  badge: Badge | undefined;
  className?: string;
  /** The canvas needs to stop a click here from starting a note drag. */
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  if (!badge || badge === "none") return null;
  const Icon = ICON[badge];
  const title = badgeTitle(badge);
  return (
    <Link
      to={triagePath(noteId)}
      title={title}
      aria-label={title}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground ${className ?? ""}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </Link>
  );
}

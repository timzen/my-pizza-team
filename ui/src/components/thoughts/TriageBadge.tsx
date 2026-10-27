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
 *
 * A triage-mode external item wears the same badge on its source's Work tab
 * (pages/ExternalSourcePage), linking to the mirror's Triage tab instead — pass
 * `to` and `subject: "item"` (docs/DESIGN.md "External sources" — "Triage mode").
 */

import { Link } from "react-router-dom";
import { Lightbulb, HelpCircle, Minus } from "lucide-react";
import { badgeTitle, triagePath, type TriageBadge as Badge, type TriageSubject } from "@/lib/triage";

const ICON = {
  proposal: Lightbulb,
  question: HelpCircle,
  nothing: Minus,
} as const;

export function TriageBadge({ noteId, to, subject = "note", badge, className, onPointerDown }: {
  /** The note it marks (links to its triage page) — or pass `to`. */
  noteId?: string;
  /** Where it links instead (a triage-mode external item's Triage tab). */
  to?: string;
  /** What it marks, for the tooltip's wording (default "note"). */
  subject?: TriageSubject;
  badge: Badge | undefined;
  className?: string;
  /** The canvas needs to stop a click here from starting a note drag. */
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const href = to ?? (noteId ? triagePath(noteId) : null);
  if (!badge || badge === "none" || !href) return null;
  const Icon = ICON[badge];
  const title = badgeTitle(badge, subject);
  return (
    <Link
      to={href}
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

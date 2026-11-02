/**
 * empty-state.tsx — What an empty list shows instead of a blank: an icon, a
 * short title, one sentence on what goes there (lib/empty-states.ts), the real
 * next step (open the create form, focus the chat, spawn a teammate — passed
 * as children), and "Learn more" opening the guide section about it
 * (docs/DESIGN.md "An Empty Screen Teaches").
 *
 * ```tsx
 * <EmptyState kind="board" icon={Kanban}>
 *   <Button render={<Link to="/stories/new" />}>New story</Button>
 *   <AskAssistantButton />
 * </EmptyState>
 * ```
 *
 * `NoMatches` is the other empty: a list filtered or searched down to nothing.
 * It says so ("Nothing matches the filters.") and offers to clear them, and
 * never the truly-empty explanation (lib/empty-states.ts `listView` picks).
 *
 * Neither is a live region: they appear when a poll finds a list empty, and a
 * poll is news only when something changed (docs/DESIGN.md "Polling Never
 * Disturbs the Reader"). "Learn more" is the dock's Help panel on the desktop
 * and the phone view's guide page on `/m`, which has no dock.
 */

import { useContext, useId, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { MessageSquare, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SideDockContext } from "@/hooks/useSideDock";
import { useStartChat } from "@/hooks/useStartChat";
import { useFeatures } from "@/hooks/useFeatures";
import { filterByFeatures } from "@/lib/features";
import { START_WORK } from "@/lib/start-work";
import { NO_MATCHES_TEXT, emptyStateCopy, type EmptyStateKey } from "@/lib/empty-states";
import { HELP_ROOT, MOBILE_HELP_ROOT, helpPath } from "@/lib/help";
import { isMobilePath } from "@/lib/mobile";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Which list (lib/empty-states.ts EMPTY_STATES): its title, sentence, and guide section. */
  kind: EmptyStateKey;
  /** The picture beside the words (decorative: the title says it). */
  icon: LucideIcon;
  /** Fills `{label}` in the copy (an external source's name). */
  label?: string;
  /** The actions: the primary one first. */
  children?: ReactNode;
  /** A line between the sentence and the actions (say, why an action is unavailable). */
  detail?: ReactNode;
  /** Tighter, for the dock's narrow Team tab and the canvas overlay. */
  compact?: boolean;
  className?: string;
}

/** A list's empty state: what goes here, the next step, and Learn more. */
export function EmptyState({ kind, icon: Icon, label, children, detail, compact, className }: EmptyStateProps) {
  const copy = emptyStateCopy(kind, { label });
  const titleId = useId();
  return (
    <div
      data-empty-state={kind}
      className={cn("flex flex-col items-center text-center", compact ? "gap-1.5 px-2 py-4" : "gap-2 px-4 py-12", className)}
    >
      <Icon className={cn("text-muted-foreground", compact ? "h-6 w-6" : "h-8 w-8")} aria-hidden />
      <p id={titleId} className={cn("font-medium text-foreground", compact ? "text-sm" : "")}>{copy.title}</p>
      <p className={cn("max-w-md text-muted-foreground", compact ? "text-xs" : "text-sm")}>{copy.text}</p>
      {detail}
      {children && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>}
      <LearnMore topic={copy.learnMore.topic} anchor={copy.learnMore.anchor} describedBy={titleId} compact={compact} />
    </div>
  );
}

/** A list filtered or searched down to nothing: say so, and offer to clear the filters. */
export function NoMatches({ onClear, clearLabel = "Clear filters", className }: {
  /** Clears the filters/search; omit when there's nothing to clear from here. */
  onClear?: () => void;
  clearLabel?: string;
  className?: string;
}) {
  return (
    <div data-no-matches className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground", className)}>
      <SearchX className="h-6 w-6" aria-hidden />
      <p className="text-sm">{NO_MATCHES_TEXT}</p>
      {onClear && <Button variant="outline" size="sm" onClick={onClear}>{clearLabel}</Button>}
    </div>
  );
}

/** "Ask the assistant": open the chat with the cursor in its box (hooks/useStartChat). */
export function AskAssistantButton({ label = "Ask the assistant", variant = "outline", size = "sm" }: {
  label?: string;
  variant?: "default" | "outline";
  size?: "sm" | "xs";
}) {
  const startChat = useStartChat();
  return (
    <Button variant={variant} size={size} onClick={startChat}>
      <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />{label}
    </Button>
  );
}

/**
 * "Start some work": the first kind of work the team has switched on (New
 * Story, Solitary Task or Scheduled Job — lib/start-work.ts, the dock's `+`),
 * then "Ask the assistant". With `desktopLinks` off (the phone view, which has
 * no create forms) or every kind off, just the chat.
 */
export function StartWorkActions({ desktopLinks = true }: { desktopLinks?: boolean }) {
  const features = useFeatures();
  const create = desktopLinks ? filterByFeatures(START_WORK, features)[0] : undefined;
  return (
    <>
      {create && (
        <Button size="sm" render={<Link to={create.to} />}>
          <create.icon className="mr-1 h-3.5 w-3.5" aria-hidden />{create.label}
        </Button>
      )}
      <AskAssistantButton variant={create ? "outline" : "default"} />
    </>
  );
}

// Underlined, not only colored: a link in text must not rely on color alone (WCAG 1.4.1).
const LEARN_MORE_CLASS = "inline-flex min-h-6 items-center rounded-sm px-1 text-primary underline underline-offset-2 hover:decoration-2";

/** "Learn more": the dock's Help panel on the desktop, the guide's page on the phone. */
function LearnMore({ topic, anchor, describedBy, compact }: { topic: string; anchor?: string; describedBy: string; compact?: boolean }) {
  const dock = useContext(SideDockContext);
  const { pathname } = useLocation();
  const className = cn(LEARN_MORE_CLASS, compact ? "text-xs" : "text-sm");
  if (!dock) {
    const root = isMobilePath(pathname) ? MOBILE_HELP_ROOT : HELP_ROOT;
    return <Link to={helpPath(topic, anchor, root)} className={className} aria-describedby={describedBy}>Learn more</Link>;
  }
  return (
    <button type="button" className={className} aria-describedby={describedBy} onClick={() => dock.openHelp({ topic, anchor })}>
      Learn more
    </button>
  );
}

/**
 * HelpPanel — The side dock's **Help** tab: the guide section that explains
 * the page you're on, beside it, so reading the help doesn't mean leaving the
 * page (docs/DESIGN.md "Help Comes to You").
 *
 *   Tasks and runs                 Open full guide ↗
 *   ## The Queue
 *   …the section, and its subsections…
 *
 * The section comes from the dock's state (hooks/useSideDock `help`: the
 * page's own, lib/help.ts `helpForPath`), cut out of its topic by lib/guide.ts
 * `guideSection`, and rendered by the Help page's renderer
 * (components/help/GuideMarkdown, "panel" variant: its heading is an h2). A
 * link to another guide section opens that section here, so you can follow
 * the guide without losing the page; a modified click, and **Open full
 * guide**, go to the Help page (`/help/<topic>#<section>`).
 *
 * Focus (docs/ACCESSIBILITY.md "Focus is always visible and never lost"): when
 * a ? opens it, focus moves to the section's heading; Esc anywhere in the
 * panel closes it, and the dock gives focus back to where it was.
 *
 * The footer's **Show the Welcome checklist** reopens the first-run card on
 * Home (components/onboarding/ShowWelcomeButton), and **Take the tour** starts
 * the guided tour (components/tour/TakeTourButton).
 *
 * Nothing here polls: the panel only changes when you open a section
 * (docs/DESIGN.md "Polling Never Disturbs the Reader").
 */

import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { GuideMarkdown } from "./GuideMarkdown";
import { GuideLinkContext, topicsFor } from "./guideContent";
import { ShowWelcomeButton } from "@/components/onboarding/ShowWelcomeButton";
import { TakeTourButton } from "@/components/tour/TakeTourButton";
import { useSideDock, type HelpTarget } from "@/hooks/useSideDock";
import { focusTarget } from "@/hooks/useRouteFocus";
import { guideSection } from "@/lib/guide";
import { HELP_ROOT, helpPath } from "@/lib/help";

export function HelpPanel() {
  const { help, openHelp, closeHelp, takeHelpFocus, helpFocusRequest } = useSideDock();
  const topics = topicsFor(HELP_ROOT);
  const topic = topics.find((t) => t.topic === help.topic) ?? topics[0];
  const section = topic ? guideSection(topic, help.anchor) : null;
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionKey = `${topic?.topic}#${section?.anchor}`;

  // A ? (or a link in here) asked for this section: start at its top, focus its heading.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    if (!takeHelpFocus()) return;
    const heading = bodyRef.current?.querySelector<HTMLElement>("h2");
    if (heading) focusTarget(heading, { preventScroll: true });
  }, [sectionKey, helpFocusRequest, takeHelpFocus]);

  // Esc inside the panel closes it (and the dock puts focus back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !panelRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      closeHelp();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeHelp]);

  // Links to another guide section stay in the panel.
  const openInPanel = useCallback((target: HelpTarget) => {
    if (!topicsFor(HELP_ROOT).some((t) => t.topic === target.topic)) return false;
    openHelp(target);
    return true;
  }, [openHelp]);

  if (!topic || !section) return null;
  return (
    <section ref={panelRef} aria-label="Help for this page" className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{section.level > 1 ? topic.title : "Guide"}</span>
        <Link
          to={helpPath(topic.topic, section.anchor || undefined)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-accent/50 hover:underline"
        >
          <BookOpen className="h-3.5 w-3.5" />Open full guide
        </Link>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <GuideLinkContext value={openInPanel}>
          <GuideMarkdown key={sectionKey} content={section.markdown} variant="panel" topLevel={section.level} />
        </GuideLinkContext>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-t border-border px-3 py-1.5 text-xs">
        <ShowWelcomeButton />
        <TakeTourButton />
      </div>
    </section>
  );
}

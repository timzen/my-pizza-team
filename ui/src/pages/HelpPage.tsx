/**
 * HelpPage — The user guide (docs/guide/*.md, copied into src/content/guide/
 * by the UI's `prebuild` and bundled at build time), one topic per route:
 * Getting Started at `/help`, every other page at `/help/<topic>`, and a
 * heading at `/help/<topic>#<section>` (lib/help.ts `helpPath`). The phone
 * view shows the same page under `/m/help` (`root`; mobile/MobileShell).
 *
 *   ┌───────────────┬──────────────────────────────────────┐
 *   │ [Search…    ] │ # Tasks and runs                     │
 *   │ Guide         │ …                                    │
 *   │  Getting St…  │ ## The Queue                         │
 *   │ ▸Tasks and r… │ …                                    │
 *   │    The Queue  │                                      │
 *   │  Stories …    │ ‹ Previous: Getting Started  Next: › │
 *   └───────────────┴──────────────────────────────────────┘
 *
 * - **Sidebar** (`<nav aria-label="Guide">`): every topic, and the current
 *   topic's h2/h3; `aria-current` marks the topic (`page`) and the section
 *   you're at (`location`). Below the page's own breakpoint (a container
 *   query, so the dock's width counts — and always on the phone) it folds into
 *   a "Contents" menu; Esc closes it.
 * - **Search** (lib/guide.ts `searchGuide`): headings and text, every word
 *   must match; the index is built on the first search. ↓ moves into the
 *   results, ↑/↓ through them, Esc clears; the result count is spoken through
 *   the live region once typing pauses (docs/ACCESSIBILITY.md "Live
 *   announcements").
 * - **Deep links**: a URL's `#section` scrolls to that heading and focuses it,
 *   after the shell's route focus (hooks/useRouteFocus) has put focus on the
 *   h1. An old one-page link (`/help#moribund`) is sent on to the topic that
 *   has the heading (lib/guide.ts `topicForAnchor`).
 * - Headings render at their own level here (the page's `#` title is its
 *   h1), and links into the guide go through the router.
 *
 * Nothing here polls, so nothing re-renders under the reader (docs/DESIGN.md
 * "Polling Never Disturbs the Reader").
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import type { Components } from "react-markdown";
import { ChevronLeft, ChevronRight, List, Search } from "lucide-react";
import { MarkdownView } from "@/components/ui/markdown-view";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { focusTarget } from "@/hooks/useRouteFocus";
import {
  adjacentTopics, buildSearchIndex, guideTopics, searchAnnouncement, searchGuide, topicForAnchor,
  type GuideTopic, type SearchEntry,
} from "@/lib/guide";
import { HELP_HOME_TOPIC, HELP_ROOT, anchorOfHash, helpPath, helpTopicParam, resolveTopic } from "@/lib/help";
import { scrollBehavior } from "@/lib/motion";

/** Every guide page, as raw markdown keyed by its path (Vite inlines them at build time). */
const GUIDE_MODULES = import.meta.glob<string>("../content/guide/*.md", { query: "?raw", import: "default", eager: true });

/** The topics with links under each root (`/help`, `/m/help`), built once: the pages never change while the app runs. */
const TOPICS = new Map<string, GuideTopic[]>();
function topicsFor(root: string): GuideTopic[] {
  let topics = TOPICS.get(root);
  if (!topics) TOPICS.set(root, (topics = guideTopics(GUIDE_MODULES, root)));
  return topics;
}

/** The search index, built on the first search (the same for every root: entries carry topics, not URLs). */
let searchIndex: SearchEntry[] | null = null;
function getSearchIndex(): SearchEntry[] {
  return (searchIndex ??= buildSearchIndex(topicsFor(HELP_ROOT)));
}

/** How long typing must pause before the result count is announced. */
const ANNOUNCE_DELAY_MS = 600;

/** A link in a guide page: app paths and anchors through the router, anything else in a new tab. */
function GuideLink({ href, children }: { href?: string; children?: ReactNode }) {
  const cls = "text-primary underline hover:text-primary/80";
  if (href && (href.startsWith("/") || href.startsWith("#"))) return <Link to={href} className={cls}>{children}</Link>;
  return <a href={href} target="_blank" rel="noopener" className={cls}>{children}</a>;
}

/** The guide's renderers: headings at their own level (the page's `#` is its h1), router links. */
const HELP_COMPONENTS: Components = {
  h1: ({ children, id }) => <h1 id={id} className="scroll-mt-4 text-2xl font-bold mb-4">{children}</h1>,
  h2: ({ children, id }) => <h2 id={id} className="scroll-mt-4 text-xl font-bold mt-8 mb-2">{children}</h2>,
  h3: ({ children, id }) => <h3 id={id} className="scroll-mt-4 text-base font-semibold mt-6 mb-2">{children}</h3>,
  h4: ({ children, id }) => <h4 id={id} className="scroll-mt-4 text-sm font-semibold mt-4 mb-1">{children}</h4>,
  h5: ({ children, id }) => <h5 id={id} className="scroll-mt-4 text-sm font-semibold mt-3 mb-1">{children}</h5>,
  h6: ({ children, id }) => <h6 id={id} className="scroll-mt-4 text-sm font-semibold mt-3 mb-1">{children}</h6>,
  a: GuideLink,
};

/** The guide at `root` (`/help` on the desktop, `/m/help` on the phone). */
export function HelpPage({ root = HELP_ROOT }: { root?: string }) {
  const location = useLocation();
  const topics = topicsFor(root);
  const param = helpTopicParam(location.pathname, root);
  const topic = resolveTopic(param, topics.map((t) => t.topic));
  const current = topics.find((t) => t.topic === topic) ?? null;
  const anchor = anchorOfHash(location.hash);
  const contentRef = useRef<HTMLElement>(null);
  useDocumentTitle(current ? [current.title, "Help"] : ["Topic not found", "Help"]);
  useAnchorFocus(contentRef, anchor, location.key);

  // Where this URL should really be: Getting Started is the root itself, a
  // file name (`01-tasks-and-runs.md`) is its topic, and an old one-page
  // anchor goes to the topic that has that heading.
  let canonical: string | null = null;
  if (current) {
    let target = current.topic;
    if (anchor && current.topic === HELP_HOME_TOPIC && !current.headings.some((h) => h.id === anchor)) {
      target = topicForAnchor(topics, anchor) ?? target;
    }
    const path = helpPath(target, undefined, root);
    if (path !== location.pathname) canonical = `${path}${location.hash}`;
  }
  if (canonical) return <Navigate to={canonical} replace />;

  return (
    <div className="@container h-full">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 @3xl:flex-row @3xl:p-6">
        <HelpSidebar root={root} topics={topics} current={current} anchor={anchor} />
        <article ref={contentRef} className="min-w-0 max-w-3xl flex-1">
          {current ? (
            <>
              <MarkdownView key={current.topic} content={current.markdown} headingIds components={HELP_COMPONENTS} />
              <PrevNext root={root} topics={topics} topic={current.topic} />
            </>
          ) : (
            <TopicNotFound root={root} topics={topics} />
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * After a navigation to `#anchor`, scroll to that heading and focus it. In an
 * animation frame, so it lands after the shell's route focus (which runs in a
 * parent's effect, after this one) has moved focus to the new page's h1.
 */
function useAnchorFocus(contentRef: React.RefObject<HTMLElement | null>, anchor: string, locationKey: string) {
  useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
      if (!el) return;
      focusTarget(el, { preventScroll: true });
      el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    });
    return () => cancelAnimationFrame(frame);
  }, [contentRef, anchor, locationKey]);
}

/** The search box, its results, and the table of contents (a menu on a narrow page). */
function HelpSidebar({ root, topics, current, anchor }: { root: string; topics: GuideTopic[]; current: GuideTopic | null; anchor: string }) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navId = useId();
  const searching = query.trim() !== "";

  /** Done with the sidebar for now: a link was followed. */
  const picked = () => { setQuery(""); setMenuOpen(false); };

  // Esc closes the open menu (narrow pages) and gives focus back to its button.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex shrink-0 flex-col gap-3 @3xl:sticky @3xl:top-6 @3xl:max-h-[calc(100dvh-6.5rem)] @3xl:w-64 @3xl:self-start @3xl:overflow-y-auto">
      <GuideSearch root={root} query={query} onQuery={setQuery} onPicked={picked} />
      {!searching && (
        <>
          <button
            ref={menuButton}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 self-start rounded-md border border-border px-3 py-1.5 text-sm @3xl:hidden"
          >
            <List className="h-4 w-4" />Contents
          </button>
          <nav id={navId} aria-label="Guide" className={`${menuOpen ? "" : "hidden"} @3xl:block`}>
            <ul className="space-y-0.5 text-sm">
              {topics.map((t) => {
                const isCurrent = t.topic === current?.topic;
                return (
                  <li key={t.topic}>
                    <Link
                      to={helpPath(t.topic, undefined, root)}
                      aria-current={isCurrent ? "page" : undefined}
                      onClick={picked}
                      className={`block rounded-md px-2 py-1 ${isCurrent ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
                    >
                      {t.title}
                    </Link>
                    {isCurrent && <SectionList root={root} topic={t} anchor={anchor} onPicked={picked} />}
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}

/** The current topic's h2 and h3 headings, under its entry in the table of contents. */
function SectionList({ root, topic, anchor, onPicked }: { root: string; topic: GuideTopic; anchor: string; onPicked: () => void }) {
  const sections = topic.headings.filter((h) => h.level === 2 || h.level === 3);
  if (!sections.length) return null;
  return (
    <ul className="my-1 space-y-0.5 border-l border-border pl-2 ml-3">
      {sections.map((h) => (
        <li key={h.id}>
          <Link
            to={helpPath(topic.topic, h.id, root)}
            aria-current={h.id === anchor ? "location" : undefined}
            onClick={onPicked}
            className={`block rounded-md px-2 py-0.5 text-[13px] ${h.level === 3 ? "pl-5" : ""} ${h.id === anchor ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {h.text}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Move focus among the result links: ↑/↓, wrapping to the search box at the top. */
function moveInList(list: HTMLElement | null, from: Element | null, delta: number, input: HTMLInputElement | null) {
  const links = [...(list?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
  const i = links.indexOf(from as HTMLAnchorElement);
  const next = i + delta;
  if (next < 0) input?.focus();
  else links[Math.min(next, links.length - 1)]?.focus();
}

/** The search box and its results (lib/guide.ts `searchGuide`). */
function GuideSearch({ root, query, onQuery, onPicked }: { root: string; query: string; onQuery: (q: string) => void; onPicked: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const inputId = useId();
  const resultsId = useId();
  const announce = useAnnounce();
  const results = useMemo(() => (query.trim() ? searchGuide(getSearchIndex(), query) : []), [query]);
  const topicTitles = useMemo(() => new Map(topicsFor(root).map((t) => [t.topic, t.title])), [root]);

  // Say how many matched once typing pauses — not on every keystroke.
  useEffect(() => {
    const message = searchAnnouncement(query, results.length);
    if (!message) return;
    const timer = setTimeout(() => announce(message), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, results.length, announce]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      onQuery("");
    } else if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      moveInList(list.current, null, 1, input.current);
    }
  };
  const onResultKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveInList(list.current, document.activeElement, e.key === "ArrowDown" ? 1 : -1, input.current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onQuery("");
      input.current?.focus();
    }
  };

  return (
    <div role="search" aria-label="Search the guide" className="flex flex-col gap-2">
      <label htmlFor={inputId} className="sr-only">Search the guide</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={input}
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search the guide"
          autoComplete="off"
          aria-controls={query.trim() ? resultsId : undefined}
          aria-keyshortcuts="ArrowDown Escape"
          className="h-9 w-full rounded-lg border border-input bg-transparent pl-8 pr-2.5 text-sm placeholder:text-muted-foreground focus-visible:border-ring dark:bg-input/30"
        />
      </div>
      {query.trim() !== "" && (
        <div id={resultsId}>
          <p className="px-1 text-xs text-muted-foreground">
            {searchAnnouncement(query, results.length)}
            {results.length > 0 && <span className="sr-only"> — use the arrow keys to move through them, Escape to clear</span>}
          </p>
          {results.length > 0 && (
            <ul ref={list} aria-label="Search results" className="mt-1 space-y-1">
              {results.map(({ entry, snippet }) => (
                <li key={`${entry.topic}#${entry.id}`}>
                  <Link
                    to={helpPath(entry.topic, entry.id, root)}
                    onClick={onPicked}
                    onKeyDown={onResultKeyDown}
                    className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <span className="block font-medium">{entry.heading}</span>
                    {entry.level > 1 && <span className="block text-xs text-muted-foreground">{topicTitles.get(entry.topic)}</span>}
                    {snippet && <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">{snippet}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "Previous / Next topic" at the bottom of a page. */
function PrevNext({ root, topics, topic }: { root: string; topics: GuideTopic[]; topic: string }) {
  const { prev, next } = adjacentTopics(topics, topic);
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next topic" className="mt-10 flex flex-wrap justify-between gap-3 border-t border-border pt-4 text-sm">
      {prev ? (
        <Link to={helpPath(prev.topic, undefined, root)} rel="prev" className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent/50">
          <ChevronLeft className="h-4 w-4" />
          <span><span className="block text-xs text-muted-foreground">Previous</span>{prev.title}</span>
        </Link>
      ) : <span />}
      {next && (
        <Link to={helpPath(next.topic, undefined, root)} rel="next" className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-right hover:bg-accent/50">
          <span><span className="block text-xs text-muted-foreground">Next</span>{next.title}</span>
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </nav>
  );
}

/** A `/help/<topic>` that names no topic: say so, and offer the list. */
function TopicNotFound({ root, topics }: { root: string; topics: GuideTopic[] }) {
  return (
    <div className="text-sm">
      <h1 className="text-2xl font-bold mb-4">Topic not found</h1>
      <p className="mb-3">There's no help topic at this address. Try one of these, or search above:</p>
      <ul className="list-disc pl-5 space-y-1">
        {topics.map((t) => (
          <li key={t.topic}><Link to={helpPath(t.topic, undefined, root)} className="text-primary underline">{t.title}</Link></li>
        ))}
      </ul>
    </div>
  );
}

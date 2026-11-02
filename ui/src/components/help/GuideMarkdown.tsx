/**
 * GuideMarkdown — Renders the user guide's markdown, for both the Help page
 * (pages/HelpPage) and the side dock's Help panel (components/help/HelpPanel):
 * one renderer, so a section reads the same in both places.
 *
 * MarkdownView does the rendering; this picks its heading and link renderers:
 *
 * - **page** — headings at their own level (the page's `#` title is its h1)
 *   with their GitHub anchors as ids (`headingIds`), for deep links.
 * - **panel** — the section's own heading becomes an h2 and the ones under it
 *   follow (the dock sits beside the page's h1, docs/ACCESSIBILITY.md
 *   "Structure"), in a smaller type; no ids, since the same headings may be on
 *   the page beside it (duplicate ids).
 *
 * Links into the guide go through the router; anything else opens in a new
 * tab. Inside the panel a link to another guide section can stay in the panel
 * instead: the panel provides `GuideLinkContext` (guideContent.ts), and a plain click on such a
 * link calls it rather than navigating the center.
 *
 * MarkdownView needs its `components` map to be a stable object (a new one
 * remounts the document), so the maps are built once per variant and level
 * and cached here, never in render.
 */

import { useContext, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Components } from "react-markdown";
import { MarkdownView } from "@/components/ui/markdown-view";
import { parseHelpHref } from "@/lib/help";
import { GuideLinkContext } from "./guideContent";

/** A link in a guide page: app paths and anchors through the router, anything else in a new tab. */
function GuideLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openInPanel = useContext(GuideLinkContext);
  const cls = "text-primary underline hover:text-primary/80";
  if (href && (href.startsWith("/") || href.startsWith("#"))) {
    const target = openInPanel ? parseHelpHref(href) : null;
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // A modified click (new tab, new window) still does what the browser does.
      if (!target || !openInPanel || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (openInPanel(target)) e.preventDefault();
    };
    return <Link to={href} onClick={onClick} className={cls}>{children}</Link>;
  }
  return <a href={href} target="_blank" rel="noopener" className={cls}>{children}</a>;
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
const TAGS: HeadingTag[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** The Help page's heading looks, by tag. */
const PAGE_HEADING_CLASS: Record<HeadingTag, string> = {
  h1: "scroll-mt-4 text-2xl font-bold mb-4",
  h2: "scroll-mt-4 text-xl font-bold mt-8 mb-2",
  h3: "scroll-mt-4 text-base font-semibold mt-6 mb-2",
  h4: "scroll-mt-4 text-sm font-semibold mt-4 mb-1",
  h5: "scroll-mt-4 text-sm font-semibold mt-3 mb-1",
  h6: "scroll-mt-4 text-sm font-semibold mt-3 mb-1",
};

/** The panel's heading looks, by tag: the dock is narrow, so smaller. */
const PANEL_HEADING_CLASS: Record<HeadingTag, string> = {
  h1: "text-base font-semibold mb-2",
  h2: "text-base font-semibold mb-2 first:mt-0 mt-4",
  h3: "text-sm font-semibold mt-4 mb-1",
  h4: "text-sm font-semibold mt-3 mb-1",
  h5: "text-sm font-medium mt-3 mb-1",
  h6: "text-sm font-medium mt-3 mb-1",
};

/** A heading renderer: renders its markdown heading as `tag`, styled `className`. */
function heading(tag: HeadingTag, className: string) {
  const Tag = tag;
  return function GuideHeading({ children, id }: { children?: ReactNode; id?: string }) {
    return <Tag id={id} className={className}>{children}</Tag>;
  };
}

/** The cached component maps, by `variant:topLevel`. */
const MAPS = new Map<string, Components>();

/** The (stable) components map for a variant whose top heading is markdown level `topLevel`. */
function componentsFor(variant: "page" | "panel", topLevel: number): Components {
  const key = `${variant}:${topLevel}`;
  let map = MAPS.get(key);
  if (map) return map;
  // The page keeps each level; the panel moves `topLevel` to h2 and the rest along with it.
  const shift = variant === "page" ? 0 : 2 - topLevel;
  const looks = variant === "page" ? PAGE_HEADING_CLASS : PANEL_HEADING_CLASS;
  map = { a: GuideLink };
  TAGS.forEach((md, i) => {
    const tag = TAGS[Math.min(5, Math.max(0, i + shift))]!;
    map![md] = heading(tag, looks[tag]);
  });
  MAPS.set(key, map);
  return map;
}

/**
 * The guide's markdown, rendered for the Help page (`variant="page"`) or the
 * dock's Help panel (`"panel"`, with `topLevel` the markdown level of the
 * section's own heading: 1 for a whole topic, 2 for a `##` section).
 */
export function GuideMarkdown({ content, variant = "page", topLevel = 1 }: { content: string; variant?: "page" | "panel"; topLevel?: number }) {
  return <MarkdownView content={content} headingIds={variant === "page"} components={componentsFor(variant, topLevel)} />;
}

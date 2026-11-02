/**
 * guideContent.ts — The user guide's pages as the app bundles them, shared by
 * the Help page (pages/HelpPage) and the side dock's Help panel
 * (components/help/HelpPanel), and the context through which the panel keeps
 * its guide links inside itself.
 *
 * docs/guide/*.md is copied into src/content/guide/ by the UI's `prebuild` and
 * inlined by Vite at build time; lib/guide.ts turns the raw pages into topics.
 * Here, not in lib/, because `import.meta.glob` is Vite's: lib stays plain
 * TypeScript the Node tests import.
 */

import { createContext } from "react";
import { buildSearchIndex, guideTopics, type GuideTopic, type SearchEntry } from "@/lib/guide";
import { HELP_ROOT } from "@/lib/help";

/** Every guide page, as raw markdown keyed by its path (Vite inlines them at build time). */
const GUIDE_MODULES = import.meta.glob<string>("../../content/guide/*.md", { query: "?raw", import: "default", eager: true });

/** The topics with links under each root (`/help`, `/m/help`), built once: the pages never change while the app runs. */
const TOPICS = new Map<string, GuideTopic[]>();

/** The guide's topics, in reading order, with their links pointing under `root`. */
export function topicsFor(root: string = HELP_ROOT): GuideTopic[] {
  let topics = TOPICS.get(root);
  if (!topics) TOPICS.set(root, (topics = guideTopics(GUIDE_MODULES, root)));
  return topics;
}

/** The search index, built on the first search (the same for every root: entries carry topics, not URLs). */
let searchIndex: SearchEntry[] | null = null;

/** The guide's search index (lib/guide.ts `buildSearchIndex`), built on first use. */
export function getSearchIndex(): SearchEntry[] {
  return (searchIndex ??= buildSearchIndex(topicsFor(HELP_ROOT)));
}

/**
 * Inside the Help panel: open a guide link's section in the panel instead of
 * navigating (components/help/GuideMarkdown's links read it). Returns false
 * when it couldn't (say, an unknown topic), so the link navigates as usual.
 */
export const GuideLinkContext = createContext<((target: { topic: string; anchor?: string }) => boolean) | null>(null);

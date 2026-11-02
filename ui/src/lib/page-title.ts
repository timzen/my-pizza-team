/**
 * page-title.ts — The browser tab's title for each route (docs/ACCESSIBILITY.md
 * "Structure"): `<Page> · <team> · Pizza Team`, most specific first, so a
 * screen reader announces where you landed and a row of tabs stays readable.
 *
 * `pageTitleForPath` names the routes whose title follows from the URL alone —
 * every top-level page, each Work and Config tab, the phone view's tabs. A
 * detail page (a task, a story, a WorkDef, a teammate, a Work Source's tab —
 * and the new-WorkDef form, whose heading follows its `?type=`) returns null: its title is the thing's own name, which only the page knows
 * once it has loaded, so the page sets it (hooks/useDocumentTitle). The shell
 * and the page never both set it for one route.
 */

import { CONFIG_TABS } from "./config-tabs.ts";
import { WORK_ITEMS_TABS } from "./work-items.ts";
import { MOBILE_ROOT } from "./mobile.ts";

/** The product name: always the title's last part. */
export const APP_TITLE = "Pizza Team";

/** The separator between a title's parts. */
const SEP = " · ";

/**
 * Join a page's name parts (most specific first), the team's name, and the
 * product name into a document title, dropping empty parts — so a missing team
 * name (the first status poll hasn't answered) just leaves it out.
 */
export function formatPageTitle(page: string | readonly string[] | null | undefined, team?: string | null): string {
  const parts = typeof page === "string" ? [page] : [...(page ?? [])];
  return [...parts, team, APP_TITLE].map((p) => p?.trim()).filter(Boolean).join(SEP);
}

/** Phone-view tab titles, by path (lib/mobile.ts MOBILE_TAB_PATHS). */
const MOBILE_TITLES: Record<string, string> = {
  [MOBILE_ROOT]: "Team",
  [`${MOBILE_ROOT}/chat`]: "Chat",
  [`${MOBILE_ROOT}/thoughts`]: "Thoughts",
  [`${MOBILE_ROOT}/inbox`]: "Inbox",
};

/** Fixed top-level pages. */
const STATIC_TITLES: Record<string, string[]> = {
  "/": ["Inbox"],
  "/queue": ["Queue"],
  "/thoughts": ["Thoughts"],
  "/help": ["Help"],
  "/usage": ["Usage"],
  "/work": ["Work"],
  "/stories/new": ["New story", "Work"],
};

/**
 * The page-name parts for `pathname` (most specific first, without the team
 * and product), or null when the page names itself (a detail page) — see the
 * file comment. Unknown paths get null too: nothing to say, so the title is
 * left to whatever renders there.
 */
export function pageTitleForPath(pathname: string): string[] | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === MOBILE_ROOT || path.startsWith(`${MOBILE_ROOT}/`)) {
    const tab = MOBILE_TITLES[path];
    return tab ? [tab] : [MOBILE_TITLES[MOBILE_ROOT]!];
  }
  if (STATIC_TITLES[path]) return STATIC_TITLES[path];

  const work = WORK_ITEMS_TABS.find((t) => t.path === path);
  if (work) return [work.label, "Work"];

  if (path === "/config" || path.startsWith("/config/")) {
    const [, , tab, ...rest] = path.split("/");
    const def = CONFIG_TABS.find((t) => (tab ? t.path === `/config/${tab}` : t.tab === "general"));
    if (!def) return ["Configuration"];
    // A workflow's or a persona's detail: its id is in the URL (personas' ids may hold "/").
    const detail = rest.length ? decodeURIComponentSafe(rest.join("/")) : null;
    return detail ? [detail, def.label, "Configuration"] : [def.label, "Configuration"];
  }

  if (/^\/story\/[^/]+\/tasks\/new$/.test(path)) return ["New task", "Work"];
  if (/^\/thoughts\/[^/]+\/triage$/.test(path)) return ["Triage", "Thoughts"];
  return null;
}

/** decodeURIComponent that leaves a malformed escape as typed instead of throwing. */
function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * help.ts — The in-app Help's URLs (docs/ACCESSIBILITY.md "Structure";
 * pages/HelpPage.tsx renders them).
 *
 * Each guide page (docs/guide/NN-<topic>.md) is a route: Getting Started is
 * `/help`, every other page `/help/<topic>`, and a heading inside one is its
 * GitHub-style anchor, `/help/<topic>#<section>`. The phone view has the same
 * pages under `/m/help` (docs/DESIGN.md "A Phone Is a Peek").
 *
 * `helpPath` is how the rest of the UI links into the guide — a screen's
 * "Learn more" goes to `helpPath("tasks-and-runs", "the-queue")` — and
 * `HELP_TOPICS` lists the topics so a typo is a type error (tests/help-ui.test.ts
 * checks it against docs/guide/). Dependency-free so it's unit-tested there.
 *
 * It also knows which part of the guide explains each screen — `helpForPath`,
 * behind every page's ? button, the NavBar's Help, and the `?` shortcut, which
 * open that section in the side dock's Help panel (components/help/HelpPanel;
 * docs/DESIGN.md "Help Comes to You") — and, for that shortcut, when a key
 * press is typing rather than a command (`isTypingTarget`).
 */

/** The desktop Help's root: Getting Started. */
export const HELP_ROOT = "/help";

/** The phone view's Help root (lib/mobile.ts MOBILE_ROOT + `/help`). */
export const MOBILE_HELP_ROOT = "/m/help";

/** The topic `/help` itself shows. */
export const HELP_HOME_TOPIC = "getting-started";

/** Every guide topic, in reading order: a docs/guide file's name without its number and `.md`. */
export const HELP_TOPICS = [
  "getting-started",
  "tasks-and-runs",
  "stories-and-workflows",
  "teammates",
  "assistant",
  "thoughts-and-triage",
  "personas",
  "sources",
  "configuration",
  "phone",
  "tips",
  "glossary",
] as const;

/** One guide topic's id, as used in its URL. */
export type HelpTopic = (typeof HELP_TOPICS)[number];

/**
 * A guide file's topic: its name without the order prefix and `.md`
 * (`01-tasks-and-runs.md` → `tasks-and-runs`, `glossary.md` → `glossary`).
 */
export function topicOfFile(file: string): string {
  return file.replace(/\.md$/i, "").replace(/^\d+-/, "");
}

/**
 * The URL of a guide topic, optionally at one of its headings: `helpPath("glossary",
 * "moribund")` → `/help/glossary#moribund`. Getting Started is the root itself
 * (`/help`, `/help#read-next`). `root` is `MOBILE_HELP_ROOT` for the phone view.
 * Use it for every link into the guide, so the next restructuring is one place.
 */
export function helpPath(topic: HelpTopic | (string & {}), anchor?: string, root: string = HELP_ROOT): string {
  const base = !topic || topic === HELP_HOME_TOPIC ? root : `${root}/${encodeURIComponent(topic)}`;
  const hash = anchor?.replace(/^#/, "");
  return hash ? `${base}#${encodeURIComponent(hash)}` : base;
}

/** Is this path the Help (desktop or phone), any topic? */
export function isHelpPath(pathname: string): boolean {
  return [HELP_ROOT, MOBILE_HELP_ROOT].some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/**
 * The `:topic` part of a Help path under `root` (`/help/glossary` → `glossary`),
 * or undefined for the root itself — or for a path that isn't under `root`.
 */
export function helpTopicParam(pathname: string, root: string = HELP_ROOT): string | undefined {
  if (!pathname.startsWith(`${root}/`)) return undefined;
  return pathname.slice(root.length + 1).replace(/\/+$/, "") || undefined;
}

/**
 * Which of `topics` a URL's `:topic` names, or null. Forgiving, because people
 * type and paste these: case doesn't matter, and the file's name works too
 * (`01-tasks-and-runs`, `01-tasks-and-runs.md`). No `:topic` is Getting Started.
 */
export function resolveTopic(param: string | undefined, topics: readonly string[]): string | null {
  if (param === undefined || param === "") return topics.includes(HELP_HOME_TOPIC) ? HELP_HOME_TOPIC : (topics[0] ?? null);
  const wanted = topicOfFile(safeDecode(param).trim().toLowerCase());
  return topics.find((t) => t === wanted) ?? null;
}

/** The anchor in a location's hash (`#the%20queue` → `the queue`), or "" for none. */
export function anchorOfHash(hash: string): string {
  return safeDecode(hash.replace(/^#/, ""));
}

/** decodeURIComponent that leaves a malformed escape as typed instead of throwing. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ─── Help for the page you're on ─────────────────────────────────────

/** The guide section that explains one screen: where its ? goes. */
export interface PageHelp {
  topic: HelpTopic;
  /** A heading's anchor in the topic; none for the whole topic. */
  anchor?: string;
  /** The screen's name, for the ? button's label ("Help: Queue"). */
  page: string;
}

/** Fixed routes → their section. */
const STATIC_HELP: Record<string, PageHelp> = {
  "/": { topic: "tasks-and-runs", anchor: "the-inbox", page: "Inbox" },
  "/queue": { topic: "tasks-and-runs", anchor: "the-queue", page: "Queue" },
  "/thoughts": { topic: "thoughts-and-triage", page: "Thoughts" },
  "/work": { topic: "tasks-and-runs", anchor: "the-work-tabs", page: "Work" },
  "/work/board": { topic: "stories-and-workflows", anchor: "the-board", page: "Board" },
  "/work/tasks": { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs", page: "Tasks" },
  "/work/schedule": { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs", page: "Schedule" },
  "/work/pending": { topic: "tasks-and-runs", anchor: "pending-write-first-run-when-its-right", page: "Pending" },
  "/work/archived": { topic: "tasks-and-runs", anchor: "the-work-tabs", page: "Archived" },
  "/stories/new": { topic: "stories-and-workflows", anchor: "creating-a-story", page: "New story" },
  "/work-defs/new": { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs", page: "New task" },
  "/usage": { topic: "teammates", anchor: "usage-what-the-team-costs", page: "Usage" },
};

/** Each Config tab (`/config/<tab>`; General is `/config`) → its section. */
const CONFIG_HELP: Record<string, PageHelp> = {
  "": { topic: "configuration", page: "Configuration" },
  teammates: { topic: "teammates", anchor: "one-teammate-per-directory", page: "Teammates settings" },
  sources: { topic: "sources", anchor: "setting-up-a-source-from-the-ui", page: "Sources settings" },
  workflows: { topic: "stories-and-workflows", anchor: "workflows", page: "Workflows" },
  personas: { topic: "personas", anchor: "the-library", page: "Personas" },
  triage: { topic: "thoughts-and-triage", anchor: "auto-triage-notes-that-become-work", page: "Triage settings" },
  theme: { topic: "configuration", page: "Theme" },
};

/** The section for auto triage: a note's triage page, and a triage WorkDef. */
const TRIAGE_HELP: PageHelp = { topic: "thoughts-and-triage", anchor: "auto-triage-notes-that-become-work", page: "Triage" };

/**
 * The guide section that explains the screen at `pathname` — what that page's
 * ? opens. Detail pages share their kind's section (a story, a board task, a
 * teammate, a source's tab, a WorkDef); a WorkDef's depends on its type
 * (`workDefType`, once loaded: a triage run's is auto triage). The phone
 * view's tabs all open "On your phone", the page written for them. Null for
 * the Help itself and for a path no screen lives at (the caller falls back to
 * Getting Started).
 */
export function helpForPath(pathname: string, opts: { workDefType?: string | null } = {}): PageHelp | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (isHelpPath(path)) return null;
  const fixed = STATIC_HELP[path];
  if (fixed) return fixed;
  const [first, second, third, fourth] = path.split("/").filter(Boolean);
  switch (first) {
    case "m":
      return { topic: "phone", page: "Phone view" };
    case "thoughts":
      return second && third === "triage" && !fourth ? TRIAGE_HELP : null;
    case "story":
      if (!second) return null;
      if (third === "tasks" && fourth === "new") return { topic: "stories-and-workflows", anchor: "managing-tasks", page: "New task" };
      return third ? null : { topic: "stories-and-workflows", anchor: "stories", page: "Story" };
    case "task":
      return second && third ? { topic: "stories-and-workflows", anchor: "reviewing-work", page: "Board task" } : null;
    case "work":
      return second === "source" && third ? { topic: "sources", anchor: "a-sources-tab", page: "Source" } : null;
    case "work-defs":
      if (!second) return null;
      if (opts.workDefType === "Triage") return TRIAGE_HELP;
      if (opts.workDefType === "External") return { topic: "sources", anchor: "a-sources-tab", page: "Source item" };
      return { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs", page: opts.workDefType === "Scheduled" ? "Scheduled job" : "Task" };
    case "config": {
      // A workflow's detail has its own section; a source's and a persona's share their tab's.
      if (second === "workflows" && third) return { topic: "stories-and-workflows", anchor: "viewing-and-editing-a-workflow", page: "Workflow" };
      return CONFIG_HELP[second ?? ""] ?? null;
    }
    case "teammates":
      return second && !third ? { topic: "teammates", anchor: "watching-a-teammate", page: "Teammate" } : null;
    default:
      return null;
  }
}

/** What a `/help…` link (`/help/glossary#moribund`, `/help#read-next`) points at, or null for any other href. */
export function parseHelpHref(href: string, root: string = HELP_ROOT): { topic: string; anchor?: string } | null {
  const hashAt = href.indexOf("#");
  const pathname = hashAt < 0 ? href : href.slice(0, hashAt);
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
  const topic = helpTopicParam(pathname, root);
  const anchor = hashAt < 0 ? "" : anchorOfHash(href.slice(hashAt));
  return { topic: topic ? safeDecode(topic) : HELP_HOME_TOPIC, ...(anchor ? { anchor } : {}) };
}

/** The bits of a DOM element `isTypingTarget` reads (so it's testable without a DOM). */
export interface TypingTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** `<input type>`s that take no typed text: a key press there is a command, not a character. */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/**
 * Is a key press on this element typing — so a single-key shortcut (the `?`
 * that toggles the Help panel) must leave it alone? Text inputs, text areas,
 * selects, anything contenteditable (the code editor) or a `role="textbox"`,
 * and anything inside a dialog (a modal owns the keyboard).
 */
export function isTypingTarget(el: TypingTargetLike | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
  return !!el.closest?.("[role=dialog], [role=alertdialog]");
}

/** The Help panel's shortcut key (`aria-keyshortcuts` and the hint use it too). */
export const HELP_SHORTCUT = "?";

/** Is this key press the Help panel's shortcut: `?`, no Ctrl/Meta/Alt, not while typing? */
export function isHelpShortcut(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown }): boolean {
  if (e.key !== HELP_SHORTCUT || e.ctrlKey || e.metaKey || e.altKey) return false;
  return !isTypingTarget(e.target as TypingTargetLike | null);
}

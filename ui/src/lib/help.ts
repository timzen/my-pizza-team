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

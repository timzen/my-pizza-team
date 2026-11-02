/**
 * tests/a11y/_gate.ts — the pass/fail rule of the accessibility scan (docs/ACCESSIBILITY.md).
 *
 * Pure, so the fast suite tests it (tests/a11y-gate.test.ts) without a browser.
 * The scan (tests/a11y/routes.test.ts) collects axe-core's violations per route;
 * this decides which of them fail the run:
 *
 *   - a **serious** or **critical** violation fails, unless tests/a11y/allowlist.json
 *     lists its route and rule;
 *   - an allowlist entry that no longer matches anything also fails, so the list
 *     can only shrink as the accessibility story's tasks fix what it names — an
 *     entry can't outlive its fix and quietly cover a regression later.
 *
 * Minor and moderate findings never fail; they're in the report.
 */

/** axe-core's impact levels, least to most severe. */
export type Impact = "minor" | "moderate" | "serious" | "critical";

/** The impacts that fail the scan. */
export const FAILING_IMPACTS: ReadonlySet<Impact> = new Set(["serious", "critical"]);

/** One axe rule's violation on one scanned route. */
export interface Finding {
  /** The scan's name for the route, e.g. "/work/board" or "/m (phone)". */
  route: string;
  /** axe rule id, e.g. "button-name". */
  rule: string;
  impact: Impact | null;
  /** How many elements violate it. */
  nodes: number;
  help: string;
  /** A CSS selector for the first violating element, to find it. */
  example?: string;
}

/** A known, accepted violation: which task of the story is to fix it. */
export interface AllowlistEntry {
  route: string;
  rule: string;
  /** The task that removes this entry, e.g. "ui-a11y-foundations-2". */
  task: string;
  note?: string;
}

export interface GateResult {
  /** Failing findings the allowlist doesn't cover. */
  unexpected: Finding[];
  /** Allowlist entries no failing finding matched (fixed — remove them). */
  stale: AllowlistEntry[];
  /** Failing findings the allowlist covers. */
  allowed: Finding[];
}

const key = (route: string, rule: string) => `${route}\u0000${rule}`;

/** Does this finding fail the scan, allowlist aside? */
export function isFailing(f: Finding): boolean {
  return f.impact !== null && FAILING_IMPACTS.has(f.impact);
}

/**
 * Split the scan's findings into what fails, what the allowlist excuses, and
 * which allowlist entries are stale. `scannedRoutes` limits staleness to the
 * routes actually scanned, so a partial run (one route, while debugging) doesn't
 * report every other route's entries as stale.
 */
export function gate(findings: Finding[], allowlist: AllowlistEntry[], scannedRoutes?: Iterable<string>): GateResult {
  const allowedKeys = new Set(allowlist.map((e) => key(e.route, e.rule)));
  const failing = findings.filter(isFailing);
  const seen = new Set(failing.map((f) => key(f.route, f.rule)));
  const scanned = scannedRoutes ? new Set(scannedRoutes) : null;
  return {
    unexpected: failing.filter((f) => !allowedKeys.has(key(f.route, f.rule))),
    allowed: failing.filter((f) => allowedKeys.has(key(f.route, f.rule))),
    stale: allowlist.filter((e) => (!scanned || scanned.has(e.route)) && !seen.has(key(e.route, e.rule))),
  };
}

/**
 * Read the allowlist file's JSON. It's `{ "//": "...", "entries": [...] }`; the
 * "//" key is its comment. Throws on a malformed entry, so a typo can't
 * silently allow nothing.
 */
export function parseAllowlist(json: unknown): AllowlistEntry[] {
  const entries = (json as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error('allowlist: expected { "entries": [...] }');
  return entries.map((e, i) => {
    const { route, rule, task, note } = (e ?? {}) as Record<string, unknown>;
    if (typeof route !== "string" || typeof rule !== "string" || typeof task !== "string") {
      throw new Error(`allowlist entry ${i}: needs string "route", "rule" and "task" (got ${JSON.stringify(e)})`);
    }
    return { route, rule, task, ...(typeof note === "string" ? { note } : {}) };
  });
}

/** Escape a value for a markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A markdown table of findings, most severe first — the baseline report's body. */
export function reportTable(findings: Finding[]): string {
  const rank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const rows = [...findings].sort((a, b) =>
    (rank[a.impact ?? "minor"]! - rank[b.impact ?? "minor"]!) || a.rule.localeCompare(b.rule) || a.route.localeCompare(b.route));
  return [
    "| Impact | Rule | Route | Elements | What | First element |",
    "|---|---|---|---|---|---|",
    ...rows.map((f) => `| ${f.impact ?? "?"} | ${f.rule} | ${f.route} | ${f.nodes} | ${cell(f.help)} | ${f.example ? `\`${cell(f.example)}\`` : ""} |`),
  ].join("\n");
}

/**
 * axe's page-structure rules (best practice, not WCAG-tagged, so axe rates them
 * moderate). The scan runs them too and promotes their violations to serious:
 * the UI promises one h1, one main, headings in order and uniquely labelled
 * landmarks on every route (docs/ACCESSIBILITY.md "Structure").
 */
export const STRUCTURE_RULES = [
  "page-has-heading-one", "heading-order", "landmark-one-main", "landmark-no-duplicate-main",
  "landmark-main-is-top-level", "landmark-unique",
] as const;

/** What the scan reads off a loaded page for `structureFindings`. */
export interface PageFacts {
  /** Rendered (not display:none) `<h1>`s, visually hidden ones included. */
  h1s: number;
  /** `<main>` / `role=main` landmarks. */
  mains: number;
  title: string;
  /** The name of what the first Tab from a fresh load focuses. */
  firstTab: string | null;
}

/** The title every route must have: `<page> · <team> · Pizza Team` (ui/src/lib/page-title.ts). */
const TITLE_SHAPE = /^.+ · .+ · Pizza Team$/;

/**
 * The structure promises the scan checks by hand, as failing (serious)
 * findings: exactly one h1 and one main, a page-specific title, and "Skip to
 * content" as the first tab stop.
 */
export function structureFindings(route: string, facts: PageFacts): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, help: string) => out.push({ route, rule, impact: "serious", nodes: 1, help });
  if (facts.h1s !== 1) add("mpt-one-h1", `A page has exactly one h1 (found ${facts.h1s})`);
  if (facts.mains !== 1) add("mpt-one-main", `A page has exactly one main landmark (found ${facts.mains})`);
  if (!TITLE_SHAPE.test(facts.title)) add("mpt-page-title", `The title is "<page> · <team> · Pizza Team" (got "${facts.title}")`);
  if (facts.firstTab !== "Skip to content") add("mpt-skip-link", `The first Tab reaches "Skip to content" (got ${JSON.stringify(facts.firstTab)})`);
  return out;
}

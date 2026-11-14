/**
 * tests/e2e/phone-routes.test.ts — the phone view's smoke test: every `/m`
 * route (and every desktop page the phone view reuses) renders, in a real
 * browser, without a page error, an unexpected `console.error`, or a blank page.
 *
 * Why: `/m/teammates/:id` rendered a blank page from v0.37.0 through 0.40.x. It
 * reuses the desktop TeammatePage, whose header's PageHelpButton called
 * `useSideDock()` — which throws outside SideDockProvider, and the phone shell
 * (ui/src/mobile/MobileShell) has no side dock. The a11y scan
 * (tests/a11y/routes.test.ts) visits a few phone routes but no teammate page,
 * and doesn't fail on page errors, so nothing caught it. This does.
 *
 * It lives in the e2e suite (`npm run test:e2e`), not the a11y harness: it
 * needs seeded agents and work, not the a11y fixture team, it should run on
 * every change (the a11y scan is slow and opt-in), and it's a different gate —
 * "it renders at all" rather than WCAG findings.
 *
 * A real daemon (tests/e2e/_sandbox.ts, its own port) serves the built UI
 * (ui/dist — built first when stale, tests/e2e/_ui.ts). One teammate is
 * registered through the agent API, with one finished run (so the Inbox has a
 * row) and one in progress (so its live view has work), plus a note.
 * Playwright's Chromium (playwright-core; the browser from ~/.cache/ms-playwright
 * — the test skips without it), one browser for every route.
 *
 * **The routes are derived from the sources**, so a new one is covered without
 * touching this file:
 *
 *   - phone: every bottom tab (ui/src/lib/mobile.ts `MOBILE_TAB_PATHS`), the
 *     guide (ui/src/lib/help.ts `MOBILE_HELP_ROOT`, and one topic), and every
 *     `useMatch(…)` / `<Route path=…>` pattern under ui/src/mobile/ — loaded as
 *     an iPhone 13;
 *   - desktop, at desktop size: every App.tsx route whose page component
 *     ui/src/mobile/ imports from `@/pages/…` (the pages the phone view reuses),
 *     plus EXTRA_DESKTOP_ROUTES.
 *
 * A `:param` is filled from SAMPLE_PARAMS by the path segment before it (e.g.
 * `teammates/:id` → the seeded teammate); a new kind of parameter fails the test
 * until it's given a sample there. `PHONE_ROUTES=/m,/m/chat` loads only those.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, devices, type BrowserContext, type ConsoleMessage } from "playwright-core";
import { assert } from "../_assert.ts";
import { sandbox, type Sandbox } from "./_sandbox.ts";
import { ensureUiBuilt, hasChromium } from "./_ui.ts";
import { MOBILE_ROOT, MOBILE_TAB_PATHS } from "../../ui/src/lib/mobile.ts";
import { MOBILE_HELP_ROOT } from "../../ui/src/lib/help.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_SRC = path.join(REPO, "ui", "src");

const TEAMMATE = { id: "smoke-ripley", name: "Ripley" };
/** The guide topic loaded at `/m/help/:topic` and `/help/:topic`. */
const HELP_TOPIC = "phone";

/**
 * Desktop pages a phone user reaches that aren't imported by ui/src/mobile/ (so
 * the derivation can't see them), each with why.
 */
const EXTRA_DESKTOP_ROUTES = [
  // The Inbox's "Open full" (mobile/MobileInbox, lib/work-item-link `workItemPath`) opens a standalone run's page.
  "/work-defs/:id",
];

/**
 * `console.error`s that aren't a fault, each with why. Matched against the
 * message text. Keep it short: an entry hides real failures of the same shape.
 */
const CONSOLE_ALLOWLIST: Array<{ pattern: RegExp; reason: string }> = [];

interface Route { path: string; phone: boolean; /** Text the page's main must show (the seeded entity's name). */ expect?: string }

/** The values the seeded team gives each `<segment>/:<param>`. */
interface Samples { teammate: string; note: string; workDef: string; workDefTitle: string }

/** `segment/:param` → [value, the text the page then shows (optional)]. */
function sampleParams(s: Samples): Record<string, [string, string?]> {
  return {
    "teammates/:id": [s.teammate, TEAMMATE.name],
    "thoughts/:id": [s.note, "Smoke note"],
    "help/:topic": [HELP_TOPIC],
    "work-defs/:id": [s.workDef, s.workDefTitle],
  };
}

/** Every `.tsx` file under ui/src/mobile/, as [file, source]. */
function mobileSources(): Array<[string, string]> {
  const dir = path.join(UI_SRC, "mobile");
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".tsx"))
    .map((f) => { const p = path.join(f.parentPath, f.name); return [path.relative(REPO, p), fs.readFileSync(p, "utf8")]; });
}

/** Resolve a route pattern's `${MOBILE_…}` constants (the ones ui/src/mobile/ builds its paths from). */
function resolveConstants(pattern: string, where: string): string {
  const out = pattern
    .replaceAll("${MOBILE_ROOT}", MOBILE_ROOT)
    .replaceAll("${MOBILE_HELP_ROOT}", MOBILE_HELP_ROOT)
    .replace(/\$\{MOBILE_TAB_PATHS\.(\w+)\}/g, (_, tab: string) => {
      const p = (MOBILE_TAB_PATHS as Record<string, string>)[tab];
      if (!p) throw new Error(`${where}: unknown MOBILE_TAB_PATHS.${tab}`);
      return p;
    });
  if (out.includes("${")) throw new Error(`${where}: can't resolve the route pattern \`${pattern}\` — teach tests/e2e/phone-routes.test.ts its constant`);
  return out;
}

/** The phone view's route patterns: the tabs, the guide, and every pattern matched under ui/src/mobile/. */
function phonePatterns(): string[] {
  const patterns = new Set<string>([...Object.values(MOBILE_TAB_PATHS), MOBILE_HELP_ROOT, `${MOBILE_HELP_ROOT}/:topic`]);
  for (const [file, src] of mobileSources()) {
    for (const m of src.matchAll(/useMatch\(\s*`([^`]+)`|<Route\s+path=\{`([^`]+)`\}|<Route\s+path="([^"]+)"/g)) {
      patterns.add(resolveConstants(m[1] ?? m[2] ?? m[3]!, file));
    }
  }
  return [...patterns];
}

/** The desktop routes whose page components ui/src/mobile/ reuses (App.tsx's `<Route path=… element={<Page`), plus the extras. */
function reusedDesktopPatterns(): string[] {
  const pages = new Set<string>();
  for (const [, src] of mobileSources()) {
    for (const m of src.matchAll(/from\s+"@\/pages\/(\w+)"/g)) pages.add(m[1]!);
  }
  const app = fs.readFileSync(path.join(UI_SRC, "App.tsx"), "utf8");
  const patterns = new Set<string>(EXTRA_DESKTOP_ROUTES);
  // An element may be wrapped (`<FeatureRoute …><Page />`): the page is the last component named in it.
  for (const m of app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{(.*?)\}\s*\/>/g)) {
    const components = [...m[2]!.matchAll(/<(\w+)/g)].map((c) => c[1]!);
    if (components.some((c) => pages.has(c))) patterns.add(m[1]!);
  }
  return [...patterns];
}

/** A pattern with its `:params` filled in from the samples. */
function fill(pattern: string, phone: boolean, samples: Record<string, [string, string?]>): Route {
  let expect: string | undefined;
  const filled = pattern.replace(/([^/]+)\/:(\w+)/g, (whole: string, segment: string, param: string) => {
    const sample = samples[`${segment}/:${param}`];
    if (!sample) throw new Error(`no sample value for \`${whole}\` (in ${pattern}): add one to sampleParams in tests/e2e/phone-routes.test.ts`);
    expect = sample[1] ?? expect;
    return `${segment}/${encodeURIComponent(sample[0])}`;
  });
  return { path: filled, phone, expect };
}

async function api<T = any>(sb: Sandbox, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${sb.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null as T;
}

/** Create a standalone WorkDef and have the teammate claim its run; returns the def and the run's id. */
async function claimNew(sb: Sandbox, title: string): Promise<{ def: { id: string; title: string }; item: string }> {
  const { workDef } = await api(sb, "/api/work-defs", { title, goal: "Smoke-test seed", acceptanceCriteria: "-", directory: sb.projectDir });
  const { workItem } = await api(sb, `/api/agents/next-work?agentId=${TEAMMATE.id}`);
  assert(workItem, `no READY run for ${title}`);
  await api(sb, `/api/agents/claim/${workItem.id}`, { agentId: TEAMMATE.id });
  return { def: workDef, item: workItem.id };
}

/** Seed the team: a teammate with a finished run (an Inbox row) and one in progress, and a note. */
async function seed(sb: Sandbox): Promise<Samples> {
  await api(sb, "/api/agents/register", { id: TEAMMATE.id, name: TEAMMATE.name, directory: sb.projectDir });
  const done = await claimNew(sb, "Smoke: a finished run");
  await api(sb, `/api/agents/comments/${done.item}`, { agentId: TEAMMATE.id, body: "Done: the smoke test's finished run." });
  await api(sb, `/api/agents/work-items/${done.item}/state`, { agentId: TEAMMATE.id, state: "COMPLETE" });
  await claimNew(sb, "Smoke: a run in progress");
  const { thought } = await api(sb, "/api/thoughts", { content: "# Smoke note\n\n- [ ] check the phone view" });
  return { teammate: TEAMMATE.id, note: thought.id, workDef: done.def.id, workDefTitle: done.def.title };
}

/** Load `route` in `context`; return what went wrong (nothing, if it rendered). */
async function problemsLoading(context: BrowserContext, base: string, route: Route): Promise<string[]> {
  const problems: string[] = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (!CONSOLE_ALLOWLIST.some((a) => a.pattern.test(text))) problems.push(`console.error: ${text}`);
  });
  try {
    await page.goto(`${base}${route.path}`, { waitUntil: "load" });
    await page.waitForSelector("#root > *", { state: "attached", timeout: 5000 }).catch(() => {});
    // Let the first fetches land (SSE and polls keep the network busy, so don't insist).
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    // Page scripts are strings: this file type-checks for Node, without the DOM lib.
    const facts = await page.evaluate(`({
      root: document.querySelector("#root")?.innerText.trim().length ?? 0,
      h1: [...document.querySelectorAll("h1")].some((h) => h.textContent.trim()),
      main: document.querySelector("main")?.innerText ?? "",
    })`) as { root: number; h1: boolean; main: string };
    if (!facts.root) problems.push("blank page: #root has no text");
    if (!facts.h1) problems.push("no h1 with text");
    if (!facts.main.trim()) problems.push("<main> has no text");
    else if (route.expect && !facts.main.includes(route.expect)) problems.push(`<main> doesn't show "${route.expect}"`);
  } finally {
    await page.close();
  }
  return problems.map((p) => `${route.path} (${route.phone ? "phone" : "desktop"}): ${p}`);
}

test("phone view: every /m route, and every desktop page it reuses, renders without errors", { skip: !hasChromium() && "Playwright's Chromium isn't installed", timeout: 300_000 }, async () => {
  ensureUiBuilt();
  await using sb = await sandbox("phone-routes");
  sb.writeTeamConfig({ minTeammates: 0, tmuxSession: sb.session });
  await sb.startDaemon("source");
  const base = `http://127.0.0.1:${sb.port}`;
  const samples = sampleParams(await seed(sb));

  let routes: Route[] = [
    ...phonePatterns().map((p) => fill(p, true, samples)),
    ...reusedDesktopPatterns().map((p) => fill(p, false, samples)),
  ];
  // The derivation found the page that started this (a guard against the regexes quietly matching nothing).
  for (const must of [`${MOBILE_ROOT}/teammates/${TEAMMATE.id}`, `/teammates/${TEAMMATE.id}`]) {
    assert(routes.some((r) => r.path === must), `route derivation missed ${must}: ${routes.map((r) => r.path).join(", ")}`);
  }
  const only = process.env["PHONE_ROUTES"]?.split(",").map((s) => s.trim()).filter(Boolean);
  if (only?.length) routes = routes.filter((r) => only.includes(r.path));
  console.log(`phone-routes: loading ${routes.map((r) => `${r.path}${r.phone ? "" : " (desktop)"}`).join(", ")}`);

  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    for (const route of routes) problems.push(...await problemsLoading(route.phone ? phone : desktop, base, route));
  } finally {
    await browser.close();
  }
  if (problems.length) throw new Error(`phone-view smoke test failed:\n  ${problems.join("\n  ")}`);
});

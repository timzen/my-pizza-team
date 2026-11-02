/**
 * tests/a11y/routes.test.ts — the accessibility scan: axe-core over the web UI's
 * main routes, desktop and phone (`npm run test:a11y`; docs/ACCESSIBILITY.md).
 *
 * Starts a real daemon (tests/e2e/_sandbox.ts) on a temp copy of
 * tests/fixtures/a11y-team — the mpt-demo-team's team fixture without its
 * plugins: the "Add User Authentication" story, a pending story, a Solitary and
 * a Scheduled WorkDef — plus a few notes posted through the API. The daemon
 * serves the built UI (ui/dist; the npm script builds it first). Playwright's
 * Chromium (playwright-core, with the browser in ~/.cache/ms-playwright —
 * `npx playwright-core install chromium` if it's missing) loads each route and
 * @axe-core/playwright scans it against the WCAG 2.2 A/AA rules.
 *
 * What fails is tests/a11y/_gate.ts's rule: a serious or critical violation not
 * in tests/a11y/allowlist.json, or an allowlist entry that's been fixed. Every
 * finding, of any impact, goes into a markdown report (its path is printed;
 * `A11Y_REPORT=<file>` to choose it) — the baseline in docs/ACCESSIBILITY.md
 * came from it. `A11Y_ROUTES=/help,/m` scans only those routes.
 *
 * Each route is scanned in the default light theme; the desktop routes again
 * in dark (Chromium's `prefers-color-scheme: dark`, which ThemeToggle follows),
 * for `color-contrast` only — named "<path> (dark)". On every route the scan
 * also checks the page structure (tests/a11y/_gate.ts `STRUCTURE_RULES`, run
 * through axe and promoted to serious, plus `structureFindings`: one h1, one
 * main, a page-specific title, the skip link first), and then a few keyboard
 * walks check where focus goes on a route change (`keyboardProblems`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { sandbox } from "../e2e/_sandbox.ts";
import {
  type Finding, type Impact, type PageFacts, STRUCTURE_RULES, gate, parseAllowlist, reportTable, structureFindings,
} from "./_gate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(REPO, "tests", "fixtures", "a11y-team");
const ALLOWLIST = path.join(HERE, "allowlist.json");

/** The WCAG 2.0–2.2 A and AA rule tags — the target is WCAG 2.2 AA. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

interface Route {
  /** The name findings and the allowlist use. */
  name: string;
  path: string;
  phone?: boolean;
  /** The dark-theme pass: color-contrast only. */
  dark?: boolean;
}

/** Every scanned route. Phone routes are named "<path> (phone)". */
const ROUTES: Route[] = [
  ...[
    "/", "/queue", "/thoughts",
    "/work/board", "/work/tasks", "/work/schedule", "/work/pending", "/work/archived",
    "/task/add-user-auth/add-user-auth-1", "/story/add-user-auth",
    "/work-defs/audit-project-dependencies", "/work-defs/nightly-test-run",
    "/config", "/config/teammates", "/config/sources", "/config/workflows", "/config/workflows/default",
    "/config/personas", "/config/triage", "/config/theme",
    "/help", "/usage",
  ].map((p) => ({ name: p, path: p })),
  ...["/m", "/m/chat", "/m/thoughts", "/m/inbox"].map((p) => ({ name: `${p} (phone)`, path: p, phone: true })),
];

/** The dark-theme pass over every desktop route. */
const DARK_ROUTES: Route[] = ROUTES.filter((r) => !r.phone).map((r) => ({ name: `${r.path} (dark)`, path: r.path, dark: true }));

/** The routes A11Y_ROUTES names (by path — both themes — or by name), or all of them. */
function selectedRoutes(): Route[] {
  const all = [...ROUTES, ...DARK_ROUTES];
  const only = process.env["A11Y_ROUTES"]?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!only?.length) return all;
  const picked = all.filter((r) => only.includes(r.path) || only.includes(r.name));
  if (!picked.length) throw new Error(`A11Y_ROUTES matched no route: ${only.join(", ")}`);
  return picked;
}

/** Copy the fixture team into `teamDir`, pointing its work at `projectDir`. */
function copyFixtureTeam(teamDir: string, projectDir: string, tmuxSession: string): void {
  fs.cpSync(FIXTURE, teamDir, { recursive: true });
  for (const file of fs.readdirSync(teamDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const p = path.join(file.parentPath, file.name);
    const text = fs.readFileSync(p, "utf8");
    if (text.includes("__DEMO_PROJECT__")) fs.writeFileSync(p, text.replaceAll("__DEMO_PROJECT__", projectDir));
  }
  // The sandbox's private tmux server and session, never the fixture's name.
  const configPath = path.join(teamDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, tmuxSession }, null, 2));
}

/** axe's violations as findings for `route`; `promote` rates them all serious (STRUCTURE_RULES). */
function toFindings(route: Route, violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"], promote = false): Finding[] {
  return violations.map((v) => ({
    route: route.name,
    rule: v.id,
    impact: promote ? "serious" : (v.impact ?? null) as Impact | null,
    nodes: v.nodes.length,
    help: v.help,
    example: v.nodes[0]?.target.join(" "),
  }));
}

/** Open `path` and wait for the SPA to render its data. */
async function load(context: BrowserContext, base: string, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  // The SPA renders after its first fetches; give polling a moment to settle
  // so the scan sees the populated page, not the loading state.
  await page.waitForSelector("#root > *", { state: "attached" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { /* a poll kept it busy; scan anyway */ });
  await page.waitForTimeout(500);
  return page;
}

/** Load `route` in `context` and return its findings: axe's, and (light theme) the structure checks. */
async function scan(context: BrowserContext, base: string, route: Route): Promise<Finding[]> {
  const page = await load(context, base, route.path);
  try {
    if (route.dark) {
      return toFindings(route, (await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()).violations);
    }
    const findings = toFindings(route, (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations);
    findings.push(...toFindings(route, (await new AxeBuilder({ page }).withRules([...STRUCTURE_RULES]).analyze()).violations, true));
    // Page scripts are strings: this file type-checks for Node, without the DOM lib.
    const facts = await page.evaluate(`({
      h1s: [...document.querySelectorAll("h1")].filter((h) => h.getClientRects().length > 0).length,
      mains: document.querySelectorAll("main, [role=main]").length,
      title: document.title,
    })`) as Omit<PageFacts, "firstTab">;
    await page.keyboard.press("Tab");
    const firstTab = await page.evaluate(`document.activeElement?.textContent?.trim() ?? null`) as string | null;
    findings.push(...structureFindings(route.name, { ...facts, firstTab }));
    return findings;
  } finally {
    await page.close();
  }
}

/** The focused element's tag and text, e.g. "H1 Help". */
async function focused(page: Page): Promise<string> {
  const el = "document.activeElement";
  return page.evaluate(`((${el}?.tagName ?? "") + " " + (${el}?.textContent?.trim() ?? "")).trim()`) as Promise<string>;
}

/**
 * Keyboard walks (docs/ACCESSIBILITY.md "Focus is always visible and never
 * lost"): activating a nav link moves focus to the new page's h1; a route tab
 * keeps it on the (new) active tab; the skip link lands on the h1; a confirm
 * opens on Cancel and Esc gives focus back to the button that asked. Returns
 * what went wrong, in words.
 */
async function keyboardProblems(context: BrowserContext, base: string): Promise<string[]> {
  const problems: string[] = [];
  const expect = (what: string, got: string, want: string) => { if (got !== want) problems.push(`${what}: focus on "${got}", expected "${want}"`); };
  const page = await load(context, base, "/work/board");
  try {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    expect("skip link", await focused(page), "H1 Work");

    await page.getByRole("link", { name: "Help", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/help");
    await page.waitForTimeout(300);
    expect("NavBar link to Help", await focused(page), "H1 Help");

    await page.goto(`${base}/work/board`);
    await page.waitForSelector("nav[aria-label='Work sections']");
    await page.locator("nav[aria-label='Work sections']").getByRole("link", { name: "Tasks" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/work/tasks");
    await page.waitForTimeout(300);
    expect("Work tab to Tasks", await focused(page), "A Tasks");

    await page.goto(`${base}/story/add-user-auth`);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    // Esc cancels, so nothing is deleted.
    const remove = page.getByRole("button", { name: "Delete story" });
    if (await remove.count()) {
      await remove.focus();
      const asker = await focused(page);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[role=alertdialog]");
      expect("confirm dialog opens on", await focused(page), "BUTTON Cancel");
      await page.keyboard.press("Escape");
      await page.waitForSelector("[role=alertdialog]", { state: "detached" });
      expect("confirm dialog closes back to", await focused(page), asker);
    } else {
      problems.push("confirm dialog: no Delete story button on /story/add-user-auth to try it with");
    }
  } finally {
    await page.close();
  }
  return problems;
}

test("the web UI's main routes have no unexpected serious or critical axe violations", { timeout: 600_000 }, async () => {
  const uiIndex = path.join(REPO, "ui", "dist", "index.html");
  if (!fs.existsSync(uiIndex)) throw new Error("ui/dist is missing: run `npm run ui:build` (npm run test:a11y does)");
  const allowlist = parseAllowlist(JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")));
  const routes = selectedRoutes();

  await using sb = await sandbox("a11y");
  copyFixtureTeam(sb.teamDir, sb.projectDir, sb.session);
  await sb.startDaemon("source");
  const base = `http://127.0.0.1:${sb.port}`;
  for (const content of ["# Ideas\n\n- [ ] Try the phone view", "Ship the **accessibility** story"]) {
    const r = await fetch(`${base}/api/thoughts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    if (!r.ok) throw new Error(`seeding a note: ${r.status} ${await r.text()}`);
  }

  let browser: Browser | undefined;
  const findings: Finding[] = [];
  let keyboard: string[] = [];
  try {
    browser = await chromium.launch();
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const phone = await browser.newContext({ ...devices["iPhone 13"], colorScheme: "light" });
    for (const route of routes) findings.push(...await scan(route.phone ? phone : route.dark ? dark : desktop, base, route));
    // The keyboard walks only on a full run (a partial one is for debugging a route).
    if (!process.env["A11Y_ROUTES"]) keyboard = await keyboardProblems(desktop, base);
  } finally {
    await browser?.close();
  }

  const result = gate(findings, allowlist, routes.map((r) => r.name));
  const reportPath = process.env["A11Y_REPORT"] ?? path.join(os.tmpdir(), "mpt-a11y-report.md");
  fs.writeFileSync(reportPath, [
    `# Accessibility scan — ${routes.length} routes, ${findings.length} findings`,
    "",
    `Failing (serious/critical): ${result.unexpected.length + result.allowed.length}, ` +
      `allowlisted: ${result.allowed.length}, unexpected: ${result.unexpected.length}, stale allowlist entries: ${result.stale.length}`,
    "",
    `Keyboard walks: ${keyboard.length ? keyboard.map((k) => `\n- ${k}`).join("") : "all as expected"}`,
    "",
    reportTable(findings),
    "",
  ].join("\n"));
  console.log(`a11y report: ${reportPath}`);

  const problems: string[] = [
    ...result.unexpected.map((f) => `  ${f.impact} ${f.rule} on ${f.route} (${f.nodes} element(s)): ${f.help}`),
    ...result.stale.map((e) => `  stale allowlist entry (fixed? remove it from tests/a11y/allowlist.json): ${e.rule} on ${e.route}`),
    ...keyboard.map((k) => `  keyboard: ${k}`),
  ];
  if (problems.length) throw new Error(`accessibility scan failed — see ${reportPath}:\n${problems.join("\n")}`);
});

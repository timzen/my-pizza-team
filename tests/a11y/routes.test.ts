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
 * Only the default (light) theme is scanned.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, devices, type Browser, type BrowserContext } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { sandbox } from "../e2e/_sandbox.ts";
import { type Finding, type Impact, gate, parseAllowlist, reportTable } from "./_gate.ts";

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

/** The routes A11Y_ROUTES names (by path), or all of them. */
function selectedRoutes(): Route[] {
  const only = process.env["A11Y_ROUTES"]?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!only?.length) return ROUTES;
  const picked = ROUTES.filter((r) => only.includes(r.path) || only.includes(r.name));
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

/** Load `route` in `context` and return axe's findings for it. */
async function scan(context: BrowserContext, base: string, route: Route): Promise<Finding[]> {
  const page = await context.newPage();
  try {
    await page.goto(`${base}${route.path}`, { waitUntil: "load" });
    // The SPA renders after its first fetches; give polling a moment to settle
    // so the scan sees the populated page, not the loading state.
    await page.waitForSelector("#root > *", { state: "attached" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { /* a poll kept it busy; scan anyway */ });
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    return results.violations.map((v) => ({
      route: route.name,
      rule: v.id,
      impact: (v.impact ?? null) as Impact | null,
      nodes: v.nodes.length,
      help: v.help,
      example: v.nodes[0]?.target.join(" "),
    }));
  } finally {
    await page.close();
  }
}

test("the web UI's main routes have no unexpected serious or critical axe violations", { timeout: 300_000 }, async () => {
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
  try {
    browser = await chromium.launch();
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    for (const route of routes) findings.push(...await scan(route.phone ? phone : desktop, base, route));
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
    reportTable(findings),
    "",
  ].join("\n"));
  console.log(`a11y report: ${reportPath}`);

  const problems: string[] = [
    ...result.unexpected.map((f) => `  ${f.impact} ${f.rule} on ${f.route} (${f.nodes} element(s)): ${f.help}`),
    ...result.stale.map((e) => `  stale allowlist entry (fixed? remove it from tests/a11y/allowlist.json): ${e.rule} on ${e.route}`),
  ];
  if (problems.length) throw new Error(`accessibility scan failed — see ${reportPath}:\n${problems.join("\n")}`);
});

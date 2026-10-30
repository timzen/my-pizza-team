/**
 * tests/tabbed-layout.test.ts — Guards the fix for the Work and
 * Configuration headers jumping between tabs: every tab page must frame itself
 * with the shared TabbedPageLayout (ui/src/components/TabbedPageLayout.tsx)
 * and must not set its own centered/padded outer container (`container`,
 * `mx-auto`), which would move the title and tab bar again. A source-level
 * check, since the UI has no DOM test harness.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assert } from "./_assert.ts";

const read = (path: string) => fs.promises.readFile(new URL(`../ui/src/${path}`, import.meta.url), "utf8");

const WORK_ITEMS_PAGES = ["BoardPage", "TasksPage", "SchedulePage", "LifecyclePage"];

test("Work tabs render inside WorkItemsLayout with no own centered container", async () => {
  for (const page of WORK_ITEMS_PAGES) {
    const src = await read(`pages/${page}.tsx`);
    assert(src.includes("<WorkItemsLayout"), `${page} should use WorkItemsLayout`);
    assert(!/container mx-auto|mx-auto/.test(src), `${page} should not center its own container`);
  }
  assert((await read("components/WorkItemsTabs.tsx")).includes("<TabbedPageLayout"));
});

test("Config tabs (incl. embedded Workflows/Personas pages) render inside TabbedPageLayout, left-aligned", async () => {
  const config = await read("pages/ConfigPage.tsx");
  assert(config.includes("<TabbedPageLayout"), "ConfigPage should use TabbedPageLayout");
  assert(!config.includes("mx-auto"), "ConfigPage should not center its body");
  assert(config.includes("<FeatureOffNotice feature=\"stories\" embedded />"), "embedded notice stays left-aligned");
  for (const page of ["WorkflowsPage", "WorkflowDetailPage", "PersonasPage"]) {
    assert(!(await read(`pages/${page}.tsx`)).includes("mx-auto"), `${page} is embedded; it must not center itself`);
  }
});

test("TabbedPageLayout keeps the header independent of the body width", async () => {
  const src = await read("components/TabbedPageLayout.tsx");
  const outer = src.match(/data-testid="tabbed-page"/);
  assert(outer, "outer frame present");
  assert(!src.includes('className="container') && !/className="[^"]*mx-auto/.test(src), "frame is never centered");
});

test("WorkDef/Task detail pages use DetailPageLayout with a tab-independent header width", async () => {
  for (const page of ["WorkDefDetailPage", "TaskDetailPage"]) {
    const src = await read(`pages/${page}.tsx`);
    assert(src.includes("<DetailPageLayout"), `${page} should use DetailPageLayout`);
    assert(src.includes("<DetailPageMessage"), `${page}'s not-found state should use the same frame`);
    assert(!src.includes("mx-auto"), `${page} must not center its container`);
    const header = src.match(/headerClassName=(\{[^}]*\}|"[^"]*")/);
    assert(header, `${page} sets a constant header width`);
    assert(!/\btab\b/.test(header[1] ?? ""), `${page}'s header width must not depend on the active tab`);
  }
  // The per-tab width lives on the body only (Triage two-column vs. Details/Thread).
  const workDef = await read("pages/WorkDefDetailPage.tsx");
  assert(/bodyClassName=\{tab === "triage" \? "max-w-6xl" : "max-w-3xl"\}/.test(workDef), "per-tab width is on the body");
});

test("DetailPageLayout header classes don't take a per-tab input other than headerClassName", async () => {
  const src = await read("components/TabbedPageLayout.tsx");
  assert(src.includes("export function DetailPageLayout"));
  assert(/<header className=\{`space-y-4 \$\{headerClassName\}`\}/.test(src), "header width comes only from headerClassName");
  assert(!/className=[^>]*mx-auto/.test(src), "frame is never centered");
});

/**
 * tests/tabbed-layout.test.ts — Guards the fix for the Work Items and
 * Configuration headers jumping between tabs: every tab page must frame itself
 * with the shared TabbedPageLayout (ui/src/components/TabbedPageLayout.tsx)
 * and must not set its own centered/padded outer container (`container`,
 * `mx-auto`), which would move the title and tab bar again. A source-level
 * check, since the UI has no DOM test harness.
 */

import { assert } from "@std/assert";

const read = (path: string) => Deno.readTextFile(new URL(`../ui/src/${path}`, import.meta.url));

const WORK_ITEMS_PAGES = ["BoardPage", "TasksPage", "SchedulePage", "LifecyclePage"];

Deno.test("Work Items tabs render inside WorkItemsLayout with no own centered container", async () => {
  for (const page of WORK_ITEMS_PAGES) {
    const src = await read(`pages/${page}.tsx`);
    assert(src.includes("<WorkItemsLayout"), `${page} should use WorkItemsLayout`);
    assert(!/container mx-auto|mx-auto/.test(src), `${page} should not center its own container`);
  }
  assert((await read("components/WorkItemsTabs.tsx")).includes("<TabbedPageLayout"));
});

Deno.test("Config tabs (incl. embedded Workflows/Context pages) render inside TabbedPageLayout, left-aligned", async () => {
  const config = await read("pages/ConfigPage.tsx");
  assert(config.includes("<TabbedPageLayout"), "ConfigPage should use TabbedPageLayout");
  assert(!config.includes("mx-auto"), "ConfigPage should not center its body");
  assert(config.includes("<FeatureOffNotice feature=\"stories\" embedded />"), "embedded notice stays left-aligned");
  for (const page of ["WorkflowsPage", "WorkflowDetailPage", "ContextPage"]) {
    assert(!(await read(`pages/${page}.tsx`)).includes("mx-auto"), `${page} is embedded; it must not center itself`);
  }
});

Deno.test("TabbedPageLayout keeps the header independent of the body width", async () => {
  const src = await read("components/TabbedPageLayout.tsx");
  const outer = src.match(/data-testid="tabbed-page"/);
  assert(outer, "outer frame present");
  assert(!src.includes('className="container') && !/className="[^"]*mx-auto/.test(src), "frame is never centered");
});

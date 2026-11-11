/**
 * tests/workflows-ui.test.ts — The workflow pages' delete rules
 * (ui/src/lib/workflows.ts): Delete disabled with a reason for the default or
 * the last workflow, and the confirm dialog's done-story fallback count.
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { workflowDeleteBlockedReason, workflowDeleteDescription } from "../ui/src/lib/workflows.ts";

test("workflowDeleteBlockedReason: the default and the last workflow are blocked, others allowed", () => {
  assert(workflowDeleteBlockedReason({ isDefault: true, workflowCount: 3 })!.includes("default"));
  assert(workflowDeleteBlockedReason({ isDefault: false, workflowCount: 1 })!.includes("only workflow"));
  assertEquals(workflowDeleteBlockedReason({ isDefault: false, workflowCount: 2 }), null);
});

test("workflowDeleteDescription: names the backup and counts the done stories that fall back", () => {
  assert(workflowDeleteDescription("default", 0).includes("No done stories use it."));
  assert(workflowDeleteDescription("default", 1).includes("1 done story uses it and will fall back to the default workflow (default)."));
  assert(workflowDeleteDescription("main", 3).includes("3 done stories use it and will fall back to the default workflow (main)."));
  assert(workflowDeleteDescription("main", 0).includes("workflows/.deleted/"));
});

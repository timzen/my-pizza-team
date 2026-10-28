/**
 * tests/prompt.test.ts — Verifies the canonical prompt assembly for a WorkDef
 * (optional board framing: state persona + story; see docs/DESIGN.md "WorkDefs & Parents").
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { buildWorkDefPrompt } from "../daemon/prompt.ts";

test("buildWorkDefPrompt: assembles board sections in order", () => {
  const out = buildWorkDefPrompt({
    workDef: { title: "Auth module", goal: "Task desc.", acceptanceCriteria: "The API MUST work." },
    story: { id: "auth", title: "Add Auth", description: "Story desc.", directory: "/tmp/proj" },
    state: "in_progress",
    persona: "## Implementer\n- write the code",
    comments: [
      { from: "lead", body: "Please add tests.", at: "t" },
      { from: "someone-else", body: "ignored", at: "t" },
    ],
  });

  // Role (persona) first, then Story → Directory → Task → Goal → AC → lead → completion.
  const iRole = out.indexOf("## Your Role: in_progress");
  const iStory = out.indexOf("## Story: Add Auth");
  const iDir = out.indexOf("## Working Directory");
  const iTask = out.indexOf("## Task: Auth module");
  const iGoal = out.indexOf("## Goal");
  const iAccept = out.indexOf("## Acceptance Criteria");
  const iLead = out.indexOf("## Comments from Team Lead");
  const iDone = out.indexOf("## Completing This Work");
  assertEquals(iRole >= 0 && iRole < iStory, true);
  assertEquals(iStory < iDir && iDir < iTask && iTask < iGoal && iGoal < iAccept && iAccept < iLead && iLead < iDone, true);

  // Persona headings are demoted so they nest under the Role section.
  assertStringIncludes(out, "### Implementer");
  assertStringIncludes(out, "write the code");

  // Directory instruction includes cd + AGENTS.md guidance.
  assertStringIncludes(out, "/tmp/proj");
  assertStringIncludes(out, "AGENTS.md");

  // Only lead comments are surfaced.
  assertStringIncludes(out, "> Please add tests.");
  assertEquals(out.includes("ignored"), false);

  // Workers never move tasks: completion guidance says so.
  assertStringIncludes(out, "advances automatically");
});

test("buildWorkDefPrompt: default role framing when the state has no persona", () => {
  const out = buildWorkDefPrompt({
    workDef: { title: "T", goal: "D", acceptanceCriteria: "" },
    state: "coding",
  });
  assertStringIncludes(out, "## Your Role: coding");
  assertStringIncludes(out, "'coding' state");
});

test("buildWorkDefPrompt: standalone work omits board sections cleanly", () => {
  const out = buildWorkDefPrompt({
    workDef: { title: "T", goal: "D", acceptanceCriteria: "" },
  });
  assertEquals(out.includes("## Your Role:"), false);
  assertEquals(out.includes("## Story:"), false);
  assertEquals(out.includes("## Working Directory"), false);
  assertEquals(out.includes("## Comments from Team Lead"), false);
  assertStringIncludes(out, "## Task: T");
  assertStringIncludes(out, "## Goal");
  assertStringIncludes(out, "## Completing This Work");
});

test("buildWorkDefPrompt: injects attached reference context", () => {
  const out = buildWorkDefPrompt({
    workDef: { title: "T", goal: "D", acceptanceCriteria: "" },
    contextEntries: [
      { title: "Coding Standards", content: "Always write tests." },
      { title: "API Conventions", content: "# Heading\n\nUse REST." },
    ],
  });
  assertStringIncludes(out, "## Reference Context");
  assertStringIncludes(out, "### Coding Standards");
  assertStringIncludes(out, "Always write tests.");
  assertStringIncludes(out, "### API Conventions");
  // Entry headings are demoted so they nest beneath the `###` entry title.
  assertStringIncludes(out, "#### Heading");
});

test("buildWorkDefPrompt: omits reference context when none attached", () => {
  const out = buildWorkDefPrompt({
    workDef: { title: "T", goal: "D", acceptanceCriteria: "" },
    contextEntries: [],
  });
  assertEquals(out.includes("## Reference Context"), false);
});

test("buildWorkDefPrompt: a comment from the WorkDef page (\"you\") reaches the teammate", () => {
  // WorkDefDetailPage posts as "you", TaskDetailPage as "lead". Filtering on "lead"
  // alone silently dropped "commit these changes" from a re-run's prompt.
  const out = buildWorkDefPrompt({
    workDef: { title: "T", goal: "G.", acceptanceCriteria: "" },
    comments: [
      { from: "you", body: "Looks good, commit these changes", at: "t" },
      { from: "sharp-gaius", body: "[done] Work complete.", at: "t" },
    ],
  });
  assertStringIncludes(out, "## Comments from Team Lead");
  assertStringIncludes(out, "> Looks good, commit these changes");
  assertEquals(out.includes("[done] Work complete."), false);
});

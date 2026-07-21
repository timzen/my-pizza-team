/**
 * tests/prompt.test.ts — Verifies the canonical task prompt assembly
 * (state persona + story/task context; see docs/WORK-MODEL.md).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildTaskPrompt } from "../daemon/prompt.ts";

Deno.test("buildTaskPrompt: assembles sections in order", () => {
  const out = buildTaskPrompt({
    story: { id: "auth", title: "Add Auth", description: "Story desc.", directory: "/tmp/proj" },
    task: { id: "auth-1", storyId: "auth", title: "Auth module", description: "Task desc." },
    state: "in_progress",
    persona: "## Implementer\n- write the code",
    previousResults: "[Earlier]: done",
    comments: [
      { from: "lead", body: "Please add tests.", at: "t" },
      { from: "someone-else", body: "ignored", at: "t" },
    ],
  });

  // Role (persona) first, then Story → Directory → Task → prev → comments → completion.
  const iRole = out.indexOf("## Your Role: in_progress");
  const iStory = out.indexOf("## Story: Add Auth");
  const iDir = out.indexOf("## Working Directory");
  const iTask = out.indexOf("## Task: Auth module");
  const iPrev = out.indexOf("## Context from previous tasks");
  const iLead = out.indexOf("## Comments from Team Lead");
  const iDone = out.indexOf("## Completing This Task");
  assertEquals(iRole >= 0 && iRole < iStory, true);
  assertEquals(iStory < iDir && iDir < iTask && iTask < iPrev && iPrev < iLead && iLead < iDone, true);

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
  assertStringIncludes(out, "the task advances automatically");
  assertEquals(out.includes("release the task"), false);
});

Deno.test("buildTaskPrompt: default role framing when the state has no persona", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    state: "coding",
  });
  assertStringIncludes(out, "## Your Role: coding");
  assertStringIncludes(out, "'coding' state");
});

Deno.test("buildTaskPrompt: omits optional sections cleanly", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    state: "work",
  });
  assertEquals(out.includes("## Story:"), false);
  assertEquals(out.includes("## Working Directory"), false);
  assertEquals(out.includes("## Context from previous tasks"), false);
  assertEquals(out.includes("## Comments from Team Lead"), false);
  assertStringIncludes(out, "## Task: T");
  assertStringIncludes(out, "## Completing This Task");
});

Deno.test("buildTaskPrompt: injects attached reference context", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    state: "work",
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

Deno.test("buildTaskPrompt: omits reference context when none attached", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    state: "work",
    contextEntries: [],
  });
  assertEquals(out.includes("## Reference Context"), false);
});

/**
 * tests/prompt.test.ts — Verifies the canonical task prompt assembly.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildTaskPrompt } from "../daemon/prompt.ts";

Deno.test("buildTaskPrompt: assembles sections in order", () => {
  const out = buildTaskPrompt({
    story: { id: "auth", title: "Add Auth", description: "Story desc." },
    task: { id: "auth-1", storyId: "auth", title: "Auth module", description: "Task desc." },
    guidance: "You are entering the 'in_progress' state. When your work is complete, release the task and it will advance to 'review'.",
    transition: { fromState: "review", toState: "in_progress", exit: "REVIEW EXIT NOTES", enter: "## On Enter\n- do the thing" },
    previousResults: "[Earlier]: done",
    comments: [
      { from: "lead", body: "Please add tests.", at: "t" },
      { from: "someone-else", body: "ignored", at: "t" },
    ],
  });

  // Story precedes Task, which precedes context/comments/state.
  const iStory = out.indexOf("## Story: Add Auth");
  const iTask = out.indexOf("## Task: Auth module");
  const iPrev = out.indexOf("## Context from previous tasks");
  const iLead = out.indexOf("## Comments from Team Lead");
  const iState = out.indexOf("## State Context");
  const iInstr = out.indexOf("### Instructions:");
  assertEquals(iStory >= 0 && iStory < iTask, true);
  assertEquals(iTask < iPrev && iPrev < iLead && iLead < iState && iState < iInstr, true);

  // Only lead comments are surfaced.
  assertStringIncludes(out, "> Please add tests.");
  assertEquals(out.includes("ignored"), false);

  // Both leaving (exit) and entering (enter) instructions are surfaced, nested
  // under State Context as `###`.
  assertStringIncludes(out, "### Instructions: review");
  assertStringIncludes(out, "REVIEW EXIT NOTES");
  assertStringIncludes(out, "### Instructions: in_progress");
  assertStringIncludes(out, "do the thing");
  // The enter file's `## On Enter` is demoted to `#### On Enter` (nested under ###).
  assertStringIncludes(out, "#### On Enter");

  // No session-specific framing in the canonical prompt.
  assertEquals(out.includes("Ignore any task IDs"), false);
});

Deno.test("buildTaskPrompt: skips exit instructions on a same-state re-claim", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    guidance: "You are entering the 'coding' state.",
    transition: { fromState: "coding", toState: "coding", exit: "CODING FILE", enter: "CODING FILE" },
  });
  // Leaving/entering are the same state — show the instructions once.
  assertStringIncludes(out, "### Instructions: coding");
  assertEquals(out.split("### Instructions: coding").length - 1, 1);
  assertEquals(out.split("CODING FILE").length - 1, 1);
});

Deno.test("buildTaskPrompt: omits optional sections cleanly", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    guidance: "You are entering the 'todo' state. When your work is complete, release the task.",
  });
  assertEquals(out.includes("## Story:"), false);
  assertEquals(out.includes("## Context from previous tasks"), false);
  assertEquals(out.includes("## Comments from Team Lead"), false);
  assertEquals(out.includes("### Instructions:"), false);
  assertStringIncludes(out, "## Task: T");
  assertStringIncludes(out, "## State Context");
});

Deno.test("buildTaskPrompt: injects attached reference context", () => {
  const out = buildTaskPrompt({
    task: { id: "x-1", storyId: "x", title: "T", description: "D" },
    guidance: "g",
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
    guidance: "g",
    contextEntries: [],
  });
  assertEquals(out.includes("## Reference Context"), false);
});

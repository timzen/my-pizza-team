/**
 * tests/workflow-lint.test.ts — Instruction markdown linting + normalization.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { validateInstructionMarkdown } from "../daemon/workflow-lint.ts";
import { normalizeInstructionMarkdown } from "../daemon/prompt.ts";

test("validate: unbalanced code fence is an error", () => {
  const r = validateInstructionMarkdown("Do this:\n\n```bash\nnpm test");
  assertEquals(r.errors.length, 1);
});

test("validate: balanced fences are fine", () => {
  const r = validateInstructionMarkdown("Run:\n\n```bash\nnpm test\n```\n");
  assertEquals(r.errors.length, 0);
});

test("validate: shallow headings + thematic break are warnings, not errors", () => {
  const r = validateInstructionMarkdown("# Title\n\n## Section\n\n---\n\ntext");
  assertEquals(r.errors.length, 0);
  assertEquals(r.warnings.length, 2); // shallow heading + '---'
});

test("validate: '#' inside a code fence is not treated as a heading", () => {
  const r = validateInstructionMarkdown("```sh\n# a shell comment\n```\n### Real heading\n");
  assertEquals(r.errors.length, 0);
  assertEquals(r.warnings.length, 0);
});

test("normalize: demotes headings so the shallowest becomes level 3", () => {
  const out = normalizeInstructionMarkdown("# On Enter\n\ntext\n\n## Exit Criteria\n- x");
  assertEquals(out.includes("### On Enter"), true);
  assertEquals(out.includes("#### Exit Criteria"), true);
});

test("normalize: leaves already-deep headings and fenced '#' untouched", () => {
  const src = "### Already deep\n\n```sh\n# not a heading\n```\n";
  assertEquals(normalizeInstructionMarkdown(src), src);
});

test("normalize: no-op when there are no headings", () => {
  const src = "just some text\n- a bullet\n";
  assertEquals(normalizeInstructionMarkdown(src), src);
});

/**
 * tests/workflow-lint.test.ts — Instruction markdown linting + normalization.
 */

import { assertEquals } from "@std/assert";
import { validateInstructionMarkdown } from "../daemon/workflow-lint.ts";
import { normalizeInstructionMarkdown } from "../daemon/prompt.ts";

Deno.test("validate: unbalanced code fence is an error", () => {
  const r = validateInstructionMarkdown("Do this:\n\n```bash\nnpm test");
  assertEquals(r.errors.length, 1);
});

Deno.test("validate: balanced fences are fine", () => {
  const r = validateInstructionMarkdown("Run:\n\n```bash\nnpm test\n```\n");
  assertEquals(r.errors.length, 0);
});

Deno.test("validate: shallow headings + thematic break are warnings, not errors", () => {
  const r = validateInstructionMarkdown("# Title\n\n## Section\n\n---\n\ntext");
  assertEquals(r.errors.length, 0);
  assertEquals(r.warnings.length, 2); // shallow heading + '---'
});

Deno.test("validate: '#' inside a code fence is not treated as a heading", () => {
  const r = validateInstructionMarkdown("```sh\n# a shell comment\n```\n### Real heading\n");
  assertEquals(r.errors.length, 0);
  assertEquals(r.warnings.length, 0);
});

Deno.test("normalize: demotes headings so the shallowest becomes level 3", () => {
  const out = normalizeInstructionMarkdown("# On Enter\n\ntext\n\n## Exit Criteria\n- x");
  assertEquals(out.includes("### On Enter"), true);
  assertEquals(out.includes("#### Exit Criteria"), true);
});

Deno.test("normalize: leaves already-deep headings and fenced '#' untouched", () => {
  const src = "### Already deep\n\n```sh\n# not a heading\n```\n";
  assertEquals(normalizeInstructionMarkdown(src), src);
});

Deno.test("normalize: no-op when there are no headings", () => {
  const src = "just some text\n- a bullet\n";
  assertEquals(normalizeInstructionMarkdown(src), src);
});

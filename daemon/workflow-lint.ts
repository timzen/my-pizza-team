/**
 * daemon/workflow-lint.ts — Validation for workflow state instruction files.
 *
 * Instruction markdown is authored by users and embedded verbatim into the
 * agent prompt (see prompt.ts). This lints authored content so a mistake can't
 * mangle the assembled prompt:
 *
 *  - errors   → block the save (they genuinely break prompt structure)
 *  - warnings → allow the save but inform the author
 *
 * Heading depth is only a warning because the prompt builder normalizes
 * (demotes) headings when embedding; the warning just nudges better authoring.
 */

export interface InstructionLintResult {
  errors: string[];
  warnings: string[];
}

const FENCE = /^\s*(```+|~~~+)/;

/** Lint a workflow instruction markdown file. */
export function validateInstructionMarkdown(md: string): InstructionLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = md.split("\n");

  // Unbalanced code fences are the one thing that truly mangles the prompt:
  // an odd number swallows every following prompt section into a code block.
  let fenceCount = 0;
  for (const line of lines) if (FENCE.test(line)) fenceCount++;
  if (fenceCount % 2 !== 0) {
    errors.push(
      `Unbalanced code fence: found ${fenceCount} \`\`\` / ~~~ markers (expected an even number). ` +
      `An unclosed fence would swallow the rest of the agent prompt.`,
    );
  }

  // Warnings — allowed, but flagged.
  if (md.trim().length === 0) {
    warnings.push("Instructions are empty.");
  }

  // Shallow headings get demoted when embedded; nudge authors toward ### or deeper.
  let inFence = false;
  let hasShallowHeading = false;
  let hasThematicBreak = false;
  for (const line of lines) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{1,2}\s/.test(line)) hasShallowHeading = true;
    if (/^\s*---\s*$/.test(line)) hasThematicBreak = true;
  }
  if (hasShallowHeading) {
    warnings.push(
      "Top-level headings (`#` / `##`) are demoted to `###`+ when embedded in the agent prompt. " +
      "Use `###` or deeper to keep your intended structure.",
    );
  }
  if (hasThematicBreak) {
    warnings.push(
      "A `---` horizontal rule can read as a section separator in the assembled prompt. " +
      "Consider removing it or using a heading instead.",
    );
  }

  return { errors, warnings };
}

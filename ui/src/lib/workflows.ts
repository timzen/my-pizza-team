/**
 * lib/workflows.ts — The workflow pages' delete rules, as pure functions
 * (tested in tests/workflows-ui.test.ts).
 *
 * The daemon has the final say (DELETE /api/workflows/:name refuses the default,
 * the last workflow, and one an open story uses, with a 409); these only decide
 * what the Delete button shows before you ask: disabled with a reason for the
 * default or last workflow, and the confirm dialog's note on the done stories
 * that will fall back to the team's default workflow.
 */

/** Why Delete is disabled (its tooltip), or null when it's allowed to ask. */
export function workflowDeleteBlockedReason(opts: { isDefault: boolean; workflowCount: number }): string | null {
  if (opts.isDefault) return "The team's default workflow can't be deleted. Make another workflow the default first.";
  if (opts.workflowCount <= 1) return "The only workflow can't be deleted.";
  return null;
}

/** The confirm dialog's description: where the folder goes, and how many done stories fall back. */
export function workflowDeleteDescription(defaultWorkflow: string, doneStories: number): string {
  const backup = "Its folder moves to workflows/.deleted/ (a backup you can restore by hand).";
  if (doneStories === 0) return `${backup} No done stories use it.`;
  const n = doneStories === 1 ? "1 done story uses" : `${doneStories} done stories use`;
  return `${backup} ${n} it and will fall back to the default workflow (${defaultWorkflow}).`;
}

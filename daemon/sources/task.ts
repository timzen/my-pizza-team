/**
 * daemon/sources/task.ts — The built-in Solitary-task Work Source.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" and
 * "Pending: Write, Review, Activate".
 *
 * A Solitary task is a WorkDef with no parent: it runs when the author says so
 * (**Run**, or creating it with enqueue on) and when a pending one is activated.
 * It has no timer and nothing to do on terminal; it is eligible while it exists,
 * runs where it says, and uses the base prompt. Its rules are also the daemon's
 * defaults for a kind that doesn't implement a hook (`runSolitary` is the
 * default `run`).
 */

import type { WorkDef, WorkItem } from "../../shared/types.ts";
import { listTemplates } from "../store/templates.ts";
import { TASK_SOURCE_ID } from "./registry.ts";
import { plural } from "./toggle.ts";
import type { ActiveSourceItems, RunResult, SourceContext, WorkSource } from "./types.ts";

/**
 * **Run**: refuse a pending def (activate it first) or one already in flight;
 * otherwise enqueue a READY item now.
 */
export function runSolitary(def: WorkDef, ctx: SourceContext): RunResult {
  if (def.pending) {
    return { ok: false, conflict: true, error: "This WorkDef is pending; activate it before running it" };
  }
  const item = ctx.hasActiveItem(def.id) ? null : ctx.enqueue(def.id);
  return item ? { ok: true, workItem: item } : { ok: false, error: "Unknown WorkDef, or one is already in flight" };
}

/**
 * Activation: enqueue, as creating it would have done — unless the caller asked
 * not to (`enqueue: false`), it's archived, or an item is already in flight.
 */
function activateSolitary(def: WorkDef, opts: { enqueue?: boolean }, ctx: SourceContext): WorkItem | null {
  if (opts.enqueue === false || def.status === "archived") return null;
  if (ctx.hasActiveItem(def.id)) return null;
  return ctx.enqueue(def.id);
}

/**
 * What blocks switching Tasks off: non-archived Solitary WorkDefs and every
 * Template (templates are molds for Solitary tasks, so the Tasks toggle owns them).
 */
function activeTasks(ctx: SourceContext): ActiveSourceItems {
  const defs = ctx.listWorkDefs().filter((d) => !d.parent && d.status !== "archived").length;
  const templates = listTemplates(ctx.teamDir).length;
  const parts = [
    ...(defs > 0 || templates === 0 ? [plural(defs, "task", "tasks")] : []),
    ...(templates > 0 ? [plural(templates, "template", "templates")] : []),
  ];
  return { count: defs + templates, description: parts.join(" and ") };
}

/** The built-in Solitary source. */
export const taskSource: WorkSource = {
  id: TASK_SOURCE_ID,
  apiVersion: 1,
  // `features.tasks`; Templates ride along (docs/DESIGN.md "Feature Toggles").
  toggle: { feature: "tasks", routes: ["/api/templates", "/api/templates/*"], activeItems: activeTasks },
  // A standalone WorkDef wants doing for as long as it exists.
  isEligible: () => true,
  onActivate: activateSolitary,
  run: runSolitary,
};

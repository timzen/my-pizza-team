/**
 * daemon/sources/toggle.ts — Helpers for a source's on/off switch (`SourceToggle`).
 * See docs/DESIGN.md "Feature Toggles".
 *
 * Plugin-agnostic, like the rest of daemon/sources: the gate itself lives in
 * daemon/features.ts; this is just what a source needs to describe its
 * active items.
 */

import type { TeamConfig } from "../../shared/types.ts";
import type { ActiveSourceItems, SourceContext, SourceToggle } from "./types.ts";
import { sourceIdForWorkDef } from "./registry.ts";

/** "1 story" / "3 stories". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Count this source's non-archived WorkDefs (pending included), worded with
 * `one`/`many`. The default `activeItems` for a toggleable source.
 */
export function activeWorkDefs(ctx: SourceContext, one = "item", many = "items"): ActiveSourceItems {
  const count = ctx.listWorkDefs().filter((d) => sourceIdForWorkDef(d) === ctx.sourceId && d.status !== "archived").length;
  return { count, description: plural(count, one, many) };
}

/**
 * Is a source switched off right now? Only a source with a toggle can be, and
 * only by an explicit `false` under `config.features` (missing = on). Read per
 * call from the live config, so a Config-page change applies at once.
 */
export function isSourceSwitchedOff(config: Pick<TeamConfig, "features">, toggle: SourceToggle | null | undefined): boolean {
  if (!toggle) return false;
  return (config.features as Record<string, boolean | undefined> | undefined)?.[toggle.feature] === false;
}

// Offering `wait_for_next_check` only where the daemon accepts a wait.
//
// A poll state's check may end with "not yet" (my-pizza-team docs/DESIGN.md
// "Polling States"); anywhere else the daemon refuses a wait. The tool is
// registered once per session (tools.ts) but kept out of the *active* set — the
// tools declared to the model — until a claim says `completion: "poll"`
// (teammate.ts), and taken out again for any other claim.
//
// Type-only imports on purpose: like features.ts, this module loads standalone
// under Node's type stripping, which is what lets tests import it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The wait tool's name. */
export const WAIT_TOOL = "wait_for_next_check";

/**
 * Offer (`on`) or withdraw the wait tool. Only calls `setActiveTools` on a
 * change, because each one is recorded in the transcript; never activates it
 * before it is registered.
 */
export function setWaitToolActive(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools">,
  on: boolean,
): void {
  const current = pi.getActiveTools();
  const has = current.includes(WAIT_TOOL);
  if (on === has) return;
  if (on && !pi.getAllTools().some((t) => t.name === WAIT_TOOL)) return;
  pi.setActiveTools(on ? [...current, WAIT_TOOL] : current.filter((t) => t !== WAIT_TOOL));
}

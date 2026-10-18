// Feature toggles on the Pi side: which leader tools each work-item kind owns,
// and keeping Pi's active tool set in step with the team's `config.features`.
//
// A team can switch Stories, Tasks (incl. Templates), and Schedules off
// (my-pizza-team docs/DESIGN.md "Feature Toggles"). The daemon refuses a
// disabled kind's routes (403); this module makes the leader not *offer* those
// tools in the first place:
//
//   - Every leader tool is registered once at startup (Pi can't unregister), and
//     `applyFeatureTools` adds or removes the gated ones from the *active* set
//     (`pi.setActiveTools`) — the set declared to the model. Pi appends the change
//     to the transcript before the next model request, so it applies mid-session.
//   - The leader re-applies it on session start, before every run, and on its
//     status poll (leader.ts), so a Config-page change reaches the model without
//     restarting Pi. Between polls the daemon's 403 is the backstop, and the
//     client turns it into `featureDisabledMessage`'s wording.
//   - `featurePromptNote` tells the model which kinds are off, so it explains
//     rather than improvises when the user asks for one.
//
// Type-only imports on purpose: like runtime/client.ts, this module loads
// standalone under Node's type stripping, which is what lets tests import it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeatureName, Features } from "./runtime/client.js";

/**
 * The leader tools each kind owns. `list_workflows` and `list_context` only feed
 * `create_story` / `add_task` (workflows and context attach to story work), so
 * they go with Stories.
 */
export const FEATURE_TOOLS: Readonly<Record<FeatureName, readonly string[]>> = {
  stories: ["create_story", "edit_story", "add_task", "list_workflows", "list_context"],
  tasks: ["create_task"],
  schedules: ["create_schedule"],
};

/**
 * Tools that work on a WorkDef of any kind (board task, Solitary, Scheduled):
 * active while at least one kind is on. The daemon still refuses a def whose own
 * kind is off.
 */
export const ANY_FEATURE_TOOLS: readonly string[] = ["get_task", "edit_task", "publish_task"];

/** Every tool this module may switch off. Everything else is never touched. */
export function gatedToolNames(): string[] {
  return [...Object.values(FEATURE_TOOLS).flat(), ...ANY_FEATURE_TOOLS];
}

/** The gated tools that should be active for these toggles. */
export function enabledGatedTools(features: Features): Set<string> {
  const on = new Set<string>();
  for (const [feature, tools] of Object.entries(FEATURE_TOOLS) as [FeatureName, readonly string[]][]) {
    if (features[feature]) for (const t of tools) on.add(t);
  }
  if (features.stories || features.tasks || features.schedules) for (const t of ANY_FEATURE_TOOLS) on.add(t);
  return on;
}

/**
 * The active tool list for these toggles: `current` with the disabled gated tools
 * removed and the enabled ones that are `registered` added back. Order is kept,
 * and tools outside `gatedToolNames()` pass through untouched.
 */
export function activeToolsFor(current: readonly string[], features: Features, registered: readonly string[]): string[] {
  const gated = new Set(gatedToolNames());
  const on = enabledGatedTools(features);
  const next = current.filter((t) => !gated.has(t) || on.has(t));
  for (const t of registered) {
    if (on.has(t) && !next.includes(t)) next.push(t);
  }
  return next;
}

/**
 * Bring Pi's active tool set in line with the toggles. Only calls
 * `setActiveTools` when something changes, because every change is recorded in
 * the transcript (and can invalidate the provider's cached prefix).
 * @returns whether the active set changed
 */
export function applyFeatureTools(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools">,
  features: Features,
): boolean {
  const current = pi.getActiveTools();
  const next = activeToolsFor(current, features, pi.getAllTools().map((t) => t.name));
  const same = next.length === current.length && next.every((t) => current.includes(t));
  if (same) return false;
  pi.setActiveTools(next);
  return true;
}

const FEATURE_TITLES: Record<FeatureName, string> = { stories: "Stories", tasks: "Tasks (and Templates)", schedules: "Schedules" };

/**
 * A system-prompt paragraph naming the kinds that are off, or "" when all are on.
 * Static tool guidelines can mention a disabled tool (e.g. "use create_story +
 * add_task for multi-step work"); this tells the model those don't exist here.
 */
export function featurePromptNote(features: Features): string {
  const off = (Object.keys(FEATURE_TITLES) as FeatureName[]).filter((f) => !features[f]);
  if (off.length === 0) return "";
  const names = off.map((f) => FEATURE_TITLES[f]).join(", ");
  const keys = off.map((f) => `features.${f}`).join(", ");
  return [
    "## Turned-off work items",
    "",
    `This team has switched off: ${names}. Their tools are unavailable and the daemon refuses them. ` +
      "Don't offer or attempt to create, edit, or propose work of those kinds, even where another tool's guidance " +
      `mentions them. If the user asks for one, say it's turned off and can be enabled in Config → General → Work items (${keys}).` +
      (off.length === 3 ? " With everything off, help through Thoughts and the Context library." : ""),
  ].join("\n");
}

/** The triage proposal kinds (`propose_work`) and the kind each would create. */
const PROPOSAL_FEATURE: Record<string, FeatureName> = { task: "tasks", "story-task": "stories", story: "stories", schedule: "schedules" };

/**
 * The feature a triage proposal of this kind would create work in, matching
 * my-pizza-team daemon/features.ts `featureForProposalKind`.
 */
export function featureForProposalKind(kind: string): FeatureName | null {
  return PROPOSAL_FEATURE[kind] ?? null;
}

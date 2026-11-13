// The active persona's tool and skill scope (frontmatter `tools` and `skills`).
//
// A persona may narrow what its agent can use (my-pizza-team docs/DESIGN.md
// "Persona settings"): `tools: { allow, deny }` (tool names or `*` patterns) and
// `skills: [names]`. The daemon delivers them with the persona — in the claim
// for a teammate, with the assistant persona for the leader — and this module
// is how the Pi harness enforces them. Absent fields change nothing.
//
//   - Tools: `applyTools` sets Pi's *active* set (what is declared to the model)
//     before every run (`before_agent_start`) to the tools the persona permits,
//     and `checkToolCall` blocks anything else in `tool_call` as defence in
//     depth — including a call another tool makes (codemode's nested calls carry
//     `parentToolCallId`), since a codemode-exposed tool is callable whether or
//     not it is active. The persona only *narrows*: it never turns on a tool that
//     was off. MPT's own protocol tools (`MPT_PROTOCOL_TOOLS`) are always kept,
//     whatever the persona says — a teammate must be able to report, fail or
//     wait — and their presence stays under their own managers (features.ts for
//     the leader's, wait-tool.ts for the poll tool), which this never touches.
//   - Restore: the tools a persona took away are remembered (`baseline`) and put
//     back on the first run with no tool policy — the item ended, or the next
//     persona has none — and a persona change is computed from that baseline,
//     never from the previous persona's narrowed set.
//   - Skills: `filterSkills` trims this run's `systemPromptOptions.skills` (a
//     per-run copy) so only the persona's skills are listed in the system prompt,
//     and `checkSkillCommand` refuses `/skill:<name>` for any other skill (Pi's
//     `input` event sees it before expansion). The skill files stay on disk: a
//     model that reads one by path isn't stopped — the listing and the command
//     are what's scoped.
//   - Reporting: `scopeProblems` names what can't be applied as written (a
//     pattern that matches no tool, a skill that isn't loaded, a protocol tool
//     the persona tried to deny); the caller posts it once per work item.
//
// Type-only imports on purpose: like wait-tool.ts, this module loads standalone
// under Node's type stripping, which is what lets tests import it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersonaToolPolicy } from "./shared/agent-protocol.js";

/**
 * MPT's protocol tools — every tool this extension registers (tools.ts): the
 * teammate's (report, fail, propose, wait) and the leader's (work, thoughts,
 * status). A persona can't take these away (docs/DESIGN.md "Persona settings").
 * The one list; tests check it against tools.ts.
 */
export const MPT_PROTOCOL_TOOLS: readonly string[] = [
  // Teammate
  "upload_attachment", "fail", "propose_work", "wait_for_next_check",
  // Leader
  "create_story", "edit_story", "add_task", "create_task", "create_schedule", "set_schedule_pending",
  "get_task", "edit_task", "activate_task", "list_workflows", "list_personas", "team_status",
  "list_thought_groups", "list_thoughts", "get_thought", "create_thought", "edit_thought",
  "archive_thought", "group_thoughts",
];

const PROTOCOL = new Set(MPT_PROTOCOL_TOOLS);

/** True for a tool a persona can never take away. */
export function isProtocolTool(name: string): boolean {
  return PROTOCOL.has(name);
}

/** The slice of a persona this module reads: its id and its `tools` / `skills` settings. */
export interface ScopedPersona {
  id: string | null;
  tools?: PersonaToolPolicy;
  skills?: string[];
}

/** How a persona is named in reports and block reasons. */
export function personaName(persona: Pick<ScopedPersona, "id">): string {
  return persona.id ?? "(unnamed)";
}

/** Does `name` match `pattern`, where `*` is any run of characters (the only glob syntax)? */
export function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * May a persona with this tool policy use `name`? Protocol tools: always. No
 * policy or no `allow`: every tool; `allow` present: only matching ones (empty =
 * none). `deny` wins over `allow`.
 */
export function isToolPermitted(name: string, policy: PersonaToolPolicy | undefined): boolean {
  if (isProtocolTool(name) || !policy) return true;
  if (policy.allow && !policy.allow.some((p) => matchesPattern(name, p))) return false;
  return !(policy.deny ?? []).some((p) => matchesPattern(name, p));
}

/**
 * What of a persona's `tools` / `skills` can't be applied as written, one line
 * each ("persona X: tools.allow pattern 'foo*' matched no tools"): a pattern
 * that matches no `registered` tool, a protocol tool named in `deny` (ignored),
 * a skill that isn't among `loadedSkills` (pass undefined when unknown).
 */
export function scopeProblems(persona: ScopedPersona, registered: readonly string[], loadedSkills?: readonly string[]): string[] {
  const who = `persona ${personaName(persona)}`;
  const out: string[] = [];
  for (const field of ["allow", "deny"] as const) {
    for (const pattern of persona.tools?.[field] ?? []) {
      if (!registered.some((t) => matchesPattern(t, pattern))) {
        out.push(`${who}: tools.${field} pattern '${pattern}' matched no tools`);
      } else if (field === "deny" && registered.some((t) => isProtocolTool(t) && matchesPattern(t, pattern))) {
        out.push(`${who}: tools.deny pattern '${pattern}' can't remove MPT's protocol tools; they stay available`);
      }
    }
  }
  if (persona.skills && loadedSkills) {
    for (const skill of persona.skills) {
      if (!loadedSkills.includes(skill)) out.push(`${who}: skill '${skill}' is not loaded`);
    }
  }
  return out;
}

/**
 * Trim `skills` in place to the persona's `allowed` names (undefined = all kept).
 * Mutating is how a `before_agent_start` handler edits the run's skill listing.
 */
export function filterSkills(skills: Array<{ name: string }>, allowed: readonly string[] | undefined): void {
  if (!allowed) return;
  for (let i = skills.length - 1; i >= 0; i--) {
    if (!allowed.includes(skills[i]!.name)) skills.splice(i, 1);
  }
}

/** The parts of a `tool_call` event this needs (`parentToolCallId`: a nested call, e.g. from codemode). */
export interface ToolCallLike {
  toolName: string;
  parentToolCallId?: string;
}

/**
 * The `tool_call` verdict for this persona: a block with a reason naming the
 * persona, or undefined to let the call run.
 */
export function checkToolCall(persona: ScopedPersona | null, event: ToolCallLike): { block: true; reason: string } | undefined {
  if (!persona?.tools || isToolPermitted(event.toolName, persona.tools)) return undefined;
  const via = event.parentToolCallId ? " (called from another tool)" : "";
  return {
    block: true,
    reason: `Tool '${event.toolName}'${via} is not available to persona ${personaName(persona)}: its tools policy doesn't allow it. ` +
      "Do the work with the tools you have, or use fail if you can't.",
  };
}

/**
 * The `input` verdict for `/skill:<name>`: a transform that tells the model the
 * skill isn't available to this persona (so the skill isn't expanded, and a chat
 * still gets an answer), or undefined to let the input through.
 */
export function checkSkillCommand(persona: ScopedPersona | null, text: string): { action: "transform"; text: string } | undefined {
  if (!persona?.skills) return undefined;
  const m = /^\/skill:(\S+)/.exec(text);
  if (!m || persona.skills.includes(m[1]!)) return undefined;
  const allowed = persona.skills.length ? persona.skills.join(", ") : "none";
  return {
    action: "transform",
    text: `(The skill '${m[1]}' was requested, but persona ${personaName(persona)} may not use it; its skills: ${allowed}. Say so instead of using it.)`,
  };
}

/** The tool-set calls this needs from Pi. */
export type ToolSetApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/**
 * Pi's active tool set under a persona's tool policy, with the tools it took
 * away remembered so they can be put back (see the file header).
 */
export class PersonaToolScope {
  private readonly pi: ToolSetApi;
  /** The non-protocol tools active before (or added during) the scoped stretch; null while unscoped. */
  private baseline: string[] | null = null;

  constructor(pi: ToolSetApi) {
    this.pi = pi;
  }

  /** True while a tool policy is applied (some tools may be withheld). */
  get scoped(): boolean {
    return this.baseline !== null;
  }

  /**
   * Bring the active set in line with `policy` (none = restore everything a
   * policy took away). Only calls `setActiveTools` on a change, since each one
   * is recorded in the transcript. Returns the active tools after.
   */
  applyTools(policy: PersonaToolPolicy | undefined): string[] {
    const current = this.pi.getActiveTools();
    let next: string[];
    if (!policy) {
      if (!this.baseline) return current;
      next = [...current, ...this.baseline.filter((t) => !current.includes(t))];
      this.baseline = null;
    } else {
      // Anything active and not ours is part of the full set: on the first
      // scoped run that's the whole set; later, tools another extension added.
      const base = this.baseline ?? [];
      for (const t of current) if (!isProtocolTool(t) && !base.includes(t)) base.push(t);
      this.baseline = base;
      next = [
        ...current.filter((t) => isToolPermitted(t, policy)),
        ...base.filter((t) => !current.includes(t) && isToolPermitted(t, policy)),
      ];
    }
    const same = next.length === current.length && next.every((t, i) => t === current[i]);
    if (!same) this.pi.setActiveTools(next);
    return next;
  }
}

/** The parts of `before_agent_start`'s event `applyPersonaScope` reads and edits. */
export interface ScopeEvent {
  systemPromptOptions?: { selectedTools?: string[]; skills?: Array<{ name: string }> };
}

/**
 * Everything a run's `before_agent_start` does for the persona's scope: set the
 * active tools (or restore them with no persona / no policy), trim the skill
 * listing, and return what couldn't be applied (`scopeProblems`) for the caller
 * to report.
 */
export function applyPersonaScope(
  pi: Pick<ExtensionAPI, "getAllTools">,
  scope: PersonaToolScope,
  persona: ScopedPersona | null,
  event: ScopeEvent,
): string[] {
  const wasScoped = scope.scoped;
  const active = scope.applyTools(persona?.tools);
  // Keep this run's prompt options in step too: a handler that renders
  // `event.systemPrompt` (the leader's) reads the tool list from them, and Pi
  // takes an edited `selectedTools` as the run's loadout — the same set.
  const selected = event.systemPromptOptions?.selectedTools;
  if (selected && (wasScoped || scope.scoped)) selected.splice(0, selected.length, ...active);
  if (!persona) return [];
  const skills = event.systemPromptOptions?.skills;
  const problems = scopeProblems(persona, pi.getAllTools().map((t) => t.name), skills?.map((s) => s.name));
  if (persona.skills && !skills) {
    problems.push(`persona ${personaName(persona)}: skills can't be applied: this Pi doesn't expose its skill listing`);
  }
  if (skills) filterSkills(skills, persona.skills);
  return problems;
}

/**
 * Report scope problems at most once per `key` (a work item for a teammate, a
 * persona for the leader): calls `post` with them joined one per line, the
 * first time `key` has any. Returns whether it posted.
 */
export function reportScopeOnce(reported: Set<string>, key: string, problems: readonly string[], post: (text: string) => void): boolean {
  if (problems.length === 0 || reported.has(key)) return false;
  reported.add(key);
  post(problems.join("\n"));
  return true;
}

// The teammate's persona, in the system prompt.
//
// The daemon resolves the persona a claimed work item is worked in and, because
// this harness declares the `persona-system-prompt` capability at registration,
// sends it in the claim (`persona`) instead of opening the work prompt with a
// `## Your Role` block (my-pizza-team docs/DESIGN.md "The persona in the system
// prompt"). A role in a user message can be summarized away by compaction, and
// it is weaker guidance than the system prompt.
//
// The work loop (teammate.ts) holds the claim's persona for the item in hand;
// `applyPersonaSection` writes it into each run's system prompt as its own
// prompt section (`before_agent_start` `systemPromptOptions.sections`), so Pi
// patches only that section when it changes. A teammate may reuse one Pi
// session across items, so the section is set or *removed* on every run: a
// persona never outlives its work item (the loop releases it whenever an item
// ends — completed, failed, waited, failed for a retry).
//
// Type-only imports on purpose: like wait-tool.ts, this module loads standalone
// under Node's type stripping, which is what lets tests import it.

import type { ClaimPersona } from "./shared/agent-protocol.js";

/** The prompt section's key (its XML tag in the system prompt). */
export const PERSONA_SECTION = "teammate_persona";

/**
 * The text this harness adds to the system prompt for a claim's persona: the
 * daemon-rendered role block — or null when there is none, or when the daemon
 * kept it inline in the work prompt (`inline`: this harness's capability
 * wasn't honored, or a Work Source kept it), since adding it again would say
 * it twice.
 */
export function personaSystemPromptText(persona: ClaimPersona | null | undefined): string | null {
  if (!persona || persona.inline || !persona.prompt?.trim()) return null;
  return persona.prompt;
}

/** The parts of `before_agent_start`'s event this needs. */
export interface PersonaPromptEvent {
  systemPrompt: string;
  systemPromptOptions?: { sections?: Record<string, string> };
}

/**
 * Write `text` into this run's system prompt as the `PERSONA_SECTION` section,
 * or remove the section when `text` is null (no persona held — e.g. the next
 * item has none, or the item ended). Returns the `before_agent_start` result:
 * nothing when the section could be edited in place (Pi patches only it); a
 * replacement `systemPrompt` with the text appended on a Pi without prompt
 * sections.
 */
export function applyPersonaSection(event: PersonaPromptEvent, text: string | null): { systemPrompt: string } | undefined {
  const sections = event.systemPromptOptions?.sections;
  if (sections) {
    if (text) sections[PERSONA_SECTION] = text;
    else delete sections[PERSONA_SECTION];
    return undefined;
  }
  return text ? { systemPrompt: `${event.systemPrompt}\n\n${text}` } : undefined;
}

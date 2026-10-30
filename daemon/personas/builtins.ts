/**
 * daemon/personas/builtins.ts — The read-only built-in personas.
 *
 * Built-ins wrap the defaults the daemon has always used, unchanged in wording,
 * so a team that never touches personas gets byte-identical prompts
 * (docs/DESIGN.md "Ids and origins: team, built-in, package"):
 *
 * - `builtin:assistant` — `DEFAULT_ASSISTANT_PERSONA`, when no `assistant.persona` is set
 * - `builtin:triage`    — `DEFAULT_TRIAGE_INSTRUCTIONS`, when no `triage.persona` is set
 * - `builtin:worker`    — a generic worker framing; only the fallback for a worker
 *   reference that doesn't resolve, and a starting point to duplicate
 *
 * The constants are re-exported from their former homes (routes/assistant.ts,
 * prompt.ts) for the prompt tests. This module imports nothing from the daemon,
 * so either of those can import it without a cycle.
 */

import type { BuiltinPersonaId, Persona, PersonaKind } from "../../shared/types.ts";

/**
 * The default assistant persona. When no persona is selected, the daemon
 * supplies this as the assistant's system prompt so it always has role framing
 * (the harness hardcodes none). Selecting a persona replaces this entirely.
 */
export const DEFAULT_ASSISTANT_PERSONA = [
  "You are the team assistant for a \"pizza team\" \u2014 a small group of AI teammates",
  "coordinated by the my-pizza-team daemon.",
  "",
  "Help the user run the team and its work. Using your available tools you can",
  "create and edit stories, add tasks, queue requests for the team, curate the",
  "shared context library, and report team status.",
  "",
  "Keep replies concise. When you take actions, briefly summarize what you did.",
].join("\n");

/** The built-in triage instructions, used when the team selects no triage persona. */
export const DEFAULT_TRIAGE_INSTRUCTIONS = `Read the note below and help the author decide what, if anything, should become work.

Lean toward **proposing work**: concrete tasks, a story with tasks, or a scheduled job.
Be specific — a proposal should read like something a teammate could pick up without
asking questions.

Three honest outcomes, in order of preference:

1. **Proposals** — the note describes something worth doing.
2. **A question** — you need one thing from the author before you can propose anything
   useful. Ask exactly one, and say what you'd propose for each likely answer.
3. **Nothing to do** — the note is a reference, a link dump, a journal entry, or
   already-done work. Say so plainly; inventing work from a shopping list is worse
   than saying there's none.

Do not edit the note, and do not create stories, tasks, or schedules yourself — the
author decides. Keep your analysis short: what you think this note is, then your
proposals.`;

/**
 * The generic worker framing: today's one-line "You are working in the … state"
 * text, generalized so it reads correctly outside a workflow state too.
 */
export const DEFAULT_WORKER_PERSONA = `You are a teammate working on the task below. Do the work it describes, following the conventions of the project you are working in.`;

/** A built-in's definition (its id, frontmatter, and body). */
interface BuiltinDef { id: BuiltinPersonaId; title: string; description: string; kinds: PersonaKind[]; content: string }

const BUILTINS: readonly BuiltinDef[] = [
  {
    id: "builtin:worker",
    title: "Worker (built-in)",
    description: "Generic worker framing; stands in for a worker persona that doesn't resolve.",
    kinds: ["worker"],
    content: DEFAULT_WORKER_PERSONA,
  },
  {
    id: "builtin:triage",
    title: "Triage (built-in)",
    description: "The default note-triage instructions.",
    kinds: ["triage"],
    content: DEFAULT_TRIAGE_INSTRUCTIONS,
  },
  {
    id: "builtin:assistant",
    title: "Assistant (built-in)",
    description: "The default team assistant.",
    kinds: ["assistant"],
    content: DEFAULT_ASSISTANT_PERSONA,
  },
];

/** Every built-in persona, as library entries (read-only). */
export function listBuiltinPersonas(): Persona[] {
  return BUILTINS.map(toPersona);
}

/** One built-in persona by id, or null when `id` names none. */
export function getBuiltinPersona(id: string): Persona | null {
  const def = BUILTINS.find((b) => b.id === id);
  return def ? toPersona(def) : null;
}

function toPersona(def: BuiltinDef): Persona {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    tags: ["built-in"],
    kinds: [...def.kinds],
    content: def.content,
    origin: { kind: "builtin" },
    readOnly: true,
  };
}

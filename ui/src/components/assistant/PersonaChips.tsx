/**
 * PersonaChips — pick which assistant you're talking to.
 *
 * The assistant's persona comes from the persona library (Config → Personas;
 * docs/DESIGN.md "Personas"), selected by id — its body becomes the
 * assistant's system prompt. The chips are **Default** (`builtin:assistant`)
 * plus the personas suggested for the assistant (`kinds: [assistant]`), and
 * the current one if it isn't among them; **Other…** picks any other persona
 * (a hint, never a restriction). The **edit** link opens the active persona.
 *
 * Swapping is not destructive: the daemon ends the current session
 * (snapshotting it to markdown) and opens a new one, so the old conversation
 * stays resumable (docs/DESIGN.md "Assistant Chat Model").
 */

import { Link } from "react-router-dom";
import { SegmentedTabs } from "@/components/RouteTabs";
import { optionLabel, personaPath, pickerGroups, type Persona } from "@/lib/personas";

/** The built-in the "Default" chip stands for. */
export const DEFAULT_ASSISTANT_PERSONA_ID = "builtin:assistant";

interface PersonaChipsProps {
  /** The whole library (the chips show the assistant-suggested ones). */
  personas: Persona[];
  activePersonaId: string | null;
  disabled?: boolean;
  onSelect: (personaId: string | null) => void;
}

export function PersonaChips({ personas, activePersonaId, disabled, onSelect }: PersonaChipsProps) {
  const { hinted, rest } = pickerGroups(personas, "assistant", [DEFAULT_ASSISTANT_PERSONA_ID]);
  const active = activePersonaId === DEFAULT_ASSISTANT_PERSONA_ID ? null : activePersonaId;
  // The current persona always has a chip, even when it isn't suggested for the assistant.
  const chips = [...hinted, ...rest.filter((p) => p.id === active)];
  const others = rest.filter((p) => p.id !== active);

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      <SegmentedTabs
        tabs={[
          { key: null, label: "Default" },
          ...chips.map((p) => ({ key: p.id, label: p.title, title: p.description || p.title })),
        ]}
        active={active}
        disabled={disabled}
        onSelect={onSelect}
      />
      {others.length > 0 && (
        <select
          aria-label="Another persona"
          value=""
          disabled={disabled}
          onChange={(e) => e.target.value && onSelect(e.target.value)}
          className="h-7 max-w-[140px] rounded-md border border-border bg-background px-1 text-xs"
        >
          <option value="">Other…</option>
          {others.map((p) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}
        </select>
      )}
      <Link to={personaPath(active ?? DEFAULT_ASSISTANT_PERSONA_ID)} className="text-xs text-primary hover:underline" title="Open the assistant's persona">
        {active && personas.find((p) => p.id === active)?.readOnly === false ? "edit" : "view"}
      </Link>
    </div>
  );
}

/**
 * PersonaChips — pick which assistant you're talking to.
 *
 * A persona is a context-library entry tagged `persona`; its body becomes the
 * assistant's system prompt. Swapping is not destructive any more: the daemon
 * ends the current session (snapshotting it to markdown) and opens a new one, so
 * the old conversation stays resumable (docs/ASSISTANT_CHAT_V2.md §6.2).
 */

import { SegmentedTabs } from "@/components/RouteTabs";
import type { ContextEntry } from "@/lib/assistant-types";

interface PersonaChipsProps {
  personas: ContextEntry[];
  activePersonaId: string | null;
  disabled?: boolean;
  onSelect: (personaId: string | null) => void;
}

export function PersonaChips({ personas, activePersonaId, disabled, onSelect }: PersonaChipsProps) {
  if (personas.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap pt-3">
      <SegmentedTabs
        tabs={[
          { key: null, label: "Default" },
          ...personas.map((p) => ({ key: p.id, label: p.title, title: p.description || p.title })),
        ]}
        active={activePersonaId}
        disabled={disabled}
        onSelect={onSelect}
      />
    </div>
  );
}

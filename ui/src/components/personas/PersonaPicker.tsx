/**
 * PersonaPicker — Choose a persona by id from the library, with an "edit" (or
 * "view", for read-only personas) link to its page. Every place that *selects*
 * a persona uses this: workflow agent states, Triage, the Assistant, Solitary
 * and Scheduled tasks, Work Sources, and a mirrored item's override
 * (docs/DESIGN.md "References: select, don't embed").
 *
 * Personas hinted for `kind` are listed first (lib/personas.ts `pickerGroups`);
 * the rest follow — a hint, never a restriction. A selected id the library no
 * longer has stays selectable and is flagged, so saving a form never silently
 * clears a reference.
 */

import { Link } from "react-router-dom";
import { usePersonas } from "@/hooks/usePersonas";
import { missingSelection, optionLabel, personaPath, pickerGroups, type PersonaKind } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface Props {
  /** The selected persona id; null/"" = the "none" option. */
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  /** Which kind to list first. */
  kind?: PersonaKind;
  /** What the empty option means here ("No persona", "Built-in default", …). */
  noneLabel: string;
  /** Ids not offered as options (shown another way, e.g. the default). */
  exclude?: string[];
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Hide the edit/view link (when the host shows its own). */
  hideLink?: boolean;
}

export function PersonaPicker({ value, onChange, kind, noneLabel, exclude, disabled, id, className, hideLink }: Props) {
  const personas = usePersonas();
  const { hinted, rest } = pickerGroups(personas ?? [], kind, exclude);
  // A value shown another way (the default the "none" option stands for) selects "none".
  const shown = value && exclude?.includes(value) ? null : value;
  const missing = missingSelection(shown, personas);
  const selected = personas?.find((p) => p.id === shown) ?? null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <select
        id={id}
        value={shown ?? ""}
        disabled={disabled || personas === null}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 min-w-[220px] max-w-[360px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
        aria-invalid={missing !== null}
      >
        <option value="">{noneLabel}</option>
        {missing && <option value={missing}>{missing} (missing)</option>}
        {hinted.length > 0 && (
          <optgroup label={`Suggested for ${kind}`}>
            {hinted.map((p) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}
          </optgroup>
        )}
        {rest.length > 0 && (hinted.length > 0
          ? <optgroup label="Other personas">{rest.map((p) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}</optgroup>
          : rest.map((p) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>))}
      </select>
      {!hideLink && selected && (
        <Link to={personaPath(selected.id)} className="text-xs text-primary hover:underline" title={selected.description || selected.title}>
          {selected.readOnly ? "view" : "edit"}
        </Link>
      )}
      {missing && (
        <span className="flex items-center gap-1 text-xs text-amber-600" title="Runs fall back to a built-in until you pick another">
          <AlertTriangle className="h-3 w-3" />“{missing}” doesn't exist
        </span>
      )}
    </div>
  );
}

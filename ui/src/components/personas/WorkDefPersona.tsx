/**
 * WorkDefPersona — A WorkDef's **Persona** row on its Details tab: which
 * persona its runs work with, and where to change it (docs/DESIGN.md
 * "References: select, don't embed").
 *
 * - **Solitary / Scheduled**: its own optional `persona` (unset = no persona
 *   block). Every run of a schedule uses it. Saved at once with `PUT
 *   /api/work-defs/:id { persona }` — allowed after activating, because it's
 *   *how* the work is done, not *what* (a WorkDef's persona isn't part of its
 *   locked definition).
 * - **Mirrored (External)**: a person's override (`PUT
 *   /api/work-defs/:id/persona`, kept in the source's kv so re-syncs never
 *   touch it). Unset falls through to the source's suggestion for the item,
 *   then the source's persona settings on Config → Sources.
 * - **Board**: read-only — board tasks get their persona from the workflow
 *   state they're in (no per-board-task override).
 * - **Triage** (a note's triage run): read-only — Config → Triage.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { apiPut } from "@/hooks/useApi";
import { notifyPersonasChanged } from "@/hooks/usePersonas";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { Label } from "@/components/ui/label";
import type { WorkDefDefinitionData } from "@/components/WorkDefDefinition";

export function WorkDefPersona({ def, onChanged }: { def: WorkDefDefinitionData; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (url: string, body: unknown) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiPut<{ success: boolean; error?: string }>(url, body);
      if (!res.success) setError(res.error || "Couldn't save the persona");
      else { onChanged(); void notifyPersonasChanged(); }
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    }
    setSaving(false);
  };
  const id = encodeURIComponent(def.id);

  let body;
  if (def.type === "Solitary" || def.type === "Scheduled") {
    body = (
      <>
        <PersonaPicker
          id="workdef-persona"
          kind="worker"
          value={def.persona ?? null}
          onChange={(persona) => save(`/api/work-defs/${id}`, { persona })}
          noneLabel="No persona"
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground">
          How a teammate does this work{def.type === "Scheduled" ? " — every run of the schedule uses it" : ""}. Changeable any time; applies to the next run.
        </p>
      </>
    );
  } else if (def.type === "External" && def.mirror) {
    const mirror = def.mirror;
    body = (
      <>
        <PersonaPicker
          id="mirror-persona"
          kind={mirror.mode === "triage" ? "triage" : "worker"}
          value={mirror.personaOverride ?? null}
          onChange={(persona) => save(`/api/work-defs/${id}/persona`, { persona })}
          noneLabel={def.persona ? `${mirror.sourceLabel}'s suggestion (${def.persona})` : `${mirror.sourceLabel}'s setting`}
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground">
          An override for this item only, kept across syncs. Without one it uses{" "}
          {def.persona ? <>the persona {mirror.sourceLabel} suggests for it, else </> : null}
          the {mirror.mode === "triage" ? "triage " : ""}persona set for{" "}
          <Link to={`/config/sources/${encodeURIComponent(mirror.sourceId)}`} className="text-primary underline">{mirror.sourceLabel}</Link>.
        </p>
      </>
    );
  } else if (def.type === "Board") {
    body = (
      <p className="text-sm text-muted-foreground">
        From the workflow state it's in — pick state personas on{" "}
        <Link to="/config/workflows" className="text-primary underline">Workflows</Link>.
      </p>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        Note triage uses the persona set on <Link to="/config/triage" className="text-primary underline">Triage</Link>.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 pb-1 border-b border-border"><Label htmlFor="workdef-persona">Persona</Label></div>
      <div className="mt-1 space-y-1">
        {body}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * TriageSettings — Config → Triage (`/config/triage`): the auto-triage sweep's
 * settings and the note-triage persona (docs/DESIGN.md "Auto Triage"), all in
 * the page's config.json draft.
 */

import { Link } from "react-router-dom";
import type { ConfigData, ConfigDraftProps } from "@/lib/config-draft";
import { PERSONAS_TAB_PATH } from "@/lib/personas";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldHint } from "@/components/ui/field-hint";

/**
 * The Triage tab: the sweep's settings and the persona every note-triage run
 * follows (`triage.persona`; unset = `builtin:triage`), all saved with the
 * page's Save button. The persona itself is edited on Config → Personas (the
 * picker's "edit"/"view" link); this only picks which one. Triage-mode *Work
 * Sources* pick their own triage persona on Config → Sources — this one is for
 * your notes only.
 */
export function TriageSettings({ config, setConfig }: ConfigDraftProps) {
  const t = config.triage ?? {};
  const enabled = t.enabled !== false;
  const setTriage = (patch: Partial<NonNullable<ConfigData["triage"]>>) =>
    setConfig({ ...config, triage: { ...t, ...patch } });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 className="font-semibold">Auto Triage</h2>
        <p className="text-xs text-muted-foreground">
          Finished triage runs land in your Inbox; a badge on the note opens its triage page.
        </p>
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
          <Label htmlFor="triage-enabled">Enabled</Label>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                id="triage-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setTriage({ enabled: e.target.checked })}
                aria-describedby="triage-enabled-hint"
              />
              Read changed notes and propose work
            </label>
            <FieldHint id="triage-enabled-hint" field="triageEnabled" />
          </div>
          <Label htmlFor="triage-interval">Sweep Interval (min)</Label>
          <div className="space-y-1">
            <Input
              id="triage-interval"
              type="number"
              min={1}
              value={t.intervalMinutes ?? 60}
              onChange={(e) => setTriage({ intervalMinutes: Math.max(1, parseInt(e.target.value) || 60) })}
              className="max-w-[120px]"
              aria-describedby="triage-interval-hint"
            />
            <FieldHint id="triage-interval-hint" field="triageInterval" />
          </div>
          <Label htmlFor="triage-quiet">Quiet Period (min)</Label>
          <div className="space-y-1">
            <Input
              id="triage-quiet"
              type="number"
              min={0}
              value={t.quietMinutes ?? 10}
              onChange={(e) => setTriage({ quietMinutes: Math.max(0, parseInt(e.target.value) || 0) })}
              className="max-w-[120px]"
              aria-describedby="triage-quiet-hint"
            />
            <FieldHint id="triage-quiet-hint" field="triageQuiet" />
          </div>
          <Label htmlFor="triage-persona">Persona</Label>
          <div className="space-y-1">
            <PersonaPicker
              id="triage-persona"
              kind="triage"
              value={t.persona ?? null}
              // null (not undefined) so the PUT carries the clear back to the built-in.
              onChange={(persona) => setTriage({ persona })}
              noneLabel="Built-in triage (default)"
              exclude={["builtin:triage"]}
              hintId="triage-persona-hint"
            />
            <FieldHint id="triage-persona-hint" field="triagePersona" />
            <p className="text-xs text-muted-foreground">
              Write or customize one on{" "}
              <Link to={PERSONAS_TAB_PATH} className="text-primary underline">Personas</Link> (duplicate the built-in to start from it).
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

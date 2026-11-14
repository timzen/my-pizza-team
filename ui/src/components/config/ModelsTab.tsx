/**
 * ModelsTab — Config → Models (`/config/models`; docs/DESIGN.md "Choosing a
 * Model"). Everything about which model the team's agents run, over the page's
 * config.json draft (ConfigPage), saved with Save Configuration:
 *
 * - **Default Model** — the team default model per harness
 *   (`defaultModel`, shared/model-aliases.ts): a field per harness offering the
 *   models the live agents report (lib/models.ts `modelChoicesByHarness`) and
 *   taking free text. Agents registering after a save get it; **Apply to all
 *   teammates now** (POST /api/agents/model/default) sends it to the running,
 *   unpinned ones — offered right after a save that changed it.
 * - **Model Aliases** — the `personaModels` switch and the `modelAliases` map
 *   (moved here from Config → Teammates).
 * - **Failover** — a placeholder for the failover policy.
 *
 * Field hints are components/ui/field-hint (copy in lib/field-help.ts).
 */

import { useState } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import {
  defaultModelHarnesses, harnessOptions, isValidModelAlias, modelAliasRows, sameDefaultModels, setDefaultModel, setModelAlias,
  type ConfigData, type ConfigDraftProps,
} from "@/lib/config-draft";
import { modelChoicesByHarness } from "@/lib/models";
import type { Teammate } from "@/lib/team";
import type { ApplyDefaultModelResponse } from "@shared/protocol";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/ui/form-error";
import { FieldHint } from "@/components/ui/field-hint";
import { Plus, X } from "lucide-react";

/** ModelsTab's props: the draft, the saved config, and whether a save just changed the default. */
export interface ModelsTabProps extends ConfigDraftProps {
  /** The config as last saved (GET /api/config), or null before it loads. */
  saved: ConfigData | null;
  /** A save just changed the team default: offer to apply it to running teammates. */
  offerApply: boolean;
  /** The offer was taken or dismissed. */
  onOfferDone: () => void;
}

/** The Models tab's cards over the draft. */
export function ModelsTab({ config, setConfig, saved, offerApply, onOfferDone }: ModelsTabProps) {
  return (
    <div className="space-y-4">
      <DefaultModel config={config} setConfig={setConfig} saved={saved} offerApply={offerApply} onOfferDone={onOfferDone} />
      <PersonaModels config={config} setConfig={setConfig} />
      <Failover />
    </div>
  );
}

// --- Team default model (shared/model-aliases.ts teamDefaultModel; daemon/default-model.ts) ---

/**
 * The `defaultModel` fields, one per harness (Pi always; others once set or
 * live), each a text field with the live agents' models as suggestions. Below
 * them, "Apply to all teammates now" — enabled once the draft's defaults are
 * saved — and, after a save that changed them, the offer to do so.
 */
function DefaultModel({ config, setConfig, saved, offerApply, onOfferDone }: ModelsTabProps) {
  const { data: agents } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10000 });
  const choices = modelChoicesByHarness(agents?.agents);
  const harnesses = defaultModelHarnesses(config.defaultModel, choices.keys());
  const options = harnessOptions(config.harnesses);
  const label = (h: string) => options.find((o) => o.value === h)?.label ?? h;
  const unsaved = !sameDefaultModels(config.defaultModel, saved?.defaultModel);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();

  const update = (h: string, id: string | null) => setConfig({ ...config, defaultModel: setDefaultModel(config.defaultModel, h, id) });

  /** POST /api/agents/model/default, and say what it did. */
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<ApplyDefaultModelResponse>("/api/agents/model/default");
      if (!res.success) { setError(res.error || "Couldn't apply it"); return; }
      const parts = [`Sent to ${res.directives.length} agent(s); each switches after its current run`];
      if (res.pinned.length) parts.push(`${res.pinned.length} pinned left as they are`);
      if (res.unsupported.length) parts.push(`${res.unsupported.length} can't switch models (not supported by its harness)`);
      const msg = parts.join("; ") + ".";
      setResult(msg);
      announce(msg);
      onOfferDone();
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Default Model</h2>
        <FieldHint id="default-model-hint" field="defaultModel" />
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
          {harnesses.map((h) => {
            const listId = `default-model-options-${h}`;
            const models = choices.get(h) ?? [];
            return (
              <div key={h} className="contents">
                <Label htmlFor={`default-model-${h}`}>{label(h)}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`default-model-${h}`}
                    list={models.length ? listId : undefined}
                    placeholder="The harness's own default"
                    aria-describedby="default-model-hint"
                    value={config.defaultModel?.[h] ?? ""}
                    onChange={(e) => update(h, e.target.value)}
                    className="h-8 max-w-[320px]"
                  />
                  {models.length > 0 && (
                    <datalist id={listId}>
                      {models.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}
                    </datalist>
                  )}
                  {config.defaultModel?.[h] && (
                    <IconButton variant="ghost" size="sm" onClick={() => update(h, null)} label={`Clear the default model for ${label(h)}`}>
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Suggestions are the models the running agents report; any id the harness accepts works. Teammates and the
          assistant that start after you save get it, unless you pinned their model.
        </p>
        {offerApply && !unsaved && (
          <div role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-2">
            <p>The team default changed. Apply it to the teammates running now (those without a pinned model)?</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { void apply(); }} disabled={busy}>Apply now</Button>
              <Button size="sm" variant="outline" onClick={onOfferDone}>Not now</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void apply(); }}
            disabled={busy || unsaved}
            aria-describedby="apply-default-model-hint"
          >
            {busy ? "Applying..." : "Apply to all teammates now"}
          </Button>
          <p id="apply-default-model-hint" className="text-xs text-muted-foreground">
            {unsaved
              ? "Save the configuration first: this sends the saved default."
              : "Sends the saved default to every running teammate and the assistant without a pinned model; each switches after its current run."}
          </p>
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
        <FormError className="text-xs">{error}</FormError>
      </CardContent>
    </Card>
  );
}

// --- Model aliases (docs/DESIGN.md "Persona settings"; shared/model-aliases.ts) ---

/**
 * The `personaModels` switch and the `modelAliases` map: a persona names an
 * alias (`model: strong`), and this maps it to a model id per harness. Existing
 * rows edit their model id in place (or are removed); a new row picks a
 * harness, an alias and a model id. Saved with the page; live once saved (the
 * daemon resolves aliases at every claim).
 */
function PersonaModels({ config, setConfig }: ConfigDraftProps) {
  const [harness, setHarness] = useState("pi");
  const [alias, setAlias] = useState("");
  const [modelId, setModelId] = useState("");
  const enabled = config.personaModels !== false;
  const rows = modelAliasRows(config.modelAliases);
  const options = harnessOptions(config.harnesses);
  const trimmedAlias = alias.trim();
  const aliasError = trimmedAlias && !isValidModelAlias(trimmedAlias) ? "Letters, digits, \".\", \"_\" and \"-\" only, no spaces." : null;
  const canAdd = !!trimmedAlias && !aliasError && !!modelId.trim();

  const update = (h: string, a: string, id: string | null) =>
    setConfig({ ...config, modelAliases: setModelAlias(config.modelAliases, h, a, id) });
  const add = () => {
    if (!canAdd) return;
    update(harness, trimmedAlias, modelId.trim());
    setAlias("");
    setModelId("");
  };
  const label = (h: string) => options.find((o) => o.value === h)?.label ?? h;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Model Aliases</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            id="persona-models"
            type="checkbox"
            aria-describedby="persona-models-hint"
            checked={enabled}
            onChange={(e) => setConfig({ ...config, personaModels: e.target.checked })}
          />
          Use persona models
        </label>
        <FieldHint id="persona-models-hint" field="personaModels" />
        <FieldHint id="model-aliases-hint" field="modelAliases" />
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="font-medium pb-1">Harness</th>
                <th scope="col" className="font-medium pb-1">Alias</th>
                <th scope="col" className="font-medium pb-1">Model id</th>
                <th scope="col" className="pb-1"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.harness}/${r.alias}`}>
                  <td className="pr-2 py-1">{label(r.harness)}</td>
                  <td className="pr-2 py-1"><code>{r.alias}</code></td>
                  <td className="pr-2 py-1">
                    <Input
                      aria-label={`Model id for ${r.alias} (${label(r.harness)})`}
                      value={r.modelId}
                      onChange={(e) => update(r.harness, r.alias, e.target.value)}
                      onBlur={(e) => { if (!e.target.value.trim()) update(r.harness, r.alias, null); }}
                      className="h-8"
                    />
                  </td>
                  <td className="py-1 text-right">
                    <IconButton variant="ghost" size="sm" onClick={() => update(r.harness, r.alias, null)} label={`Remove alias ${r.alias} (${label(r.harness)})`}>
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length === 0 && <p className="text-xs text-muted-foreground italic">No aliases: a persona&apos;s model sets nothing until its alias is mapped here.</p>}
        <div className="flex flex-wrap items-start gap-2">
          <select
            aria-label="Harness for the new alias"
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="space-y-1">
            <Input
              placeholder="Alias, e.g. strong"
              aria-label="New alias"
              aria-describedby={aliasError ? "model-alias-error model-aliases-hint" : "model-aliases-hint"}
              aria-invalid={!!aliasError}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              className="max-w-[160px]"
            />
            {aliasError && <p id="model-alias-error" className="text-xs text-destructive">{aliasError}</p>}
          </div>
          <Input
            placeholder="Model id, e.g. provider/model"
            aria-label="Model id for the new alias"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            className="max-w-[260px]"
          />
          <IconButton variant="outline" size="sm" onClick={add} disabled={!canAdd} label="Add alias"><Plus className="h-3.5 w-3.5" /></IconButton>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save, from the next work item a teammate picks up.
        </p>
      </CardContent>
    </Card>
  );
}


// --- Failover (the next task fills this in) ---

/** Placeholder for the failover policy (a team-wide failover chain with automatic revert). */
function Failover() {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <h2 className="font-semibold">Failover</h2>
        <p className="text-xs text-muted-foreground">
          Coming soon: a team-wide chain of models to fall back on when calls to the usual one are throttled or
          fail with server errors, switching back automatically once it recovers.
        </p>
      </CardContent>
    </Card>
  );
}

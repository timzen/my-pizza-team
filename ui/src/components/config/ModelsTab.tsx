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
 * - **Failover** — the team-wide failover policy (`failover`, shared/failover.ts;
 *   docs/DESIGN.md "Model Failover"): on/off, the chain (primary first, model
 *   ids or aliases, reorderable), which error kinds count, the trip threshold
 *   and window, and the revert timer; plus the live state (GET /api/failover)
 *   with **End failover now** (POST /api/failover/end).
 *
 * Field hints are components/ui/field-hint (copy in lib/field-help.ts).
 */

import { useState } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import {
  defaultModelHarnesses, failoverForm, failoverProblem, harnessOptions, isValidModelAlias, modelAliasNamesOf, modelAliasRows, moveChainEntry,
  sameDefaultModels, setDefaultModel, setModelAlias,
  type ConfigData, type ConfigDraftProps, type FailoverDraft,
} from "@/lib/config-draft";
import { modelChoicesByHarness } from "@/lib/models";
import type { Teammate } from "@/lib/team";
import type { ApplyDefaultModelResponse, EndFailoverResponse, FailoverView } from "@shared/protocol";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/ui/form-error";
import { FieldHint } from "@/components/ui/field-hint";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { failoverSummary } from "@/lib/models";

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
      <Failover config={config} setConfig={setConfig} />
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


// --- Failover (docs/DESIGN.md "Model Failover"; shared/failover.ts, daemon/failover.ts) ---

/** The error kinds the policy may count, with their labels (auth/context never trip). */
const FAILOVER_KINDS: Array<{ value: "throttle" | "5xx" | "other"; label: string }> = [
  { value: "throttle", label: "Throttling (429, too many requests)" },
  { value: "5xx", label: "Server errors (5xx, service unavailable)" },
  { value: "other", label: "Other model errors" },
];

/**
 * The `failover` policy over the draft, and the live failover state with
 * "End failover now". Off by default; turning it on needs a chain of at least
 * two models (the primary first). Saved with the page; live once saved.
 */
function Failover({ config, setConfig }: ConfigDraftProps) {
  const form = failoverForm(config.failover);
  const problem = failoverProblem(config.failover);
  const [entry, setEntry] = useState("");
  const { data: agents } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10000 });
  const { data: live, refetch } = useApi<FailoverView>("/api/failover", [], { pollInterval: 10000 });
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();
  // Suggestions: every live agent's models, and the aliases the config defines.
  const suggestions = [...new Set([
    ...modelAliasNamesOf(config.modelAliases),
    ...[...modelChoicesByHarness(agents?.agents).values()].flat().map((m) => m.ref),
  ])];

  const update = (patch: Partial<FailoverDraft>) => setConfig({ ...config, failover: { ...form, ...patch } });
  const setChain = (chain: string[]) => update({ chain });
  const add = () => {
    const e = entry.trim();
    if (!e || form.chain.includes(e)) return;
    setChain([...form.chain, e]);
    setEntry("");
  };
  const toggleKind = (k: "throttle" | "5xx" | "other", on: boolean) =>
    update({ on: on ? [...new Set([...form.on, k])] : form.on.filter((x) => x !== k) });
  const number = (key: "after" | "windowMinutes" | "revertAfterMinutes", v: string) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1) update({ [key]: n });
  };

  /** POST /api/failover/end, and say so. */
  const endNow = async () => {
    if (ending) return;
    setEnding(true);
    setError(null);
    try {
      const res = await apiPost<EndFailoverResponse>("/api/failover/end");
      if (!res.success) { setError(res.error || "Couldn't end it"); return; }
      announce("Failover ended: the team is back on its usual models.");
      refetch();
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    } finally { setEnding(false); }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Failover</h2>
        {live?.active && (
          <div role="status" className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm space-y-2">
            <p>{failoverSummary(live)}</p>
            <Button size="sm" variant="outline" onClick={() => { void endNow(); }} disabled={ending}>
              {ending ? "Ending..." : "End failover now"}
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            id="failover-enabled"
            type="checkbox"
            aria-describedby="failover-chain-hint"
            checked={form.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Fail over automatically
        </label>
        <div className="space-y-2">
          <p className="text-sm font-medium" id="failover-chain-label">Chain</p>
          <FieldHint id="failover-chain-hint" field="failoverChain" />
          {form.chain.length > 0 ? (
            <ol className="space-y-1" aria-labelledby="failover-chain-label">
              {form.chain.map((m, i) => (
                <li key={`${m}-${i}`} className="flex items-center gap-2 text-sm">
                  <span className="w-20 text-xs text-muted-foreground">{i === 0 ? "Primary" : `Fallback ${i}`}</span>
                  <code className="flex-1 truncate">{m}</code>
                  <IconButton variant="ghost" size="sm" onClick={() => setChain(moveChainEntry(form.chain, i, -1))} disabled={i === 0} label={`Move ${m} up`}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton variant="ghost" size="sm" onClick={() => setChain(moveChainEntry(form.chain, i, 1))} disabled={i === form.chain.length - 1} label={`Move ${m} down`}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton variant="ghost" size="sm" onClick={() => setChain(form.chain.filter((_, j) => j !== i))} label={`Remove ${m} from the chain`}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground italic">No models yet: add the primary first, then the ones to fall back on.</p>
          )}
          <div className="flex items-center gap-2">
            <Input
              aria-label="Model id or alias to add to the chain"
              placeholder="Model id or alias"
              list={suggestions.length ? "failover-chain-options" : undefined}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              className="h-8 max-w-[320px]"
            />
            {suggestions.length > 0 && (
              <datalist id="failover-chain-options">
                {suggestions.map((m) => <option key={m} value={m} />)}
              </datalist>
            )}
            <IconButton variant="outline" size="sm" onClick={add} disabled={!entry.trim() || form.chain.includes(entry.trim())} label="Add to the chain">
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
        <fieldset className="space-y-1" aria-describedby="failover-on-hint">
          <legend className="text-sm font-medium">Fail over on</legend>
          <FieldHint id="failover-on-hint" field="failoverOn" />
          {FAILOVER_KINDS.map((k) => (
            <label key={k.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.on.includes(k.value)} onChange={(e) => toggleKind(k.value, e.target.checked)} />
              {k.label}
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-[220px_100px] items-center gap-2 text-sm">
          <Label htmlFor="failover-after">Failures that switch models</Label>
          <Input id="failover-after" type="number" min={1} className="h-8" value={form.after} onChange={(e) => number("after", e.target.value)} />
          <Label htmlFor="failover-window">...within (minutes)</Label>
          <Input id="failover-window" type="number" min={1} className="h-8" value={form.windowMinutes} onChange={(e) => number("windowMinutes", e.target.value)} />
          <Label htmlFor="failover-revert">Try the primary again after (minutes)</Label>
          <Input id="failover-revert" type="number" min={1} className="h-8" aria-describedby="failover-revert-hint" value={form.revertAfterMinutes} onChange={(e) => number("revertAfterMinutes", e.target.value)} />
        </div>
        <FieldHint id="failover-revert-hint" field="failoverRevert" />
        <FormError className="text-xs">{problem ?? error}</FormError>
      </CardContent>
    </Card>
  );
}

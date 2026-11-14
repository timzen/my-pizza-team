/**
 * TeammatesTab — Config → Teammates (`/config/teammates`): name nouns, the
 * one-teammate-per-directory toggle, the persona model aliases, and the
 * experimental harnesses opt-in + default harness. All edit the page's config.json draft (ConfigPage). Their
 * hints are components/ui/field-hint (copy in lib/field-help.ts).
 */

import { useState } from "react";
import { harnessOptions, isValidModelAlias, modelAliasRows, normalizeNoun, setModelAlias, type ConfigDraftProps } from "@/lib/config-draft";
import { Card, CardContent } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { FieldHint } from "@/components/ui/field-hint";

/** The Teammates tab's cards over the draft. */
export function TeammatesTab({ config, setConfig }: ConfigDraftProps) {
  const [newNoun, setNewNoun] = useState("");
  const teammates = config.teammates || {};
  const nouns = teammates.nouns || [];

  const addNoun = () => {
    const val = normalizeNoun(newNoun);
    if (!val || nouns.includes(val)) return;
    setConfig({ ...config, teammates: { ...teammates, nouns: [...nouns, val] } });
    setNewNoun("");
  };

  const removeNoun = (noun: string) => {
    const updated = nouns.filter((n) => n !== noun);
    setConfig({ ...config, teammates: { ...teammates, nouns: updated.length > 0 ? updated : undefined } });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Name Nouns</h2>
          <FieldHint id="teammate-nouns-hint" field="nameNouns" />
          <div className="flex gap-1 flex-wrap">
            {nouns.map((n) => (
              <Badge key={n} variant="secondary" className="gap-1">
                {n}
                <Tooltip content="Remove" describe={false}>
                  <button onClick={() => removeNoun(n)} className="hover:text-destructive" aria-label={`Remove ${n}`}><X className="h-3 w-3" /></button>
                </Tooltip>
              </Badge>
            ))}
            {nouns.length === 0 && (config.defaultNouns || []).map((n) => (
              <Badge key={n} variant="outline" className="text-muted-foreground">{n}</Badge>
            ))}
          </div>
          {nouns.length === 0 && <p className="text-xs text-muted-foreground italic">Showing built-in defaults. Add a noun to use a custom list instead.</p>}
          <div className="flex gap-2">
            <Input placeholder="Add a noun..." aria-label="New noun" aria-describedby="teammate-nouns-hint" value={newNoun} onChange={(e) => setNewNoun(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNoun()} className="max-w-[200px]" />
            <IconButton variant="outline" size="sm" onClick={addNoun} label="Add noun"><Plus className="h-3.5 w-3.5" /></IconButton>
          </div>
        </CardContent>
      </Card>

      <ExclusiveDirectories config={config} setConfig={setConfig} />

      <PersonaModels config={config} setConfig={setConfig} />

      <ExperimentalHarnesses config={config} setConfig={setConfig} />
    </div>
  );
}

// --- Exclusive directories (docs/DESIGN.md "Work Matching: Directory Affinity") ---

/**
 * The `exclusiveDirectories` toggle: while a WorkItem with a directory is in
 * flight, overlapping work waits. Default on (unset reads as checked); applies
 * live once saved.
 */
function ExclusiveDirectories({ config, setConfig }: ConfigDraftProps) {
  const enabled = config.exclusiveDirectories !== false;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Directories</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            id="exclusive-directories"
            type="checkbox"
            aria-describedby="exclusive-directories-hint exclusive-directories-detail"
            checked={enabled}
            onChange={(e) => setConfig({ ...config, exclusiveDirectories: e.target.checked })}
          />
          One teammate per directory
        </label>
        <FieldHint id="exclusive-directories-hint" field="exclusiveDirectories" />
        <p id="exclusive-directories-detail" className="text-xs text-muted-foreground">
          A folder inside it, or one containing it, counts as the same directory; work with no directory
          always runs in parallel. Takes effect as soon as you save. A stuck <em>At risk</em> item keeps its directory until you
          force-fail it on the Queue page.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Persona models (docs/DESIGN.md "Persona settings"; shared/model-aliases.ts) ---

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
        <h2 className="font-semibold">Persona Models</h2>
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

// --- Experimental harnesses (docs/DESIGN.md "Harness Tiers, and Why Not MCP") ---

/**
 * The `experimental.harnesses` opt-in and the default harness, saved with the rest
 * of the page. Turning the opt-in off resets the default to Pi in the draft, since
 * the daemon refuses to save (or spawn with) a non-Pi default without the opt-in.
 * Both apply live — the PUT updates the daemon's in-memory config.
 */
function ExperimentalHarnesses({ config, setConfig }: ConfigDraftProps) {
  const enabled = !!config.experimental?.harnesses;
  const current = config.defaultHarness || "pi";
  const options = harnessOptions(config.harnesses);

  const setEnabled = (on: boolean) =>
    setConfig({
      ...config,
      experimental: { ...config.experimental, harnesses: on },
      // "pi" (not undefined) so the PUT carries the reset; the daemon stores it as unset.
      ...(on ? {} : { defaultHarness: "pi" }),
    });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Experimental Harnesses</h2>
        <p className="text-xs text-muted-foreground">
          Lets you spawn Kiro and Claude Code teammates, run by <code>mpt agent</code> over the Agent
          Client Protocol. Each harness needs <code>mpt setup --harness &lt;h&gt;</code> (e.g.{" "}
          <code>mpt setup --harness kiro</code>) on this machine first. Teammates only — they can't lead yet.
        </p>
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
          <Label htmlFor="experimental-harnesses">Enabled</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              id="experimental-harnesses"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Allow non-Pi teammates (adds a Harness picker to the Spawn dialog)
          </label>
          <Label htmlFor="default-harness">Default Harness</Label>
          <div className="space-y-1">
            <select
              id="default-harness"
              value={current}
              disabled={!enabled}
              aria-describedby="default-harness-hint"
              onChange={(e) => setConfig({ ...config, defaultHarness: e.target.value })}
              className="h-9 max-w-[260px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <FieldHint id="default-harness-hint" field="defaultHarness">
              {enabled ? "" : " Pi while experimental harnesses are off."}
            </FieldHint>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save — no daemon restart. Teammates already running keep their harness.
        </p>
      </CardContent>
    </Card>
  );
}

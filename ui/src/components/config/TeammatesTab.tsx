/**
 * TeammatesTab — Config → Teammates (`/config/teammates`): name nouns, the
 * one-teammate-per-directory toggle, and the experimental harnesses opt-in +
 * default harness. All edit the page's config.json draft (ConfigPage).
 */

import { useState } from "react";
import { harnessOptions, normalizeNoun, type ConfigDraftProps } from "@/lib/config-draft";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";

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
          <p className="text-xs text-muted-foreground">Custom nouns for auto-generated teammate names (adjective-noun). Leave empty for sci-fi character defaults.</p>
          <div className="flex gap-1 flex-wrap">
            {nouns.map((n) => (
              <Badge key={n} variant="secondary" className="gap-1">
                {n}
                <button onClick={() => removeNoun(n)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
              </Badge>
            ))}
            {nouns.length === 0 && (config.defaultNouns || []).map((n) => (
              <Badge key={n} variant="outline" className="text-muted-foreground">{n}</Badge>
            ))}
          </div>
          {nouns.length === 0 && <p className="text-xs text-muted-foreground italic">Showing built-in defaults. Add a noun to use a custom list instead.</p>}
          <div className="flex gap-2">
            <Input placeholder="Add a noun..." value={newNoun} onChange={(e) => setNewNoun(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNoun()} className="max-w-[200px]" />
            <Button variant="outline" size="sm" onClick={addNoun}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>

      <ExclusiveDirectories config={config} setConfig={setConfig} />

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
        <p className="text-xs text-muted-foreground">
          While a piece of work runs in a directory, other work for that directory (or a folder inside
          it, or one containing it) waits in the queue, so two teammates never edit and commit in the
          same checkout at once. Work with no directory always runs in parallel.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            id="exclusive-directories"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setConfig({ ...config, exclusiveDirectories: e.target.checked })}
          />
          One teammate per directory
        </label>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save. A stuck <em>At risk</em> item keeps its directory until you
          force-fail it on the Queue page.
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
              onChange={(e) => setConfig({ ...config, defaultHarness: e.target.value })}
              className="h-9 max-w-[260px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              Used for spawns that don't pick a harness — including the teammates the daemon keeps
              online. {enabled ? "" : "Pi while experimental harnesses are off."}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save — no daemon restart. Teammates already running keep their harness.
        </p>
      </CardContent>
    </Card>
  );
}

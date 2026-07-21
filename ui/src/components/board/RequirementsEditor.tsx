/**
 * RequirementsEditor — Edit a story's requirements as key/value capabilities,
 * mirroring the "Recent Capabilities" editor in settings and the capability
 * badges on the teammates page.
 *
 * A requirement is either:
 *   - value-bound  (e.g. `java: 8`)   — a teammate must match the value exactly
 *   - presence-only (e.g. `python: null`) — a teammate must have the key
 *
 * The add form draws name/value suggestions from the daemon's recently used
 * capabilities (/api/capabilities), so common keys and their known values are
 * one keystroke away. (A story's working directory is NOT a capability — it's
 * the story's `directory` field; see the daemon's docs/WORK-MODEL.md.)
 */

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

interface RequirementsEditorProps {
  value: Record<string, string | null>;
  onChange: (next: Record<string, string | null>) => void;
}

export function RequirementsEditor({ value, onChange }: RequirementsEditorProps) {
  const { data } = useApi<{ capabilities: Record<string, string[]> }>("/api/capabilities");
  const recent = data?.capabilities || {};
  const recentNames = Object.keys(recent).sort();

  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(value);

  const addRequirement = () => {
    const name = newName.trim();
    if (!name) return;
    const val = newValue.trim();
    onChange({ ...value, [name]: val || null });
    setNewName(""); setNewValue("");
  };

  const removeKey = (name: string) => {
    const next = { ...value };
    delete next[name];
    onChange(next);
  };

  /** Drop a key's value, leaving it as a presence-only requirement. */
  const clearValue = (name: string) => {
    onChange({ ...value, [name]: null });
  };

  return (
    <div className="space-y-2">
      {/* Current requirements */}
      <div className="space-y-2">
        {entries.map(([name, val]) => (
          <div key={name} className="flex items-start gap-2">
            <Badge variant="secondary" className="gap-1 shrink-0">
              {name}
              <button type="button" onClick={() => removeKey(name)} className="hover:text-destructive" title="Remove requirement">
                <X className="h-3 w-3" />
              </button>
            </Badge>
            <div className="flex flex-wrap gap-1 flex-1">
              {typeof val === "string" && val ? (
                <Badge variant="outline" className="gap-1 font-mono text-xs">
                  {val}
                  <button type="button" onClick={() => clearValue(name)} className="hover:text-destructive" title="Remove value (require presence only)">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground italic">presence-only</span>
              )}
            </div>
          </div>
        ))}
        {entries.length === 0 && <span className="text-xs text-muted-foreground italic">No requirements — any teammate can work this story.</span>}
      </div>

      {/* Add form, with suggestions from recent capabilities */}
      <div className="flex gap-2 pt-1">
        <Input
          placeholder="name (e.g. java)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRequirement())}
          list="requirement-names"
          className="max-w-[180px]"
        />
        <Input
          placeholder="value (optional)"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRequirement())}
          list="requirement-values"
          className="flex-1"
        />
        <Button type="button" variant="outline" size="sm" onClick={addRequirement}><Plus className="h-3.5 w-3.5" /></Button>

        {/* Native suggestion lists sourced from recent capabilities */}
        <datalist id="requirement-names">
          {recentNames.map((n) => <option key={n} value={n} />)}
        </datalist>
        <datalist id="requirement-values">
          {(recent[newName.trim()] || []).map((v) => <option key={v} value={v} />)}
        </datalist>
      </div>
    </div>
  );
}

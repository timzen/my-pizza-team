/**
 * TeamSizeDialog — Set the steady size of the generalist teammate pool.
 *
 * Team size is *declared*, not clicked: you say how many teammates you want and
 * the daemon keeps that many online — spawning replacements whenever the pool
 * dips (a teammate dismissed, crashed, or reaped offline). When no size has been
 * declared it defaults to half of `maxTeammates`; "Use default" clears an
 * explicit value back to that. Persisted in config.json, so it's also the target
 * applied at startup.
 *
 * Nothing scales *down*: lowering the number just stops replacements (dismissing
 * a teammate stays a human act). Backed by PUT /api/teammate-pool; the pool
 * state is owned by the SideDock (useTeamData; it also drives the header
 * warning dot) and passed in.
 */

import { useState } from "react";
import { apiPut } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

/** Live pool state from GET /api/teammate-pool. */
export interface TeammatePool {
  /** Effective steady size (explicit, or the default when `isDefault`). */
  minTeammates: number;
  /** True while no size is declared — the value tracks maxTeammates / 2. */
  isDefault: boolean;
  maxTeammates: number;
  online: number;
  pending: number;
  /** False when no leader is connected — nothing can realize a spawn. */
  leaderPresent: boolean;
}

export function TeamSizeDialog({
  open,
  onOpenChange,
  pool,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pool: TeammatePool | null;
  onChanged: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/* Mounted only while open, so the draft seeds from the live value on
            each open — and later polls don't fight the user's typing. */}
        {open && <TeamSizeForm pool={pool} onDone={() => { onChanged(); onOpenChange(false); }} />}
      </DialogContent>
    </Dialog>
  );
}

function TeamSizeForm({ pool, onDone }: { pool: TeammatePool | null; onDone: () => void }) {
  const [draft, setDraft] = useState(() => String(pool?.minTeammates ?? 0));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const max = pool?.maxTeammates ?? 0;

  const save = async (minTeammates: number | null) => {
    setSaving(true);
    const res = await apiPut<{ success: boolean; error?: string }>("/api/teammate-pool", { minTeammates });
    setSaving(false);
    if (!res.success) { setError(res.error || "Could not set team size"); return; }
    onDone();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(draft, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== draft.trim()) { setError("Enter a whole number ≥ 0"); return; }
    save(n);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Steady team size</DialogTitle>
        <DialogDescription>
          The daemon keeps this many teammates online, spawning replacements as needed. Lowering it never dismisses anyone.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="team-size">Teammates</Label>
          <div className="flex items-center gap-2">
            <Input
              id="team-size"
              type="number"
              min={0}
              max={max || undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-24"
              autoFocus
            />
            {max > 0 && <span className="text-xs text-muted-foreground">max {max}</span>}
          </div>
          {pool && (
            <p className="text-xs text-muted-foreground">
              {pool.online} online{pool.pending > 0 ? ` · ${pool.pending} starting` : ""}
              {pool.isDefault ? ` · using the default (half of max)` : ""}
            </p>
          )}
        </div>

        {pool && pool.minTeammates > 0 && !pool.leaderPresent && (
          <p className="flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> No leader connected — nothing can spawn until one is.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          {pool && !pool.isDefault && (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => save(null)} title="Clear the declared size (half of max)">
              Use default
            </Button>
          )}
          <Button type="submit" disabled={saving}>Save</Button>
        </DialogFooter>
      </form>
    </>
  );
}

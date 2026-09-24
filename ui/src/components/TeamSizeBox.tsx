/**
 * TeamSizeBox — The declared size of the generalist teammate pool.
 *
 * Team size is *declared*, not clicked: instead of a "Spawn teammate" button in
 * every corner of the UI, you type the minimum number of teammates you want and
 * the daemon keeps that many online — spawning replacements whenever the pool
 * dips (a teammate dismissed, crashed, or reaped offline). Default 0, so nothing
 * spawns until you ask for it. The value is persisted in config.json, so it is
 * also the target the daemon applies at startup.
 *
 * Nothing scales *down*: lowering the number just stops replacements (dismissing
 * a teammate stays a human act). Backed by GET/PUT /api/teammate-pool.
 *
 * Rendered in the TeammateSidebar header (where the Spawn button used to live)
 * and on the Config page's General tab.
 */

import { useState } from "react";
import { useApi, apiPut } from "@/hooks/useApi";
import { Input } from "@/components/ui/input";
import { Users, AlertTriangle } from "lucide-react";

interface TeammatePool {
  minTeammates: number;
  maxTeammates: number;
  online: number;
  pending: number;
  /** False when no leader is connected — nothing can realize a spawn. */
  leaderPresent: boolean;
}

export function TeamSizeBox({ className = "" }: { className?: string }) {
  const { data, refetch } = useApi<TeammatePool>("/api/teammate-pool", [], { pollInterval: 10_000 });
  // Local draft so typing isn't fought by the poll; committed on blur/Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");

  const min = data?.minTeammates ?? 0;

  const commit = async (raw: string) => {
    setDraft(null);
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) { setError("Enter a whole number ≥ 0"); return; }
    if (n === min) { setError(""); return; }
    const res = await apiPut<{ success: boolean; error?: string }>("/api/teammate-pool", { minTeammates: n });
    setError(res.success ? "" : res.error || "Could not set team size");
    refetch();
  };

  const pending = data?.pending ?? 0;
  const capped = data && data.maxTeammates > 0 && min >= data.maxTeammates;

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center gap-1.5">
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          type="number"
          min={0}
          max={data?.maxTeammates || undefined}
          value={draft ?? String(min)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-7 w-16 px-2 text-sm"
          title="Minimum teammates the daemon keeps online"
          aria-label="Minimum teammates"
        />
        <span className="text-xs text-muted-foreground">
          teammates{pending > 0 ? ` · ${pending} starting` : ""}
        </span>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {!error && min > 0 && data && !data.leaderPresent && (
        <p className="flex items-center gap-1 text-[11px] text-amber-600">
          <AlertTriangle className="h-3 w-3 shrink-0" /> No leader connected — can't spawn yet.
        </p>
      )}
      {!error && capped && (
        <p className="text-[11px] text-muted-foreground">At the maxTeammates cap ({data!.maxTeammates}).</p>
      )}
    </div>
  );
}

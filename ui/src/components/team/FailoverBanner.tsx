/**
 * FailoverBanner — The Team tab's one-line notice while a team-wide model
 * failover is in effect (docs/DESIGN.md "Model Failover"; daemon/failover.ts).
 *
 * Polls GET /api/failover and renders nothing unless it's active: then which
 * model the team runs instead of which, since when, when the primary is tried
 * again (lib/models.ts `failoverSummary`), and **End failover now** (POST
 * /api/failover/end). The policy itself is edited on Config → Models.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { failoverSummary } from "@/lib/models";
import type { EndFailoverResponse, FailoverView } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";

export function FailoverBanner() {
  const { data, refetch } = useApi<FailoverView>("/api/failover", [], { pollInterval: 10_000 });
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();
  if (!data?.active) return null;

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
    <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs space-y-1">
      <p className="text-amber-800 dark:text-amber-300">{failoverSummary(data)}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { void endNow(); }} disabled={ending}>
          {ending ? "Ending..." : "End failover now"}
        </Button>
        <Link to="/config/models" className="underline text-muted-foreground">Failover settings</Link>
      </div>
      <FormError className="text-xs">{error}</FormError>
    </div>
  );
}

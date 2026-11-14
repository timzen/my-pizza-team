/**
 * FailoverBanner — The Team tab's small notice while a team-wide model
 * failover is in effect (docs/DESIGN.md "Model Failover"; daemon/failover.ts).
 *
 * Polls GET /api/failover and renders nothing unless it's active: then one
 * line — "Failover: <from> → <to> since <time> (<kind>)" (lib/models.ts
 * `failoverBanner`; the tooltip adds when the primary is tried again) — a link
 * to Config → Models, where the policy is edited, and **End now** (POST
 * /api/failover/end). Nothing goes on the teammates' rows.
 *
 * `compact` is the phone's Team tab (`/m`, mobile/MobileTeam): the same line
 * as a one-line notice, without the actions — ending a failover is the
 * desktop's, like the rest of the team's setup.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { failoverBanner } from "@/lib/models";
import type { EndFailoverResponse, FailoverView } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";

export function FailoverBanner({ compact = false }: { compact?: boolean }) {
  const { data, refetch } = useApi<FailoverView>("/api/failover", [], { pollInterval: 10_000 });
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();
  const banner = failoverBanner(data);
  if (!banner) return null;

  if (compact) {
    return (
      <p role="status" title={banner.detail} className="truncate rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
        {banner.text}
      </p>
    );
  }

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
    <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to="/config/models" title={banner.detail} className="min-w-0 flex-1 text-amber-800 hover:underline dark:text-amber-300">
          {banner.text}<span className="sr-only"> (failover settings)</span>
        </Link>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => { void endNow(); }} disabled={ending}>
          {ending ? "Ending..." : "End now"}
        </Button>
      </div>
      <FormError className="text-xs">{error}</FormError>
    </div>
  );
}

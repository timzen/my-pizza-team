/**
 * ExternalSourcePage — Work → <source> (`/work/source/:sourceId`):
 * the generic, read-only view of one external (pull-only) Work Source.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 * Lists the defs the source mirrors (`GET /api/work-sources/:id/defs`): title
 * (linking to the WorkDef detail page, which is read-only for these), the
 * "Open in <source>" link, the revision last mirrored, the latest WorkItem's
 * state, and the run count. MPT never authors these, so there's no New, Edit,
 * or Archive here — the source's sync decides what exists, and archives the
 * mirrors of items it no longer reports (**Show archived** lists them, with
 * their threads). **Sync now** asks the daemon
 * to pull at once instead of waiting for the next interval; **Configure**
 * opens its settings (on/off, settings form, Preview) on Config → Sources. Same tab layout
 * as the other Work tabs (WorkItemsLayout); one tab per registered source.
 * A **triage-mode** item (docs/DESIGN.md "External sources" — "Triage mode") is
 * marked **Triage** and wears a note's TriageBadge — proposals waiting, a
 * question, or nothing to create — linking to its page's Triage tab; the row
 * itself opens that tab too.
 *
 * A source switched off (docs/DESIGN.md "Feature Toggles": every external
 * source has a `features.<id>` toggle by default) shows the "turned off"
 * notice instead — its tab is hidden, but a bookmark should say why.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiPost, useApi } from "@/hooks/useApi";
import { useExternalSources, useFeatures } from "@/hooks/useFeatures";
import { FeatureOffNotice } from "@/components/FeatureGate";
import { isExternalSourceOn } from "@/lib/work-items";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import { TriageBadge } from "@/components/thoughts/TriageBadge";
import { mirrorTriagePath } from "@/lib/triage";
import { runCountLabel } from "@/lib/run-count";
import { isTriageMode, latestStateLabel, latestStateTone, type MirroredDefRow, openInLabel, shortRevision } from "@/lib/external-sources";
import { sourceSettingsPath } from "@/lib/source-settings";
import { ExternalLink, FolderSync, RefreshCw, Settings } from "lucide-react";

/** Badge classes per latest-state tone. */
const TONE_CLASS: Record<ReturnType<typeof latestStateTone>, string> = {
  active: "border-sky-500/60 text-sky-600",
  ok: "border-emerald-500/60 text-emerald-600",
  bad: "border-red-500/60 text-red-600",
  neutral: "text-muted-foreground",
};

export function ExternalSourcePage() {
  const { sourceId = "" } = useParams<{ sourceId: string }>();
  const features = useFeatures();
  const info = useExternalSources()?.find((s) => s.id === sourceId);
  // Until the toggles load, render nothing (no flash of a switched-off source).
  if (!features) return null;
  if (info && !isExternalSourceOn(info, features)) {
    return <WorkItemsLayout bodyClassName="max-w-3xl"><FeatureOffNotice sourceLabel={info.label} sourceId={info.id} embedded /></WorkItemsLayout>;
  }
  return <ExternalSourceView sourceId={sourceId} />;
}

/** The source's mirrored defs, Sync now, and Show archived (it's switched on). */
function ExternalSourceView({ sourceId }: { sourceId: string }) {
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, refetch } = useApi<{ source: { id: string; label: string }; defs: MirroredDefRow[] }>(
    `/api/work-sources/${encodeURIComponent(sourceId)}/defs${showArchived ? "?status=all" : ""}`, [sourceId, showArchived], { pollInterval: 10_000 },
  );
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const label = data?.source.label ?? sourceId;
  const defs = data?.defs ?? [];

  const syncNow = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      const res = await apiPost<{ success: boolean; error?: string; skipped?: string }>(`/api/work-sources/${encodeURIComponent(sourceId)}/sync`, {});
      if (!res.success) setSyncError(res.skipped === "in-flight" ? "A sync is already running." : res.error || "Sync failed");
      refetch();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      {error && !data ? (
        <p className="text-sm text-muted-foreground">No external source “{sourceId}” is registered.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="mr-auto text-sm text-muted-foreground">
              Work mirrored from {label}. Read-only here — edit it in {label}; each new revision runs once.
            </p>
            <Button
              size="sm"
              variant={showArchived ? "default" : "outline"}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              title={`Also list items ${label} no longer reports (archived by sync)`}
            >
              Show archived
            </Button>
            <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing} title={`Pull from ${label} now`}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} />Sync now
            </Button>
            <Button size="sm" variant="outline" render={<Link to={sourceSettingsPath(sourceId)} />} title={`${label}'s settings, on/off, and Preview (Config → Sources)`}>
              <Settings className="h-3.5 w-3.5 mr-1" />Configure
            </Button>
          </div>
          {syncError && <p className="text-sm text-destructive">{syncError}</p>}

          {data && defs.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <FolderSync className="h-8 w-8" />
              <p className="text-sm">Nothing mirrored from {label} yet.</p>
            </div>
          )}

          <div className="grid gap-3">
            {defs.map((def) => (
              <Card key={def.id} className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4 flex items-center gap-3">
                  <Link to={isTriageMode(def) ? mirrorTriagePath(def.id) : `/work-defs/${encodeURIComponent(def.id)}`} className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {def.title}
                      {isTriageMode(def) && (
                        <Badge variant="outline" className="ml-2 text-[10px]" title="Triaged into proposed work, not worked directly">Triage</Badge>
                      )}
                      {def.status === "archived" && <Badge variant="secondary" className="ml-2 text-[10px]">Archived</Badge>}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span className="font-mono">{def.externalId}</span>
                      <span className="font-mono" title={def.revision ? `Revision ${def.revision}` : "No revision recorded"}>rev {shortRevision(def.revision)}</span>
                      <span title={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this yet"}>
                        {runCountLabel(def.runCount)}
                      </span>
                    </div>
                  </Link>
                  {isTriageMode(def) && <TriageBadge to={mirrorTriagePath(def.id)} subject="item" badge={def.triageBadge} />}
                  <Badge variant="outline" className={TONE_CLASS[latestStateTone(def.latestState)]} title="State of its latest WorkItem">
                    {latestStateLabel(def.latestState)}
                  </Badge>
                  {def.url && (
                    <Button variant="ghost" size="sm" render={<a href={def.url} target="_blank" rel="noreferrer" />} title={openInLabel(label)}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />{openInLabel(label)}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </WorkItemsLayout>
  );
}

/**
 * MirrorTriagePanel — The **Triage** tab of a triage-mode external item's
 * WorkDef page (pages/WorkDefDetailPage). See docs/DESIGN.md "External sources"
 * — "Triage mode": the read-only mirror is the triage subject, and its own thread
 * holds the analyses, proposals, and decisions.
 *
 *   left   the item, read-only, with **Open in <source>** — it's edited there,
 *          and a new revision is the next turn
 *   right  the latest analysis and its proposals: **Accept / Edit / Reject**
 *   below  earlier rounds and what you decided
 *
 * The analysis half is components/triage/TriageAnalysis, shared with a note's
 * TriagePage; decisions post to `/api/work-defs/:id/triage/proposals/:pid/…`.
 * **Triage now** is the page header's Run (on a triage-mode mirror, Run means
 * Triage now).
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/ui/markdown-view";
import { EarlierAnalyses, LatestAnalysis } from "@/components/triage/TriageAnalysis";
import type { ProposalDecisions } from "@/hooks/useProposalDecisions";
import { latestStateLabel, openInLabel } from "@/lib/external-sources";
import { outcomeLabel, type WorkDefTriageView } from "@/lib/triage";
import { ExternalLink } from "lucide-react";

/** The mirrored item's content, as the page already has it. */
export interface MirroredItemContent {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
}

export function MirrorTriagePanel({ item, view, decisions, blocked }: {
  item: MirroredItemContent;
  view: WorkDefTriageView;
  decisions: ProposalDecisions;
  /** Why Triage now is unavailable (lib/triage.ts mirrorTriageNowBlocked), or null. */
  blocked: string | null;
}) {
  const mirror = view.mirror;
  const label = mirror?.sourceLabel ?? "its source";
  const inFlight = view.latestState === "READY" || view.latestState === "IN_PROGRESS" || view.latestState === "MORIBUND";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={view.latestOutcome === "proposals" ? "default" : "secondary"}>{outcomeLabel(view.latestOutcome)}</Badge>
        <span title="State of its latest triage run">{latestStateLabel(view.latestState)}</span>
        {blocked && <span>· {blocked}</span>}
      </div>
      {decisions.error && <p className="text-sm text-destructive">{decisions.error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* ─── The item, read-only ─────────────────────────────────── */}
        <Card className="self-start">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
              <h2 className="truncate text-sm font-medium">{mirror ? `${label} ${mirror.externalId}` : "The item"}</h2>
              {mirror?.url && (
                <Button variant="ghost" size="sm" render={<a href={mirror.url} target="_blank" rel="noreferrer" />}>
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />{openInLabel(label)}
                </Button>
              )}
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto p-4">
              <h3 className="font-medium">{item.title}</h3>
              {item.goal.trim()
                ? <MarkdownView content={item.goal} className="text-[13px]" />
                : <p className="text-sm italic text-muted-foreground">No description.</p>}
              {item.acceptanceCriteria && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Acceptance criteria</p>
                  <MarkdownView content={item.acceptanceCriteria} className="text-[13px]" />
                </div>
              )}
              {item.additionalContext && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Additional context</p>
                  <MarkdownView content={item.additionalContext} className="text-[13px]" />
                </div>
              )}
            </div>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Mirrored from {label} (read-only): change it there and the next sync's new revision is
              triaged again. Answer a question that way too.
            </p>
          </CardContent>
        </Card>

        {/* ─── The latest analysis ─────────────────────────────────── */}
        <LatestAnalysis
          data={view}
          decisions={decisions}
          questionHint={`Answer by updating the item in ${label} — the next revision is triaged again.`}
          empty={<>No analysis yet. {inFlight
            ? "A teammate is on it."
            : "Each new revision is triaged once, or press Triage now."}</>}
        />
      </div>

      <EarlierAnalyses data={view} />
    </div>
  );
}

/**
 * TriagePage — `/thoughts/:id/triage`: where a note becomes work.
 *
 * Notes are for tossing out and rearranging ideas; this is the separate place you
 * come when you're ready to promote one (docs/DESIGN.md "Auto Triage: a Note Is a
 * Parent"). Reached from the note's badge or its Inbox row.
 *
 *   left   the note, read-only, with **Edit note** back to it — editing the note
 *          is your turn, and the next sweep re-reads it
 *   right  the latest analysis: **Accept / Edit / Reject** per proposal
 *   below  earlier rounds and what you decided
 *
 * **Accept** creates the work and nothing else (a standalone task waits for Run; a
 * story task enters its story's workflow like any other). **Edit** is the same
 * thing with the fields opened up first — it sends your edits as overrides, so the
 * decision still records this proposal. **Reject** is one click and no reason: to
 * steer the next analysis, edit the note. A proposal of a kind the team has
 * switched off (Config → Work items) can only be rejected: the daemon would refuse
 * to create it, so Accept/Edit are disabled with the reason. The analysis and
 * proposal parts are components/triage/TriageAnalysis, shared with a triage-mode
 * external item's Triage tab.
 */

import { Link, useParams } from "react-router-dom";
import { apiPost, useApi } from "@/hooks/useApi";
import { useProposalDecisions } from "@/hooks/useProposalDecisions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BackButton } from "@/components/ui/back-button";
import { EarlierAnalyses, LatestAnalysis } from "@/components/triage/TriageAnalysis";
import { noteClass } from "@/lib/thoughtColors";
import { outcomeLabel, triageNowBlocked, type TriageView } from "@/lib/triage";
import { Lightbulb, Play, StickyNote } from "lucide-react";

export function TriagePage() {
  const { id = "" } = useParams();
  const { data, refetch } = useApi<TriageView>(`/api/thoughts/${encodeURIComponent(id)}/triage`, [id], { pollInterval: 15_000 });
  const decisions = useProposalDecisions(
    (proposalId, action) => `/api/thoughts/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/${action}`,
    refetch,
  );
  const { busy, setBusy, error, setError } = decisions;

  if (!data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const { note, latestOutcome, skipReason } = data;
  const blocked = triageNowBlocked(skipReason);

  const triageNow = async () => {
    setBusy(true);
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/thoughts/${encodeURIComponent(id)}/triage`, {});
    setBusy(false);
    if (!res.success) setError(res.error || "Could not start a triage run");
    refetch();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <BackButton fallback="/thoughts" label="Back to Thoughts" />
        <h1 className="flex items-center gap-2 font-semibold"><Lightbulb className="h-4 w-4" />Triage</h1>
        <Badge variant="secondary" className="font-mono text-[10px]">{note.id}</Badge>
        <Badge variant={latestOutcome === "proposals" ? "default" : "secondary"}>{outcomeLabel(latestOutcome)}</Badge>
        <div className="ml-auto flex items-center gap-2">
          {/* `?note=` selects (and centers) it, so this lands on the note itself. */}
          <Button variant="outline" size="sm" render={<Link to={`/thoughts?note=${encodeURIComponent(note.id)}`} />}>
            <StickyNote className="mr-1 h-4 w-4" />Edit note
          </Button>
          <Button size="sm" onClick={triageNow} disabled={busy || blocked !== null} title={blocked ?? "Run triage on this note now"}>
            <Play className="mr-1 h-4 w-4" />Triage now
          </Button>
        </div>
      </div>

      {blocked && <p className="text-xs text-muted-foreground">{blocked}.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* ─── The note, read-only ─────────────────────────────────── */}
        <Card className="self-start">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h2 className="text-sm font-medium">The note</h2>
              <span className="text-xs text-muted-foreground">
                edited {new Date(note.updatedAt).toLocaleString()}
              </span>
            </div>
            <div className={`max-h-[60vh] overflow-y-auto p-4 ${noteClass(note.color)}`}>
              {note.content.trim()
                ? <MarkdownView content={note.content} />
                : <p className="text-sm italic text-muted-foreground">Empty note.</p>}
            </div>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Your turn is the note itself: edit it and the next sweep re-reads it. Answer a
              question that way too.
            </p>
          </CardContent>
        </Card>

        {/* ─── The latest analysis ─────────────────────────────────── */}
        <LatestAnalysis
          data={data}
          decisions={decisions}
          questionHint="Answer by editing the note — that's what the next run reads."
          empty={<>No analysis yet. {skipReason === "in-flight"
            ? "A teammate is on it."
            : "The next sweep will pick this note up, or press Triage now."}</>}
        />
      </div>

      {/* ─── Earlier rounds ──────────────────────────────────────── */}
      <EarlierAnalyses data={data} />
    </div>
  );
}

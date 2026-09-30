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
 * steer the next analysis, edit the note.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiPost, useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BackButton } from "@/components/ui/back-button";
import { AcceptanceCriteriaEditor } from "@/components/ui/acceptance-criteria-editor";
import { DirectoryInput } from "@/components/ui/directory-input";
import { noteClass } from "@/lib/thoughtColors";
import {
  analysesWithDecisions, editableFields, kindLabel, outcomeLabel, triageNowBlocked,
  type TriageProposal, type TriageProposalState, type TriageView,
} from "@/lib/triage";
import { Check, Lightbulb, Pencil, Play, StickyNote, X } from "lucide-react";

export function TriagePage() {
  const { id = "" } = useParams();
  const { data, refetch } = useApi<TriageView>(`/api/thoughts/${encodeURIComponent(id)}/triage`, [id], { pollInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  if (!data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const { note, entries, pending, latestOutcome, skipReason } = data;
  const rounds = analysesWithDecisions(entries);
  const latest = rounds.at(-1);
  const earlier = rounds.slice(0, -1);
  const blocked = triageNowBlocked(skipReason);

  /** Accept (optionally with the Edit form's changes), or reject. */
  const decide = async (proposalId: string, action: "accept" | "reject", overrides?: Partial<TriageProposal>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(
      `/api/thoughts/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/${action}`,
      overrides ? { overrides } : {},
    );
    setBusy(false);
    if (!res.success) { setError(res.error || `Could not ${action} that proposal`); return; }
    setEditing(null);
    refetch();
  };

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
        <div className="space-y-3">
          {!latest && (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">
              No analysis yet. {skipReason === "in-flight"
                ? "A teammate is on it."
                : "The next sweep will pick this note up, or press Triage now."}
            </CardContent></Card>
          )}
          {latest && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{latest.analysis.from}</span>
                  <span>·</span>
                  <span>{new Date(latest.analysis.at).toLocaleString()}</span>
                </div>
                <MarkdownView content={latest.analysis.body} />
                {latest.analysis.outcome === "question" && (
                  <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    Answer by editing the note — that's what the next run reads.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {pending.length > 0 && <h2 className="pt-1 text-sm font-medium">Waiting on you</h2>}
          {pending.map((state) => (
            <ProposalCard
              key={state.proposal.id}
              state={state}
              busy={busy}
              editing={editing === state.proposal.id}
              onEdit={() => setEditing(editing === state.proposal.id ? null : state.proposal.id)}
              onAccept={(overrides) => decide(state.proposal.id, "accept", overrides)}
              onReject={() => decide(state.proposal.id, "reject")}
            />
          ))}

          {latest && latest.decisions.length > 0 && (
            <div className="space-y-1">
              <h2 className="pt-1 text-sm font-medium">Decided</h2>
              {latest.decisions.map((d, i) => <DecisionRow key={i} decision={d} proposals={data.proposals} />)}
            </div>
          )}
        </div>
      </div>

      {/* ─── Earlier rounds ──────────────────────────────────────── */}
      {earlier.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Earlier analysis</h2>
          {[...earlier].reverse().map((round, i) => (
            <Card key={i}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{round.analysis.from}</span>
                  <span>·</span>
                  <span>{new Date(round.analysis.at).toLocaleString()}</span>
                  <Badge variant="secondary" className="text-[10px]">{outcomeLabel(round.analysis.outcome ?? null)}</Badge>
                </div>
                <MarkdownView content={round.analysis.body} className="text-[13px]" />
                {round.decisions.map((d, j) => <DecisionRow key={j} decision={d} proposals={data.proposals} />)}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** One decision, with a link to whatever accepting created. */
function DecisionRow({ decision, proposals }: { decision: TriageView["entries"][number] & { proposalId?: string }; proposals: TriageProposalState[] }) {
  const d = decision as { proposalId: string; action: string; workDefId?: string; storyId?: string; at: string };
  const title = proposals.find((s) => s.proposal.id === d.proposalId)?.proposal.title ?? d.proposalId;
  const link = d.workDefId && d.storyId
    ? `/task/${encodeURIComponent(d.storyId)}/${encodeURIComponent(d.workDefId)}`
    : d.workDefId
      ? `/work-defs/${encodeURIComponent(d.workDefId)}`
      : d.storyId
        ? `/story/${encodeURIComponent(d.storyId)}`
        : null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {d.action === "accepted"
        ? <Check className="h-3.5 w-3.5 shrink-0" />
        : <X className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{title}</span>
      <span>— {d.action}</span>
      {link && <Link to={link} className="text-primary hover:underline">open</Link>}
    </div>
  );
}

/** A pending proposal: what it would create, and the three ways to answer it. */
function ProposalCard({ state, busy, editing, onEdit, onAccept, onReject }: {
  state: TriageProposalState;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onAccept: (overrides?: Partial<TriageProposal>) => void;
  onReject: () => void;
}) {
  const p = state.proposal;
  const fields = editableFields(p.kind);
  const [draft, setDraft] = useState<Partial<TriageProposal>>({
    title: p.title, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, directory: p.directory, cron: p.cron,
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">{kindLabel(p.kind, p.storyId)}</Badge>
          <span className="font-mono text-[10px] text-muted-foreground">{p.id}</span>
          {p.cron && <Badge variant="secondary" className="font-mono text-[10px]">{p.cron}</Badge>}
        </div>

        {!editing ? (
          <>
            <h3 className="font-medium">{p.title}</h3>
            {p.goal && <MarkdownView content={p.goal} className="text-[13px]" />}
            {p.acceptanceCriteria && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Acceptance criteria</p>
                <MarkdownView content={p.acceptanceCriteria} className="text-[13px]" />
              </div>
            )}
            {p.tasks && p.tasks.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Tasks ({p.tasks.length})</p>
                <ol className="list-inside list-decimal space-y-0.5 text-[13px]">
                  {p.tasks.map((t, i) => <li key={i}><span className="font-medium">{t.title}</span> — {t.goal}</li>)}
                </ol>
              </div>
            )}
            {p.directory && <p className="font-mono text-[11px] text-muted-foreground">{p.directory}</p>}
          </>
        ) : (
          /* Edit before accepting: the same widgets the create forms use, sent as
             overrides so the decision still records this proposal. */
          <div className="space-y-3">
            {fields.includes("title") && (
              <div className="space-y-1">
                <Label>Title</Label>
                <Input value={draft.title ?? ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
            )}
            {fields.includes("goal") && (
              <div className="space-y-1">
                <Label>Goal</Label>
                <Textarea rows={3} value={draft.goal ?? ""} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
              </div>
            )}
            {fields.includes("acceptanceCriteria") && (
              <div className="space-y-1">
                <Label>Acceptance criteria</Label>
                <AcceptanceCriteriaEditor
                  value={draft.acceptanceCriteria ?? ""}
                  onChange={(v) => setDraft({ ...draft, acceptanceCriteria: v })}
                />
              </div>
            )}
            {fields.includes("cron") && (
              <div className="space-y-1">
                <Label>Cron</Label>
                <Input className="font-mono" value={draft.cron ?? ""} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} />
              </div>
            )}
            {fields.includes("directory") && (
              <div className="space-y-1">
                <Label>Directory</Label>
                <DirectoryInput value={draft.directory ?? ""} onChange={(v) => setDraft({ ...draft, directory: v })} />
              </div>
            )}
            {p.kind === "story" && (
              <p className="text-xs text-muted-foreground">
                Its {p.tasks?.length ?? 0} task(s) are created as proposed — edit them on the story afterwards.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={busy} onClick={() => onAccept(editing ? draft : undefined)}>
            <Check className="mr-1 h-4 w-4" />{editing ? "Create it" : "Accept"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
            <Pencil className="mr-1 h-4 w-4" />{editing ? "Cancel edit" : "Edit"}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={onReject}>
            <X className="mr-1 h-4 w-4" />Reject
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            Accepting creates it; nothing runs until the work's own rules say so.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

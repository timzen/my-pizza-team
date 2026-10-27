/**
 * TriageAnalysis — The analysis-and-proposals half of a triage view, shared by
 * both triage subjects (docs/DESIGN.md "Auto Triage: a Note Is a Parent",
 * "External sources" — "Triage mode"): a note's page (pages/TriagePage) and a
 * triage-mode external item's Triage tab (components/triage/MirrorTriagePanel).
 * What differs between them — the subject shown beside this, where decisions
 * are posted, the wording of "how to answer" — comes in as props.
 *
 *   LatestAnalysis   the latest analysis, its pending proposals with
 *                    **Accept / Edit / Reject**, and what was decided
 *   EarlierAnalyses  earlier rounds and their decisions
 *
 * **Accept** creates the work and nothing else; **Edit** opens the fields first
 * and sends them as overrides, so the decision still records the proposal;
 * **Reject** is one click, no reason. A proposal of a kind the team switched off
 * can only be rejected (the daemon would refuse it), with the reason shown.
 */

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { AcceptanceCriteriaEditor } from "@/components/ui/acceptance-criteria-editor";
import { DirectoryInput } from "@/components/ui/directory-input";
import { FEATURE_LABELS, featureForProposalKind } from "@/lib/features";
import { useFeatures } from "@/hooks/useFeatures";
import type { ProposalDecisions } from "@/hooks/useProposalDecisions";
import {
  analysesWithDecisions, editableFields, kindLabel, outcomeLabel,
  type TriageDecision, type TriageProposal, type TriageProposalState, type TriageThreadEntry,
} from "@/lib/triage";
import { Check, Pencil, X } from "lucide-react";

/** The thread parts both views read. */
export interface TriageThreadData {
  entries: TriageThreadEntry[];
  proposals: TriageProposalState[];
  pending: TriageProposalState[];
}

/** The latest analysis, the proposals waiting on you, and what you decided. */
export function LatestAnalysis({ data, decisions, empty, questionHint }: {
  data: TriageThreadData;
  decisions: ProposalDecisions;
  /** Shown when there's no analysis yet. */
  empty: ReactNode;
  /** Shown under a "question" analysis: how to answer it for this subject. */
  questionHint: string;
}) {
  const features = useFeatures();
  const latest = analysesWithDecisions(data.entries).at(-1);
  const { busy, editing, setEditing, decide } = decisions;

  /** Why a proposal can't be accepted: its kind is switched off (null when it can). */
  const offReason = (kind: string): string | null => {
    const feature = featureForProposalKind(kind);
    return features && !features[feature] ? `${FEATURE_LABELS[feature]} are turned off in Config` : null;
  };

  return (
    <div className="space-y-3">
      {!latest && (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">{empty}</CardContent></Card>
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
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{questionHint}</p>
            )}
          </CardContent>
        </Card>
      )}

      {data.pending.length > 0 && <h2 className="pt-1 text-sm font-medium">Waiting on you</h2>}
      {data.pending.map((state) => (
        <ProposalCard
          key={state.proposal.id}
          state={state}
          busy={busy}
          editing={editing === state.proposal.id}
          onEdit={() => setEditing(editing === state.proposal.id ? null : state.proposal.id)}
          onAccept={(overrides) => decide(state.proposal.id, "accept", overrides)}
          onReject={() => decide(state.proposal.id, "reject")}
          offReason={offReason(state.proposal.kind)}
        />
      ))}

      {latest && latest.decisions.length > 0 && (
        <div className="space-y-1">
          <h2 className="pt-1 text-sm font-medium">Decided</h2>
          {latest.decisions.map((d, i) => <DecisionRow key={i} decision={d} proposals={data.proposals} />)}
        </div>
      )}
    </div>
  );
}

/** Earlier rounds, newest first, each with the decisions that answered it. */
export function EarlierAnalyses({ data }: { data: TriageThreadData }) {
  const earlier = analysesWithDecisions(data.entries).slice(0, -1);
  if (earlier.length === 0) return null;
  return (
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
  );
}

/** One decision, with a link to whatever accepting created. */
function DecisionRow({ decision: d, proposals }: { decision: TriageDecision; proposals: TriageProposalState[] }) {
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
function ProposalCard({ state, busy, editing, onEdit, onAccept, onReject, offReason }: {
  state: TriageProposalState;
  busy: boolean;
  editing: boolean;
  /** Set when the proposal's kind is switched off: Accept/Edit are disabled. */
  offReason: string | null;
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
          <Button size="sm" disabled={busy || !!offReason} title={offReason ?? undefined} onClick={() => onAccept(editing ? draft : undefined)}>
            <Check className="mr-1 h-4 w-4" />{editing ? "Create it" : "Accept"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !!offReason} title={offReason ?? undefined} onClick={onEdit}>
            <Pencil className="mr-1 h-4 w-4" />{editing ? "Cancel edit" : "Edit"}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={onReject}>
            <X className="mr-1 h-4 w-4" />Reject
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {offReason
              ? <>{offReason} — turn them on under <Link to="/config" className="text-primary underline">Config → Work items</Link> to accept.</>
              : "Accepting creates it; nothing runs until the work's own rules say so."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

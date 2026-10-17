/**
 * WorkDefDefinition — The Details tab's definition section, shared by the
 * standalone WorkDef page and the board task page.
 *
 * Drafts (docs/DESIGN.md "Drafts: Write, Review, Publish"): a **draft** shows a
 * banner with **Edit** and **Publish**; Edit swaps the read-only view for the form
 * (Save / Cancel, via `PUT /api/work-defs/:id`). A **published** definition is
 * locked — the daemon refuses edits — so it renders read-only with a hint that
 * revisions go through the Thread plus a re-run. Publishing posts
 * `/api/work-defs/:id/publish`, after which the daemon may enqueue it.
 */

import { useState, type ReactNode } from "react";
import { apiPost, apiPut } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { MarkdownField } from "@/components/ui/markdown-field";
import { MarkdownView } from "@/components/ui/markdown-view";
import { AcceptanceCriteriaEditor } from "@/components/ui/acceptance-criteria-editor";
import { DirectoryInput } from "@/components/ui/directory-input";
import { ContextSelector } from "@/components/board/ContextSelector";
import { Lock, Pencil, Save, Send, X } from "lucide-react";

/** The WorkDef fields this section shows/edits (a subset of the API's WorkDefView). */
export interface WorkDefDefinitionData {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board" | "Triage";
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string | null;
  draft?: boolean;
}

interface Props {
  def: WorkDefDefinitionData;
  /** Label for the goal field ("Goal"; board tasks historically say "Description"). */
  goalLabel?: string;
  /** Called after a successful save or publish, so the host can refetch. */
  onChanged: () => void;
  /** Host actions rendered beside Edit/Save (e.g. Delete). */
  actions?: ReactNode;
}

/** What publishing does for each type, shown on the Publish button's tooltip. */
function publishHint(type: WorkDefDefinitionData["type"]): string {
  if (type === "Board") return "Lock the definition; the story admits it when it reaches this task";
  if (type === "Scheduled") return "Lock the definition; the job fires on its next cron time";
  return "Lock the definition and enqueue it now";
}

/** How to revise published work: the thread carries the change, a re-run applies it. */
function lockedHint(type: WorkDefDefinitionData["type"]): string {
  if (type === "Board") return "To revise it, add a comment on the Thread and move the task back into an agent state.";
  return "To revise the work, add a comment on the Thread and run it again.";
}

/** Small "Draft" badge used on headers, list rows, and board cards. */
export function DraftBadge({ className = "" }: { className?: string }) {
  return (
    <Badge variant="outline" className={`border-amber-500/60 text-amber-600 ${className}`} title="Draft — not dispatched until published">
      Draft
    </Badge>
  );
}

export function WorkDefDefinition({ def, goalLabel = "Goal", onChanged, actions }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [directory, setDirectory] = useState("");
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setTitle(def.title);
    setGoal(def.goal);
    setAcceptanceCriteria(def.acceptanceCriteria || "");
    setAdditionalContext(def.additionalContext || "");
    setDirectory(def.directory || "");
    setContextRefs(def.contextRefs ? [...def.contextRefs] : []);
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiPut<{ success: boolean; error?: string }>(`/api/work-defs/${encodeURIComponent(def.id)}`, {
        title, goal, acceptanceCriteria, additionalContext,
        directory: directory.trim() || null,
        contextRefs,
      });
      if (!res.success) { setError(res.error || "Failed to save"); return; }
      setEditing(false);
      onChanged();
    } finally { setBusy(false); }
  };

  const publish = async () => {
    if (editing && !confirm("Publish without saving your edits?")) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiPost<{ success: boolean; error?: string }>(`/api/work-defs/${encodeURIComponent(def.id)}/publish`, {});
      if (!res.success) { setError(res.error || "Failed to publish"); return; }
      setEditing(false);
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {def.draft ? (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <DraftBadge />
          <p className="text-sm text-muted-foreground flex-1">
            Teammates won't pick this up until you publish it. Once published, the definition is locked.
          </p>
          {!editing && <Button size="sm" variant="outline" onClick={startEdit}><Pencil className="h-3.5 w-3.5 mr-1" />Edit</Button>}
          <Button size="sm" onClick={publish} disabled={busy} title={publishHint(def.type)}><Send className="h-3.5 w-3.5 mr-1" />Publish</Button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" />Published — the definition is locked. {lockedHint(def.type)}
        </p>
      )}

      {editing ? (
        <>
          <div><div className="mb-2 pb-1 border-b border-border"><Label>Title</Label></div><Input value={title} onChange={e => setTitle(e.target.value)} /></div>
          <MarkdownField label={goalLabel} value={goal} onChange={setGoal} rows={3} />
          <div>
            <div className="mb-2 pb-1 border-b border-border"><Label>Acceptance criteria</Label></div>
            <div className="mt-1"><AcceptanceCriteriaEditor value={acceptanceCriteria} onChange={setAcceptanceCriteria} /></div>
          </div>
          <MarkdownField label="Additional context" value={additionalContext} onChange={setAdditionalContext} rows={2} />
          <div><div className="mb-2 pb-1 border-b border-border"><Label>Directory</Label></div><div className="mt-1"><DirectoryInput value={directory} onChange={setDirectory} /></div></div>
          <div><div className="mb-2 pb-1 border-b border-border"><Label>Context</Label></div><div className="mt-1"><ContextSelector value={contextRefs} onChange={setContextRefs} /></div></div>
        </>
      ) : (
        <>
          <ReadOnly label={goalLabel}>{def.goal ? <MarkdownView content={def.goal} /> : <Empty />}</ReadOnly>
          <ReadOnly label="Acceptance criteria">{def.acceptanceCriteria ? <MarkdownView content={def.acceptanceCriteria} /> : <Empty />}</ReadOnly>
          {def.additionalContext && <ReadOnly label="Additional context"><MarkdownView content={def.additionalContext} /></ReadOnly>}
          <ReadOnly label="Directory">{def.directory ? <span className="font-mono text-sm">{def.directory}</span> : <Empty />}</ReadOnly>
          {def.contextRefs && def.contextRefs.length > 0 && (
            <ReadOnly label="Context">
              <div className="flex flex-wrap gap-1">{def.contextRefs.map(r => <Badge key={r} variant="secondary" className="font-mono text-[10px]">{r}</Badge>)}</div>
            </ReadOnly>
          )}
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        {editing && (
          <>
            <Button onClick={save} disabled={busy}><Save className="h-4 w-4 mr-1" />Save draft</Button>
            <Button variant="outline" onClick={() => setEditing(false)}><X className="h-4 w-4 mr-1" />Cancel</Button>
          </>
        )}
        {actions}
      </div>
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 pb-1 border-b border-border"><Label>{label}</Label></div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Empty() {
  return <span className="text-sm text-muted-foreground italic">None</span>;
}

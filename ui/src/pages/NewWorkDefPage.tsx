/**
 * NewWorkDefPage — Create a standalone WorkDef (`/work-defs/new`).
 *
 * WorkDefs are work that doesn't live on the board: Solitary one-shots and
 * Scheduled cron jobs. The `?type=Solitary|Scheduled` query param picks the
 * mode (Scheduled adds a cron field with friendly presets; anything else —
 * including the retired `type=Template` — is Solitary). Templates are hidden
 * from the UI (being deprecated), so there is no template mode or
 * pre-fill-from-template here. Solitary work is enqueued immediately by
 * default; Scheduled work waits for its cron. **Save as pending** saves it without
 * letting anything run — no enqueue, no cron — until it's activated from its
 * detail page (docs/DESIGN.md "Pending: Write, Review, Activate"). On success,
 * lands on the created item's detail page.
 *
 * See the daemon's docs/DESIGN.md "The WorkItem" for the model.
 */

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownField } from "@/components/ui/markdown-field";
import { AcceptanceCriteriaEditor } from "@/components/ui/acceptance-criteria-editor";
import { DirectoryInput } from "@/components/ui/directory-input";
import { ContextSelector } from "@/components/board/ContextSelector";
import { BackButton } from "@/components/ui/back-button";
import { workDefHomePath } from "@/lib/nav-section";
import { apiPost } from "@/hooks/useApi";

type WorkDefType = "Solitary" | "Scheduled";

/** Friendly cron presets so a human rarely has to hand-write one. */
const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday 9am", cron: "0 9 * * 1" },
  { label: "First of month", cron: "0 9 1 * *" },
];

export function NewWorkDefPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The `?type=` param drives the mode; there's no in-UI type switch (you reach
  // this page from Work Items → Tasks or Schedule, or quick-create, and the
  // back arrow returns you there).
  const type: WorkDefType = searchParams.get("type") === "Scheduled" ? "Scheduled" : "Solitary";

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [directory, setDirectory] = useState("");
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [cron, setCron] = useState("0 9 * * *");
  const [enqueueNow, setEnqueueNow] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const backTo = workDefHomePath(type);

  // `pending` comes from which submit button was pressed (Create vs Save as pending).
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const pending = submitter?.value === "pending";
    setError("");
    if (!title.trim()) { setError("Title is required"); return; }
    if (!goal.trim()) { setError("Goal is required"); return; }

    const body: Record<string, unknown> = {
      title: title.trim(),
      type,
      goal: goal.trim(),
      acceptanceCriteria: acceptanceCriteria.trim() || undefined,
      additionalContext: additionalContext.trim() || undefined,
      directory: directory.trim() || undefined,
      contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
    };
    if (type === "Scheduled") body.cron = cron.trim();
    else if (type === "Solitary") body.enqueue = enqueueNow;
    if (pending) body.pending = true;

    setSaving(true);
    try {
      const res = await apiPost<{ success: boolean; error?: string; workDef?: { id: string } }>("/api/work-defs", body);
      // replace: the submitted form shouldn't be what Back returns to.
      if (res.success && res.workDef) navigate(`/work-defs/${encodeURIComponent(res.workDef.id)}`, { replace: true });
      else setError(res.error || "Failed to create work");
    } finally {
      setSaving(false);
    }
  };

  const heading = type === "Scheduled" ? "New Scheduled Job" : "New Solitary Task";
  const submitLabel = type === "Scheduled" ? "Job" : "Task";

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback={backTo} title="Back" />
        <h1 className="text-2xl font-bold">{heading}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div><div className="mb-2 pb-1 border-b border-border"><Label htmlFor="wd-title">Title</Label></div><Input id="wd-title" value={title} onChange={e => setTitle(e.target.value)} required /></div>

        <MarkdownField label="Goal" value={goal} onChange={setGoal} rows={3} required defaultEditing />
        <div>
          <div className="mb-2 pb-1 border-b border-border"><Label>Acceptance criteria</Label></div>
          <div className="mt-1">
            <AcceptanceCriteriaEditor value={acceptanceCriteria} onChange={setAcceptanceCriteria} />
          </div>
        </div>
        <MarkdownField label="Additional context" value={additionalContext} onChange={setAdditionalContext} rows={2} />

        <div><div className="mb-2 pb-1 border-b border-border"><Label htmlFor="wd-dir">Directory</Label></div><p className="text-xs text-muted-foreground mb-1">Where the work happens — the agent cds here. Also biases which teammate picks it up.</p><DirectoryInput id="wd-dir" value={directory} onChange={setDirectory} /></div>

        <div><div className="mb-2 pb-1 border-b border-border"><Label>Context</Label></div><p className="text-xs text-muted-foreground mb-1">Attached entries are injected into the work prompt.</p><ContextSelector value={contextRefs} onChange={setContextRefs} /></div>

        {type === "Scheduled" ? (
          <div>
            <div className="mb-2 pb-1 border-b border-border"><Label htmlFor="wd-cron">Schedule (cron)</Label></div>
            <p className="text-xs text-muted-foreground mb-1">5-field cron (minute hour day month weekday). Pick a preset or edit.</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {CRON_PRESETS.map(p => (
                <Button key={p.cron} type="button" variant={cron === p.cron ? "default" : "outline"} size="sm" onClick={() => setCron(p.cron)}>{p.label}</Button>
              ))}
            </div>
            <Input id="wd-cron" className="font-mono" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" />
          </div>
        ) : type === "Solitary" ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enqueueNow} onChange={e => setEnqueueNow(e.target.checked)} />
            Enqueue immediately (uncheck to save without running yet)
          </label>
        ) : null}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" value="create" disabled={saving}>{saving ? "Creating…" : `Create ${submitLabel}`}</Button>
          <Button type="submit" value="pending" variant="secondary" disabled={saving} title="Save it for review: nothing runs until you activate it">Save as pending</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

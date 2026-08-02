/**
 * NewWorkDefPage — Create a standalone WorkDef (`/work-defs/new`).
 *
 * WorkDefs are work that doesn't live on the board: Solitary one-shots and
 * Scheduled cron jobs. The `?type=Solitary|Scheduled` query param picks the
 * mode (Scheduled adds a cron field with friendly presets). Solitary work is
 * enqueued immediately by default; Scheduled work waits for its cron. On
 * success, lands on the new WorkDef's detail page.
 *
 * See the daemon's docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md for the model.
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
  // this page from either the Tasks or Schedule page, and the back arrow
  // returns you to that single type).
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

  const backTo = type === "Scheduled" ? "/schedule" : "/tasks";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    else body.enqueue = enqueueNow;

    setSaving(true);
    try {
      const res = await apiPost<{ success: boolean; error?: string; workDef?: { id: string } }>("/api/work-defs", body);
      if (res.success && res.workDef) navigate(`/work-defs/${encodeURIComponent(res.workDef.id)}`);
      else setError(res.error || "Failed to create work");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback={backTo} title="Back" />
        <h1 className="text-2xl font-bold">New {type === "Scheduled" ? "Scheduled Job" : "Solitary Task"}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div><Label htmlFor="wd-title">Title</Label><Input id="wd-title" value={title} onChange={e => setTitle(e.target.value)} required /></div>

        <MarkdownField label="Goal" value={goal} onChange={setGoal} rows={3} required defaultEditing />
        <div>
          <Label>Acceptance criteria</Label>
          <div className="mt-1">
            <AcceptanceCriteriaEditor value={acceptanceCriteria} onChange={setAcceptanceCriteria} />
          </div>
        </div>
        <MarkdownField label="Additional context" value={additionalContext} onChange={setAdditionalContext} rows={2} />

        <div><Label htmlFor="wd-dir">Directory</Label><p className="text-xs text-muted-foreground mb-1">Where the work happens — the agent cds here. Also biases which teammate picks it up.</p><DirectoryInput id="wd-dir" value={directory} onChange={setDirectory} /></div>

        <div><Label>Context</Label><p className="text-xs text-muted-foreground mb-1">Attached entries are injected into the work prompt.</p><ContextSelector value={contextRefs} onChange={setContextRefs} /></div>

        {type === "Scheduled" ? (
          <div>
            <Label htmlFor="wd-cron">Schedule (cron)</Label>
            <p className="text-xs text-muted-foreground mb-1">5-field cron (minute hour day month weekday). Pick a preset or edit.</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {CRON_PRESETS.map(p => (
                <Button key={p.cron} type="button" variant={cron === p.cron ? "default" : "outline"} size="sm" onClick={() => setCron(p.cron)}>{p.label}</Button>
              ))}
            </div>
            <Input id="wd-cron" className="font-mono" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" />
          </div>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enqueueNow} onChange={e => setEnqueueNow(e.target.checked)} />
            Enqueue immediately (uncheck to save without running yet)
          </label>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>{saving ? "Creating…" : `Create ${type === "Scheduled" ? "Job" : "Task"}`}</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

/**
 * WorkflowDetailPage — Shows and edits a single workflow.
 *
 * A workflow is an ordered pipeline of active states between the implicit
 * `todo` and `done` buckets (see daemon docs/DESIGN.md "The Work Model"). This page renders
 * the pipeline, lets you edit the states (add/remove/reorder, teammate|manual
 * type), and pick each teammate state's **persona** from the library (docs/DESIGN.md
 * "Personas"): a picker per state, saved at once with `PUT
 * /api/workflows/:name/states/:state { persona }`, plus an edit/view link to
 * the persona itself on Config → Personas. Unset = no persona block, just the
 * one-line state framing. (The per-state `<state>.md` files became personas.)
 *
 * Each teammate state's **completion** (docs/DESIGN.md "Polling States") is
 * edited in Edit States: Single run (the default) or Poll until complete, with
 * the interval, time limit and on-timeout behavior (lib/workflow-poll.ts). It is
 * validated with the daemon's own rule before Save, and saved with the rest of
 * the states. Manual states have no completion control; a poll state's
 * pipeline chip carries a "poll" badge.
 *
 * **Delete** (`DELETE /api/workflows/:name`) moves the workflow's folder to
 * `workflows/.deleted/`, after a confirm that says how many done stories will
 * fall back to the default workflow. It's disabled with a reason for the
 * default or the last workflow (lib/workflows.ts); the daemon's refusal (409,
 * e.g. open stories still use it) shows under the header. Then back to the list.
 *
 * Rendered inside the Config page's Workflows tab at `/config/workflows/:name`
 * (ConfigPage supplies the tab bar and outer layout).
 */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi, apiPut, apiDelete } from "@/hooks/useApi";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { notifyPersonasChanged } from "@/hooks/usePersonas";
import { PERSONAS_TAB_PATH } from "@/lib/personas";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { GitBranch, Pencil, ArrowRight, Trash2, ChevronUp, ChevronDown, Plus, Bot, User } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import type { WorkflowConfig, WorkflowState } from "@shared/types";
import { Tooltip } from "@/components/ui/tooltip";
import { FormError } from "@/components/ui/form-error";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { workflowDeleteBlockedReason, workflowDeleteDescription } from "@/lib/workflows";
import {
  DEFAULT_POLL_TIMEOUT, asManual, isPollingState, pollErrorText, pollSummary, withCompletion, withPollField, workflowPollErrors,
} from "@/lib/workflow-poll";
import type { PollConfigError } from "@shared/poll-config";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldHint } from "@/components/ui/field-hint";
import { describedBy } from "@/lib/field-help";
import type { DeleteWorkflowResponse, WorkflowUsageResponse } from "@shared/protocol";

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, WorkflowConfig>;
  [key: string]: unknown;
}

export function WorkflowDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { data, loading, refetch } = useApi<WorkflowConfig>(`/api/workflows/${name}`);
  const { data: configData, refetch: refetchConfig } = useApi<ConfigData>("/api/config");
  const [editing, setEditing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Only before the first answer: the refetch after a save keeps the page (and
  // any text selection) mounted (docs/DESIGN.md "Polling Never Disturbs the
  // Reader"). ConfigPage keys this page by name, so another workflow starts fresh.
  if (loading && !data) return <div className="text-muted-foreground">Loading...</div>;
  if (!data) return <div className="text-muted-foreground">Workflow not found.</div>;

  const isDefault = configData?.defaultWorkflow === name;
  const teammateCount = data.states.filter(s => s.type === "teammate").length;

  const handleSaved = () => {
    refetch();
    refetchConfig();
    setEditing(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BackButton fallback="/config/workflows" title="Back to workflows" />
          <GitBranch className="h-5 w-5" />
          <h2 className="text-xl font-bold">{name}</h2>
          <span className="text-sm text-muted-foreground">
            {data.states.length} states · {teammateCount} teammate · {data.states.length - teammateCount} manual
            {isDefault && " · default"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(v => !v)} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> {editing ? "Close Editor" : "Edit States"}
          </Button>
          {configData && (
            <DeleteWorkflowButton name={name!} defaultWorkflow={configData.defaultWorkflow} workflowCount={Object.keys(configData.workflows).length}
              onError={setDeleteError} />
          )}
        </div>
      </div>
      <FormError id="delete-workflow-error" className="text-sm">{deleteError}</FormError>

      {/* Pipeline visualization: todo → active states → done */}
      <section>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          Pipeline
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <BucketChip label="todo" />
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          {data.states.map((s) => (
            <span key={s.name} className="flex items-center gap-2">
              <StateChip state={s} />
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </span>
          ))}
          <BucketChip label="done" />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          <span className="font-medium">todo</span> and <span className="font-medium">done</span> are implicit buckets.
          Admission pulls one task per story from todo (CONWIP); completed teammate work advances automatically;
          tasks in <span className="font-medium">manual</span> states wait for you to move them.
        </p>
      </section>

      {/* Inline states editor */}
      {editing && configData && (
        <StatesEditor name={name!} workflow={data} config={configData} onSaved={handleSaved} />
      )}

      {/* State personas (teammate states only — manual states never get a prompt) */}
      <section>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          State Personas
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          The persona a teammate works with when it claims a task in each teammate state — its role framing, injected
          into the prompt. Pick one from the library; write or customize them on{" "}
          <Link to={PERSONAS_TAB_PATH} className="text-primary underline">Personas</Link>. Applies to the next claim.
        </p>
        <StatePersonas name={name!} states={data.states} onSaved={refetch} />
      </section>
    </div>
  );
}

/**
 * Delete this workflow: disabled (with the reason as its tooltip) for the
 * default or the last workflow; otherwise a confirm naming how many done
 * stories will fall back to the default, then `DELETE /api/workflows/:name`.
 * A refusal (409 — e.g. open stories use it, listed in the message) goes to
 * `onError`, which the page shows below the header row (`delete-workflow-error`);
 * success goes back to the workflows list.
 */
function DeleteWorkflowButton({ name, defaultWorkflow, workflowCount, onError }: {
  name: string;
  defaultWorkflow: string;
  workflowCount: number;
  onError: (error: string | null) => void;
}) {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [confirmDialog, confirm] = useConfirm();
  const [busy, setBusy] = useState(false);
  const blocked = workflowDeleteBlockedReason({ isDefault: name === defaultWorkflow, workflowCount });

  const remove = async () => {
    setBusy(true);
    onError(null);
    try {
      // Read the usage at the moment of asking, so the count is current.
      const usage = await fetch(`/api/workflows/${encodeURIComponent(name)}/usage`).then((r) => r.json() as Promise<WorkflowUsageResponse>);
      if (!(await confirm({
        title: `Delete workflow “${name}”?`,
        description: workflowDeleteDescription(defaultWorkflow, usage.doneStories?.length ?? 0),
        confirmLabel: "Delete",
        destructive: true,
      }))) return;
      const res = await apiDelete<DeleteWorkflowResponse>(`/api/workflows/${encodeURIComponent(name)}`);
      if (!res.success) { onError(res.error || "Couldn't delete it"); return; }
      announce(`Deleted workflow ${name}`);
      navigate("/config/workflows", { replace: true });
    } catch (e) {
      onError("Network error: " + (e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      {confirmDialog}
      <Tooltip content={blocked ?? "Delete this workflow (its folder is kept as a backup)"}>
        <Button size="sm" variant="ghost" className="text-destructive gap-1.5" onClick={remove} disabled={busy || blocked !== null} focusableWhenDisabled>
          <Trash2 className="h-3.5 w-3.5" />Delete
        </Button>
      </Tooltip>
    </>
  );
}

/**
 * A persona picker per teammate state (manual states never get a prompt). Each
 * change saves at once; a refusal (e.g. an id that doesn't resolve) shows on
 * its row.
 */
function StatePersonas({ name, states, onSaved }: { name: string; states: WorkflowState[]; onSaved: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const announce = useAnnounce();
  const teammateStates = states.filter((s) => s.type === "teammate");

  const pick = async (state: string, persona: string | null) => {
    setSaving(state);
    setErrors((e) => ({ ...e, [state]: "" }));
    try {
      const res = await apiPut<{ success: boolean; error?: string }>(
        `/api/workflows/${encodeURIComponent(name)}/states/${encodeURIComponent(state)}`, { persona },
      );
      if (!res.success) setErrors((e) => ({ ...e, [state]: res.error || "Save failed" }));
      else { onSaved(); void notifyPersonasChanged(); announce(`Saved the persona for ${state.replace(/_/g, " ")}`); }
    } catch (e) {
      setErrors((x) => ({ ...x, [state]: (e as Error).message }));
    }
    setSaving(null);
  };

  if (teammateStates.length === 0) return <p className="text-xs text-muted-foreground italic">No teammate states.</p>;
  return (
    <div className="rounded-lg border border-border divide-y divide-border">
      {teammateStates.map((s) => (
        <div key={s.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
          <span className="flex w-40 items-center gap-1.5 text-sm font-medium"><Bot className="h-3.5 w-3.5 text-muted-foreground" />{s.name.replace(/_/g, " ")}</span>
          <PersonaPicker
            id={`state-persona-${s.name}`}
            label={`Persona for ${s.name.replace(/_/g, " ")}`}
            kind="teammate"
            value={s.persona ?? null}
            onChange={(p) => pick(s.name, p)}
            noneLabel="No persona (state framing only)"
            disabled={saving === s.name}
            errorId={errors[s.name] ? `state-persona-${s.name}-error` : undefined}
          />
          <FormError id={`state-persona-${s.name}-error`} className="text-xs">{errors[s.name]}</FormError>
        </div>
      ))}
    </div>
  );
}

/** An implicit bucket chip (todo/done). */
function BucketChip({ label }: { label: string }) {
  return (
    <span className="px-3 py-1.5 rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {label}
    </span>
  );
}

/** An active-state chip with its teammate/manual type. */
function StateChip({ state }: { state: WorkflowState }) {
  const isTeammate = state.type === "teammate";
  return (
    <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm ${isTeammate ? "border-blue-300 bg-blue-50 dark:bg-blue-950 dark:border-blue-800" : "border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800"}`}>
      {isTeammate ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      {state.name.replace(/_/g, " ")}
      <Badge variant="outline" className="text-[10px] px-1 py-0">{state.type}</Badge>
      {isPollingState(state) && <PollBadge state={state} />}
    </span>
  );
}

/** A poll state's "poll" badge, its rhythm in the tooltip (a tab stop: the tooltip is the only place it shows). */
function PollBadge({ state }: { state: WorkflowState }) {
  return (
    <Tooltip content={pollSummary(state)} focusable>
      <Badge variant="outline" className="text-[10px] px-1 py-0 border-blue-400 text-blue-700 dark:text-blue-300">poll</Badge>
    </Tooltip>
  );
}

/** Inline editor for a workflow's ordered states (name, type, order, and a teammate state's completion). */
function StatesEditor({ name, workflow, config, onSaved }: {
  name: string;
  workflow: WorkflowConfig;
  config: ConfigData;
  onSaved: () => void;
}) {
  const [states, setStates] = useState<WorkflowState[]>(workflow.states);
  const [newState, setNewState] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which field the error is about: the new state's name, or the list as a whole (Save).
  const [nameInvalid, setNameInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const announce = useAnnounce();

  // Re-seed the editable state list when the workflow prop changes
  // (render-time adjustment; see React's "you might not need an effect").
  const [seededFrom, setSeededFrom] = useState(workflow.states);
  if (workflow.states !== seededFrom) {
    setSeededFrom(workflow.states);
    setStates(workflow.states);
  }

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...states];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    setStates(next);
  };

  // Switching a state to manual drops its completion fields (a manual state has no teammate to poll).
  const toggleType = (idx: number) => {
    setStates(states.map((s, i) => i === idx ? (s.type === "teammate" ? asManual(s) : { ...s, type: "teammate" }) : s));
  };

  const updateState = (idx: number, next: WorkflowState) => setStates(states.map((s, i) => i === idx ? next : s));

  // The daemon's completion rule, run as you edit; shown once Save was tried.
  const pollErrors = workflowPollErrors(states);
  const [showPollErrors, setShowPollErrors] = useState(false);

  const remove = (idx: number) => setStates(states.filter((_, i) => i !== idx));

  const add = () => {
    const slug = newState.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!slug) return;
    if (slug === "todo" || slug === "done") { setError(`"${slug}" is a reserved bucket name`); setNameInvalid(true); return; }
    if (states.some(s => s.name === slug)) { setError(`State "${slug}" already exists`); setNameInvalid(true); return; }
    setStates([...states, { name: slug, type: "teammate" }]);
    setNewState("");
    setError(null);
    setNameInvalid(false);
    announce(`Added ${slug.replace(/_/g, " ")} — Save to keep it`);
  };

  const save = async () => {
    if (states.length === 0) { setError("A workflow needs at least one state"); return; }
    if (Object.keys(pollErrors).length > 0) {
      setShowPollErrors(true);
      setError("Fix the highlighted polling settings first");
      return;
    }
    setSaving(true);
    setError(null);
    setNameInvalid(false);
    try {
      const updatedConfig = { ...config, workflows: { ...config.workflows, [name]: { states } } };
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", updatedConfig);
      if (res.success) { onSaved(); announce(`Saved the ${name} workflow's states`); }
      else setError(res.error || "Failed to save");
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    }
    setSaving(false);
  };

  return (
    <section className="border border-border rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-semibold">Edit States</h3>
      {states.map((s, idx) => (
        <div key={s.name} className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <IconButton className="h-5 w-5" disabled={idx === 0} onClick={() => move(idx, -1)} label={`Move ${s.name.replace(/_/g, " ")} up`}><ChevronUp className="h-3 w-3" /></IconButton>
            <IconButton className="h-5 w-5" disabled={idx === states.length - 1} onClick={() => move(idx, 1)} label={`Move ${s.name.replace(/_/g, " ")} down`}><ChevronDown className="h-3 w-3" /></IconButton>
          </div>
          <span className="flex-1 text-sm font-medium">{s.name.replace(/_/g, " ")}</span>
          <Tooltip content="Toggle who works this state">
            <Button variant="outline" size="sm" onClick={() => toggleType(idx)}>
              {s.type === "teammate" ? <><Bot className="h-3.5 w-3.5 mr-1" />teammate</> : <><User className="h-3.5 w-3.5 mr-1" />manual</>}
            </Button>
          </Tooltip>
          <IconButton className="h-7 w-7 text-destructive" onClick={() => remove(idx)} label={`Remove ${s.name.replace(/_/g, " ")}`}><Trash2 className="h-3.5 w-3.5" /></IconButton>
        </div>
        {s.type === "teammate" && (
          <CompletionControls state={s} onChange={(next) => updateState(idx, next)} error={showPollErrors ? pollErrors[s.name] : undefined} />
        )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <Input
          aria-label="New state name" placeholder="New state name…"
          value={newState}
          onChange={e => { setNewState(e.target.value); if (nameInvalid) { setNameInvalid(false); setError(null); } }}
          onKeyDown={e => { if (e.key === "Enter") add(); }}
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? "states-editor-error" : undefined}
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={add} disabled={!newState.trim()}><Plus className="h-3.5 w-3.5 mr-1" />Add</Button>
        <div className="flex-1" />
        <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      <FormError id="states-editor-error" className="text-xs">{error}</FormError>
    </section>
  );
}

/**
 * A teammate state's completion controls in the states editor: Single run vs
 * Poll until complete and, for Poll, the interval, the time limit and what
 * happens when it runs out. `error` (the daemon's rule, lib/workflow-poll.ts)
 * marks the field it's about.
 */
function CompletionControls({ state, onChange, error }: {
  state: WorkflowState;
  onChange: (next: WorkflowState) => void;
  error?: PollConfigError;
}) {
  const key = `state-${state.name}`;
  const label = state.name.replace(/_/g, " ");
  const poll = isPollingState(state);
  const errorId = error ? `${key}-poll-error` : undefined;
  const fieldError = (f: PollConfigError["field"]) => error?.field === f;
  return (
    <div className="ml-7 pl-3 border-l border-border space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium" aria-hidden>Completion</span>
        <Select value={poll ? "poll" : "once"} onValueChange={(v) => onChange(withCompletion(state, v === "poll" ? "poll" : "once"))}>
          <SelectTrigger size="sm" className="w-48" aria-label={`Completion, for ${label}`}
            aria-describedby={`${key}-completion-hint`}>
            <SelectValue>{(v: string) => (v === "poll" ? "Poll until complete" : "Single run")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="once">Single run</SelectItem>
            <SelectItem value="poll">Poll until complete</SelectItem>
          </SelectContent>
        </Select>
        <FieldHint id={`${key}-completion-hint`} field="stateCompletion" className="basis-full" />
      </div>
      {poll && (
        <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 items-start">
          <Label htmlFor={`${key}-poll-every`} className="text-xs pt-1.5">Check every</Label>
          <div className="space-y-1">
            <Input
              id={`${key}-poll-every`} aria-label={`Check every, for ${label}`} className="h-7 w-32 font-mono text-xs" placeholder="15m"
              value={state.pollEvery ?? ""}
              onChange={(e) => onChange(withPollField(state, "pollEvery", e.target.value))}
              aria-invalid={fieldError("pollEvery") || undefined}
              aria-describedby={describedBy(fieldError("pollEvery") && errorId, `${key}-poll-every-hint`)}
            />
            <FieldHint id={`${key}-poll-every-hint`} field="pollEvery" />
          </div>
          <Label htmlFor={`${key}-poll-timeout`} className="text-xs pt-1.5">Time limit</Label>
          <div className="space-y-1">
            <Input
              id={`${key}-poll-timeout`} aria-label={`Time limit, for ${label}`} className="h-7 w-32 font-mono text-xs" placeholder={DEFAULT_POLL_TIMEOUT}
              value={state.pollTimeout ?? ""}
              onChange={(e) => onChange(withPollField(state, "pollTimeout", e.target.value))}
              aria-invalid={fieldError("pollTimeout") || undefined}
              aria-describedby={describedBy(fieldError("pollTimeout") && errorId, `${key}-poll-timeout-hint`)}
            />
            <FieldHint id={`${key}-poll-timeout-hint`} field="pollTimeout" />
          </div>
          <span className="text-xs font-medium pt-1.5" aria-hidden>On timeout</span>
          <div className="space-y-1">
            <Select value={state.onTimeout ?? "manual"} onValueChange={(v) => onChange(withPollField(state, "onTimeout", v === "fail" ? "fail" : "manual"))}>
              <SelectTrigger size="sm" className="w-48" aria-label={`On timeout, for ${label}`}
                aria-describedby={`${key}-on-timeout-hint`}>
                <SelectValue>{(v: string) => (v === "fail" ? "Fail the task" : "Needs attention")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Needs attention</SelectItem>
                <SelectItem value="fail">Fail the task</SelectItem>
              </SelectContent>
            </Select>
            <FieldHint id={`${key}-on-timeout-hint`} field="onTimeout" />
          </div>
        </div>
      )}
      <FormError id={errorId} className="text-xs">{error ? pollErrorText(error) : null}</FormError>
    </div>
  );
}

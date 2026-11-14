/**
 * AssistantSettings — Config → General's **Assistant** card: the assistant's
 * persona picker (applied at once via PUT /api/assistant/persona) and, beside
 * it, its model picker (the leader's available models; applied at once too, as
 * a `set-model` for the leader — docs/DESIGN.md "Choosing a Model"). How the
 * assistant looks isn't a setting: the dock's size picks it — the chat docked,
 * the terminal at Full page (lib/assistant-mode.ts `assistantView`).
 */

import { useState } from "react";
import { useApi, apiPut } from "@/hooks/useApi";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormError } from "@/components/ui/form-error";
import { useAgentModel } from "@/hooks/useAgentModel";
import { MODEL_SWITCHING_UNSUPPORTED, currentRef, modelChipView } from "@/lib/models";
import { roleOf, type Teammate } from "@/lib/team";

/** The Assistant card. Nothing here is in the page's config.json draft. */
export function AssistantSettings() {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Assistant</h2>
        <p className="text-xs text-muted-foreground">
          In the dock the assistant is a chat with message bubbles; switch the dock to Full page for a
          terminal view of its whole session, tool calls included.
        </p>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-border pt-3">
          <AssistantPersonaSetting />
          <AssistantModelSetting />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Who the assistant is: its persona (`assistant.persona`; unset =
 * `builtin:assistant`). Unlike the rest of the card this applies at once —
 * `PUT /api/assistant/persona` ends the current chat (it stays in the session
 * history) and starts a new one, as picking a chip in the chat does.
 */
function AssistantPersonaSetting() {
  const { data, refetch } = useApi<{ personaId: string | null }>("/api/assistant/persona");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const pick = async (personaId: string | null) => {
    if (busy || personaId === (data?.personaId ?? null)) return;
    if (!(await confirm({
      title: "Switch the assistant's persona?",
      description: "It ends the current chat (it stays in the history) and starts a new one.",
      confirmLabel: "Switch",
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPut<{ success: boolean; error?: string }>("/api/assistant/persona", { personaId });
      if (!res.success) setError(res.error || "Couldn't switch it");
      await refetch();
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1">
      {confirmDialog}
      <Label htmlFor="assistant-persona">Persona</Label>
      <PersonaPicker
        id="assistant-persona"
        kind="assistant"
        value={data?.personaId ?? null}
        onChange={pick}
        noneLabel="Built-in assistant (default)"
        exclude={["builtin:assistant"]}
        disabled={busy || !data}
      />
      <p className="text-xs text-muted-foreground">Applies at once: a new chat starts with the chosen persona.</p>
      <FormError className="text-xs">{error}</FormError>
    </div>
  );
}

/**
 * The assistant's model: the leader's available models, a pick applied at once
 * (POST /api/agents/:leaderId/model — a pin the leader switches to after its
 * current reply; "Default" clears it). Shows "switching to …" until the leader
 * reports it, then the model; a refusal says why. Without a live leader, or
 * with a harness that can't switch models, the select is disabled and says so.
 */
function AssistantModelSetting() {
  const { data: agents } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10000 });
  const leader = agents?.agents.find((a) => roleOf(a) === "leader" && a.status !== "offline") ?? null;
  const { state, pick, busy, pending, pendingModel, error } = useAgentModel(leader?.id ?? null, "The assistant");
  const view = modelChipView(state, leader?.session?.model);
  const models = state?.models ?? [];
  // While a pick is pending, show it selected (the pin moves once the leader reports it done).
  const value = (pending ? pendingModel : state?.pin) ?? "";
  const running = currentRef(state);
  const hint = !leader
    ? "The assistant isn't running: start it to choose its model."
    : state && !state.supported ? `${MODEL_SWITCHING_UNSUPPORTED}.`
    : pending ?? view.pending ? `Switching to ${pending ?? view.pending} after its current reply…`
    : `Running ${view.label}${view.pinned ? " (pinned)" : ""}${view.failover ? " (failover)" : ""}. Applies at once, after its current reply.`;
  return (
    <div className="space-y-1">
      <Label htmlFor="assistant-model">Model</Label>
      <select
        id="assistant-model"
        value={value}
        disabled={busy || !view.changeable}
        onChange={(e) => { void pick(e.target.value || null); }}
        className="h-8 min-w-[220px] max-w-[360px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
        aria-describedby={error ? "assistant-model-hint assistant-model-error" : "assistant-model-hint"}
        aria-invalid={!!error || undefined}
      >
        <option value="">Default (its persona&apos;s or the team&apos;s)</option>
        {value && !models.some((m) => m.ref === value) && <option value={value}>{value}</option>}
        {models.map((m) => (
          <option key={m.ref} value={m.ref}>{m.name}{m.ref === running && !value ? " (running)" : ""}</option>
        ))}
      </select>
      <p id="assistant-model-hint" className="text-xs text-muted-foreground">{hint}</p>
      <FormError id="assistant-model-error" className="text-xs">{error}</FormError>
    </div>
  );
}

/**
 * AssistantSettings — Config → General's **Assistant** card: the assistant's
 * persona picker (applied at once via PUT /api/assistant/persona). How the
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
        <AssistantPersonaSetting />
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
    <div className="space-y-1 border-t border-border pt-3">
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

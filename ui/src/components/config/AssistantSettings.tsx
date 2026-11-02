/**
 * AssistantSettings — Config → General's **Assistant** card: the chat-mode
 * radio (in the page's draft) and the assistant's persona picker (applied at
 * once via PUT /api/assistant/persona).
 */

import { useState } from "react";
import { useApi, apiPut } from "@/hooks/useApi";
import type { ConfigDraftProps } from "@/lib/config-draft";
import { PersonaPicker } from "@/components/personas/PersonaPicker";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";

// --- Assistant chat mode (docs/DESIGN.md "Assistant Chat Model") ---

/**
 * The `assistant.chatMode` picker: iMessage-style bubbles (default) or the same
 * terminal transcript and composer used to watch and pair with a teammate.
 * Applies live once saved — the leader picks up the matching system prompt on
 * its next run, with no restart and no new session.
 */
export function AssistantChatModeSetting({ config, setConfig }: ConfigDraftProps) {
  const mode = config.assistant?.chatMode === "terminal" ? "terminal" : "chat";
  const set = (chatMode: "chat" | "terminal") => setConfig({ ...config, assistant: { ...config.assistant, chatMode } });
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Assistant</h2>
        <p className="text-xs text-muted-foreground">
          How you talk to the assistant: a chat with message bubbles, or a terminal view of its session —
          the same view you get when you watch and pair with a teammate.
        </p>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="assistant-chat-mode" id="assistant-chat-mode-chat"
              checked={mode === "chat"} onChange={() => set("chat")} />
            Chat (bubbles)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="assistant-chat-mode" id="assistant-chat-mode-terminal"
              checked={mode === "terminal"} onChange={() => set("terminal")} />
            Terminal (like watching a teammate)
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Takes effect as soon as you save: the assistant's next reply follows the new style. The current
          conversation carries on — no restart or new chat needed.
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
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * StallCallout — The teammate page's notice while the teammate is **stalled**
 * (docs/DESIGN.md "Stalled Teammates"): alive and working on its item, but
 * nothing has completed for longer than its threshold — the 13-hour hung
 * `node --test` it exists for.
 *
 * It says how long (lib/stall.ts `stallCallout`), what the teammate is running
 * and since when, and when progress last happened. Then what you can do:
 *
 *   - **Interrupt** (POST /api/agents/:id/interrupt): after a confirm, the
 *     teammate's harness aborts the run — the stuck command's whole process
 *     tree — keeps its work item, and asks the agent to find out why it hung
 *     and re-run with a timeout. The callout then says it was sent / done /
 *     failed (lib/stall.ts `interruptState`, from `AgentView.lastInterrupt`).
 *     A harness that can't (an older one, `mpt agent`) gets the reason and a
 *     pointer to Pair instead;
 *   - **Pair** — the page's own button, pointed to: talk it through yourself.
 *
 * `readOnly` is the phone's (`/m`): the notice without Interrupt, which is the
 * desktop's. Renders nothing when the teammate isn't stalled.
 */

import { useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useNow } from "@/hooks/useNow";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { AlertTriangle, OctagonX } from "lucide-react";
import { interruptState, stallCallout } from "@/lib/stall";
import type { AgentView, InterruptResponse } from "@shared/protocol";

export function StallCallout({ agent, readOnly = false, onChanged }: { agent: AgentView; readOnly?: boolean; onChanged?: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const announce = useAnnounce();
  const now = useNow();
  const stall = agent.stalled;
  if (!stall) return null;

  const text = stallCallout(stall, Math.max(now, stall.since));
  const state = interruptState(agent, stall);

  const interrupt = async () => {
    if (sending) return;
    if (!(await confirm({
      title: "Interrupt its stuck command?",
      description: `${text.running ? `${text.running} is stopped` : "Its run is stopped"}, and ${agent.name} is asked to find out why it hung, re-run it with a timeout, and carry on. It keeps its work item.`,
      confirmLabel: "Interrupt",
      destructive: true,
    }))) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiPost<InterruptResponse & { error?: string }>(`/api/agents/${encodeURIComponent(agent.id)}/interrupt`, {});
      if (!res.success) { setError(res.error || "Couldn't interrupt it"); return; }
      announce(`Interrupt sent to ${agent.name}.`);
      onChanged?.();
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    } finally { setSending(false); }
  };

  return (
    <div role="status" className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">
      {confirmDialog}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {text.title}{text.running && <> — <span className="font-mono">{text.running}</span></>}
            {text.runningSince && <span className="font-normal text-muted-foreground"> ({text.runningSince})</span>}
          </p>
          <p className="text-muted-foreground">{text.lastProgress}</p>
          {state.kind === "unsupported" && <p className="text-muted-foreground">{state.text}</p>}
          {(state.kind === "sent" || state.kind === "failed") && (
            <p className={state.kind === "failed" ? "text-destructive" : "text-muted-foreground"}>{state.text}</p>
          )}
          {readOnly
            ? <p className="text-muted-foreground">Interrupt it from the desktop, or Pair to talk it through.</p>
            : state.kind !== "unsupported" && <p className="text-muted-foreground">Or Pair (above) to talk it through yourself.</p>}
          <FormError>{error}</FormError>
        </div>
        {!readOnly && state.kind !== "unsupported" && (
          <Button
            size="sm" variant="outline" className="h-7"
            disabled={sending || (state.kind === "sent" && agent.lastInterrupt?.status === "pending")}
            focusableWhenDisabled
            onClick={() => { void interrupt(); }}
          >
            <OctagonX className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Interrupt
          </Button>
        )}
      </div>
    </div>
  );
}

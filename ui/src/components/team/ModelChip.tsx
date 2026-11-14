/**
 * ModelChip — The teammate page's model chip and picker (docs/DESIGN.md
 * "Choosing a Model"; pages/TeammatePage's header strip — not the Team tab's
 * rows).
 *
 * The chip shows the model the teammate is running, with a pin icon (📌) when
 * the user pinned one and a "failover" mark while a failover substitute is in effect;
 * its tooltip says why (lib/models.ts `modelChipView`). Clicking it opens a
 * menu (Base UI's, so keyboard, focus and Esc are handled): the models the
 * teammate's harness reported (the pin checked), **Clear pin**, and **Apply
 * … to all teammates**. A pick is a `set-model` the teammate carries out
 * between runs: the chip shows "switching to …" until it reports done (then
 * the new model) or failed (the reason, below the chip). A harness that can't
 * switch models, or the phone view (`readOnly`), gets the chip without the
 * menu.
 */

import { Cpu, Loader2, ArrowLeftRight, Pin } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { FormError } from "@/components/ui/form-error";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAgentModel } from "@/hooks/useAgentModel";
import { useAnnounce } from "@/hooks/useAnnounce";
import { apiPost } from "@/hooks/useApi";
import { applyToAllModel, modelChipView, modelLabel, type ModelChipView } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { Teammate } from "@/lib/team";
import type { SetTeamModelResponse } from "@shared/protocol";
import { useState } from "react";

const CHIP = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] leading-4";

/** The chip's visible text and marks (shared by the button and the read-only chip). */
function ChipBody({ view, pending }: { view: ModelChipView; pending: string | null }) {
  return (
    <>
      {pending
        ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" aria-hidden />
        : <Cpu className="h-2.5 w-2.5 shrink-0" aria-hidden />}
      <span className="truncate">{pending ? `switching to ${pending}…` : view.label}</span>
      {view.pinned && !pending && <Pin className="h-2.5 w-2.5 shrink-0 fill-current" aria-hidden data-pinned />}
      {view.failover && !pending && (
        <span className="flex items-center gap-0.5 font-medium text-amber-700 dark:text-amber-400">
          <ArrowLeftRight className="h-2.5 w-2.5" aria-hidden />failover
        </span>
      )}
    </>
  );
}

/** The chip's accessible name: its visible text first (WCAG 2.5.3), then the marks in words. */
function chipName(view: ModelChipView, pending: string | null): string {
  const text = pending ? `switching to ${pending}…` : view.label;
  const marks = [!pending && view.pinned ? "pinned" : "", !pending && view.failover ? "failover" : ""].filter(Boolean);
  return `${text}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

export function ModelChip({ agent, readOnly = false, className }: { agent: Teammate; readOnly?: boolean; className?: string }) {
  const { state, pick, busy, pending: asked, pendingModel, error } = useAgentModel(agent.id, agent.name);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const announce = useAnnounce();
  const view = modelChipView(state, agent.session?.model);
  const pending = asked ?? view.pending;
  const tooltip = <span className="whitespace-pre-line">{view.tooltip}</span>;
  const tone = view.failover ? "border-amber-500/60" : "border-border";
  if (!state && !agent.session?.model) return null;

  if (readOnly || !view.changeable) {
    return (
      <Tooltip content={tooltip} focusable>
        <span className={cn(CHIP, tone, "text-muted-foreground", className)} data-model-chip={agent.id}>
          <ChipBody view={view} pending={pending} />
        </span>
      </Tooltip>
    );
  }

  const models = state?.models ?? [];
  const spread = applyToAllModel(state);
  const applyToAll = async () => {
    if (!spread) return;
    const label = modelLabel(spread, models);
    if (!(await confirm({
      title: `Switch every teammate to ${label}?`,
      description: "It pins this model on every live teammate; each switches after its current run.",
      confirmLabel: "Apply to all",
    }))) return;
    setBulkError(null);
    const res = await apiPost<SetTeamModelResponse>("/api/agents/model", { model: spread, scope: "teammates" });
    if (!res.success) { setBulkError(res.error || "Couldn't apply it"); return; }
    const n = res.directives.length;
    announce(`Switching ${n} teammate${n === 1 ? "" : "s"} to ${label} after their current runs`);
    if (res.unsupported.length) setBulkError(`Not supported by this harness: ${res.unsupported.join(", ")} can't switch models.`);
  };

  return (
    <>
      {confirmDialog}
      <DropdownMenu>
        <Tooltip content={tooltip}>
          <DropdownMenuTrigger
            className={cn(CHIP, tone, "text-foreground hover:bg-accent disabled:opacity-50", className)}
            aria-label={`${chipName(view, pending)}: change ${agent.name}'s model`}
            disabled={busy}
            data-model-chip={agent.id}
          >
            <ChipBody view={view} pending={pending} />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Pin a model (switches after the current run)</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={(asked ? pendingModel : state?.pin) ?? ""} onValueChange={(v: string) => { void pick(v); }}>
              {models.map((m) => (
                <DropdownMenuRadioItem key={m.ref} value={m.ref} closeOnClick>
                  <span className="min-w-0 truncate">{m.name}</span>
                  {m.name !== m.ref && <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{m.ref}</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!state?.pin} onClick={() => { void pick(null); }}>Clear pin</DropdownMenuItem>
          <DropdownMenuItem disabled={!spread} onClick={() => { void applyToAll(); }}>
            {spread ? `Apply ${modelLabel(spread, models)} to all teammates` : "Apply to all teammates"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FormError className="text-xs">{error ?? bulkError}</FormError>
    </>
  );
}

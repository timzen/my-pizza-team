/**
 * PollStatusBadge — A poll-state task's status between checks (lib/poll-status.ts;
 * docs/DESIGN.md "Polling States"): "Waiting · next check 14:45", "Held · team
 * not ready", or "Needs attention: polling timed out", with the check count as
 * small text beside it and the last wait reason (or the readiness probe's
 * reason) in the Tooltip. Renders nothing while a check is queued or running —
 * the WorkItem chip shows that — or when there is nothing to say.
 *
 * Used on the board's task card, the story page's task rows and the task page.
 */

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { pollChip, type PollStatusInfo } from "@/lib/poll-status";
import { cn } from "@/lib/utils";

/** The badge's look per kind: waiting is quiet, held and needs-you are amber. */
const KIND_CLASS = {
  waiting: "",
  held: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  "needs-you": "border-amber-500 text-amber-800 dark:text-amber-300 font-semibold",
} as const;

export function PollStatusBadge({ poll, workItemState, focusable = false, className }: {
  poll: PollStatusInfo;
  /**
   * Make the badge a tab stop so the keyboard reaches its reason. Off on the
   * board (each would be a tab stop in a long list; the task page says it in
   * text), on where the badge is the only place the reason shows.
   */
  focusable?: boolean;
  /** The task's active WorkItem state: while one is in flight the normal chip shows instead. */
  workItemState?: string | null;
  className?: string;
}) {
  if (workItemState) return null;
  const chip = pollChip(poll);
  if (!chip) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1 min-w-0 max-w-full", className)}>
      <Tooltip content={chip.title} focusable={focusable}>
        <Badge variant="outline" className={cn("text-[10px] px-1 py-0 whitespace-normal text-left h-auto", KIND_CLASS[chip.kind])}>
          {chip.label}
        </Badge>
      </Tooltip>
      {chip.count && <span className="text-[10px] text-muted-foreground whitespace-nowrap">{chip.count}</span>}
    </span>
  );
}

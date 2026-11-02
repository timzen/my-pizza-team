/**
 * cron-preview.tsx — The schedule form's reading of its cron, in words
 * ("Every weekday at 9:00."), under the cron field (lib/field-help.ts
 * `cronPreview`).
 *
 * The field lists the preview's `id` in its `aria-describedby`, so a screen
 * reader hears the reading when it lands on the field. Not a live region: it
 * changes with every key, and announcing each one would talk over the typing
 * (docs/ACCESSIBILITY.md "Live announcements").
 */

import { CalendarClock } from "lucide-react";
import { cronPreview } from "@/lib/field-help";
import { cn } from "@/lib/utils";

/** The cron `cron` in words, with an `id` for its field's `aria-describedby`. */
export function CronPreview({ id, cron, className }: { id: string; cron: string; className?: string }) {
  return (
    <p className={cn("mt-1 flex items-center gap-1.5 text-sm", className)}>
      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span id={id}>{cronPreview(cron)}</span>
    </p>
  );
}

/**
 * PersonaChip — The persona a teammate is working with (or a run worked with),
 * as recorded on its WorkItem at claim: a small badge linking to the persona's
 * page. A persona deleted since shows its recorded title, unlinked, marked
 * "deleted"; no recorded persona, no chip (docs/DESIGN.md "The in-flight
 * persona: a snapshot on the WorkItem"). Text, tooltip and link come from
 * lib/personas.ts `personaChip`.
 */

import { Link } from "react-router-dom";
import { usePersonas } from "@/hooks/usePersonas";
import { personaChip, type PersonaRef } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

export function PersonaChip({ persona, className }: { persona: PersonaRef | null | undefined; className?: string }) {
  const library = usePersonas();
  if (!persona) return null;
  const chip = personaChip(persona, library);
  const classes = cn(
    "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] leading-4",
    chip.deleted ? "border-dashed border-border text-muted-foreground" : "border-violet-500/40 text-violet-700 dark:text-violet-300",
    persona.fallbackFrom && !chip.deleted ? "border-amber-500/60" : "",
    className,
  );
  const body = (
    <>
      <Sparkles className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span className="truncate">{chip.label}</span>
    </>
  );
  return chip.href
    ? <Link to={chip.href} className={cn(classes, "hover:bg-violet-500/10")} title={chip.title} data-persona-chip={persona.id}>{body}</Link>
    : <span className={classes} title={chip.title} data-persona-chip={persona.id}>{body}</span>;
}

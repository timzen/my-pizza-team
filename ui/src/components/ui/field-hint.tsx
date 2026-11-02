/**
 * field-hint.tsx — A form field's one-line hint (lib/field-help.ts), with an
 * optional "Learn more" that opens the guide section about it in the side
 * dock's Help panel (docs/DESIGN.md "Help Comes to You").
 *
 * The field points at the hint with `aria-describedby={id}` (join it with an
 * error's id through `describedBy`), so a screen reader reads it on focus —
 * the hint is the text in the `<span id>`, not the "Learn more" after it.
 *
 * ```tsx
 * <Input id="wd-dir" aria-describedby="wd-dir-hint" … />
 * <FieldHint id="wd-dir-hint" field="directory" />
 * ```
 *
 * "Learn more" is a button that opens the dock's Help on the hint's section
 * (Esc there puts focus back on it); outside the desktop shell — the phone
 * view has no dock — it's a link to that section's page. Pass
 * `learnMore={false}` inside a modal dialog, which keeps the dock unreachable
 * while it's open.
 */

import { useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SideDockContext } from "@/hooks/useSideDock";
import { fieldHelp, type FieldHelpKey } from "@/lib/field-help";
import { helpPath } from "@/lib/help";
import { cn } from "@/lib/utils";

interface FieldHintProps {
  /** For the field's `aria-describedby`. */
  id: string;
  /** Which hint (lib/field-help.ts FIELD_HELP). */
  field: FieldHelpKey;
  /** More of the description after the hint (live detail, such as a cron's reading); described too. */
  children?: ReactNode;
  /** Show the "Learn more" (default, when the hint has a section). Off inside a modal. */
  learnMore?: boolean;
  className?: string;
}

/** Render `field`'s hint under (or beside) its field. */
export function FieldHint({ id, field, children, learnMore = true, className }: FieldHintProps) {
  const help = fieldHelp(field);
  const target = learnMore ? help.learnMore : undefined;
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      <span id={id}>{help.text}{children}</span>
      {target && <> <LearnMore topic={target.topic} anchor={target.anchor} describedBy={id} /></>}
    </p>
  );
}

// Underlined, not only colored: a link in text must not rely on color alone (WCAG 1.4.1).
const LEARN_MORE_CLASS = "rounded-sm text-primary underline underline-offset-2 hover:decoration-2";

/** The hint's "Learn more": the dock's Help panel where there is one, else the guide page. */
function LearnMore({ topic, anchor, describedBy }: { topic: string; anchor?: string; describedBy: string }) {
  const dock = useContext(SideDockContext);
  if (!dock) {
    return <Link to={helpPath(topic, anchor)} className={LEARN_MORE_CLASS} aria-describedby={describedBy}>Learn more</Link>;
  }
  return (
    <button type="button" className={LEARN_MORE_CLASS} aria-describedby={describedBy} onClick={() => dock.openHelp({ topic, anchor })}>
      Learn more
    </button>
  );
}

/**
 * TitleField — A single-line title field that mirrors MarkdownField's chrome:
 * a label above-left and a preview/edit toggle button above-right. In preview
 * mode the title is shown bold; in edit mode it's a text input.
 *
 * The **Edit** button is the keyboard way in; clicking the shown title is a
 * pointer shortcut to the same thing, so that wrapper is presentational (no
 * second tab stop). A page whose title *is* its heading passes `heading` and
 * the preview renders as the page's h1 (docs/ACCESSIBILITY.md "Structure").
 */

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Eye } from "lucide-react";

interface TitleFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  /** Start in edit mode (for new/empty content) */
  defaultEditing?: boolean;
  /** Render the shown title as the page's `<h1>` (a detail page whose title is this field). */
  heading?: boolean;
}

export function TitleField({ value, onChange, label, required, defaultEditing, heading }: TitleFieldProps) {
  const [editing, setEditing] = useState(defaultEditing ?? false);
  const inputId = useId();
  const Title = heading ? "h1" : "p";

  return (
    <div>
      <div className="flex items-center justify-between mb-2 pb-1 border-b border-border">
        {label && <label htmlFor={editing ? inputId : undefined} className="text-sm font-medium leading-none">{label}</label>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs gap-1"
          onClick={() => setEditing(!editing)}
        >
          {editing ? <><Eye className="h-3 w-3" /> Preview</> : <><Pencil className="h-3 w-3" /> Edit</>}
        </Button>
      </div>
      {/* While editing, the page keeps its heading (for screen readers). */}
      {editing && heading && <h1 className="sr-only">{value}</h1>}
      {editing ? (
        <Input
          id={inputId}
          value={value}
          onChange={e => onChange(e.target.value)}
          required={required}
          className="text-xl font-bold h-auto py-2"
        />
      ) : (
        // A pointer shortcut for the Edit button above (the keyboard's way in).
        <div
          role="presentation"
          className="rounded-md bg-background px-3 py-2 cursor-pointer"
          onClick={() => setEditing(true)}
        >
          {value ? (
            <Title className="text-xl font-bold">{value}</Title>
          ) : (
            <Title className="text-sm text-muted-foreground italic">No title. Click Edit to add one.</Title>
          )}
        </div>
      )}
    </div>
  );
}

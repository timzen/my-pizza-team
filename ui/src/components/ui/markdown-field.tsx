/**
 * MarkdownField — A description field that renders as markdown by default
 * with a toggle to switch to edit mode (textarea).
 */

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Pencil, Eye } from "lucide-react";

interface MarkdownFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  rows?: number;
  required?: boolean;
  /** Start in edit mode (for new/empty content) */
  defaultEditing?: boolean;
}

export function MarkdownField({ value, onChange, label, rows = 3, required, defaultEditing }: MarkdownFieldProps) {
  const [editing, setEditing] = useState(defaultEditing ?? false);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {label && <label className="text-sm font-medium leading-none">{label}</label>}
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
      {editing ? (
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={rows}
          required={required}
        />
      ) : (
        <div
          className="rounded-md border border-input bg-background px-3 py-2 min-h-[80px] cursor-pointer"
          onClick={() => setEditing(true)}
        >
          {value ? (
            <MarkdownView content={value} />
          ) : (
            <p className="text-sm text-muted-foreground italic">No description. Click to edit.</p>
          )}
        </div>
      )}
    </div>
  );
}

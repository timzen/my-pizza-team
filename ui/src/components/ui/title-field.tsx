/**
 * TitleField — A single-line title field that mirrors MarkdownField's chrome:
 * a label above-left and a preview/edit toggle button above-right. In preview
 * mode the title is shown bold; in edit mode it's a text input.
 */

import { useState } from "react";
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
}

export function TitleField({ value, onChange, label, required, defaultEditing }: TitleFieldProps) {
  const [editing, setEditing] = useState(defaultEditing ?? false);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 pb-1 border-b border-border">
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
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          required={required}
          className="text-xl font-bold h-auto py-2"
        />
      ) : (
        <div
          className="rounded-md bg-background px-3 py-2 cursor-pointer"
          onClick={() => setEditing(true)}
        >
          {value ? (
            <p className="text-xl font-bold">{value}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">No title. Click to edit.</p>
          )}
        </div>
      )}
    </div>
  );
}

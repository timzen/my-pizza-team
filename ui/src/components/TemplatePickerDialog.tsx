/**
 * TemplatePickerDialog — Modal that lists Task Templates and, on selection,
 * navigates to the New Task form pre-filled from the chosen template
 * (`/work-defs/new?type=Solitary&template=<id>`). Used by the "Task from
 * Template" button on the Tasks (Items) page. When no templates exist yet it
 * offers a shortcut to create one.
 */

import { useNavigate } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { FileText, FolderOpen, Plus } from "lucide-react";

interface Template {
  id: string;
  title: string;
  goal: string;
  directory?: string | null;
}

export function TemplatePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const { data } = useApi<{ templates: Template[] }>(open ? "/api/templates" : "/api/templates?closed", [open]);
  const templates = data?.templates || [];

  const pick = (id: string) => {
    onOpenChange(false);
    navigate(`/work-defs/new?type=Solitary&template=${encodeURIComponent(id)}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New task from template</DialogTitle>
          <DialogDescription>Pick a template to pre-fill the new task.</DialogDescription>
        </DialogHeader>

        {templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
            <FileText className="h-8 w-8" />
            <p className="text-sm">No templates yet.</p>
            <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); navigate("/work-defs/new?type=Template"); }}>
              <Plus className="h-4 w-4 mr-1" />New Template
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 max-h-[60vh] overflow-y-auto">
            {templates.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t.id)}
                className="text-left rounded-md border border-border p-3 hover:border-primary/50 hover:bg-accent/50 transition-colors"
              >
                <p className="font-medium truncate">{t.title}</p>
                {t.goal && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{t.goal}</p>}
                {t.directory && (
                  <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-mono text-muted-foreground">
                    <FolderOpen className="h-2.5 w-2.5" />{t.directory}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

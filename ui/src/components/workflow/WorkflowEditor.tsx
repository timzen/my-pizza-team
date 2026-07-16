/**
 * WorkflowEditor — Dialog for editing a workflow's states and transitions.
 * Opened via an "Edit States & Transitions" button on the workflow detail page.
 * Categories remain on the main page, not in this dialog.
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { apiPut } from "@/hooks/useApi";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X, Save, Trash2 } from "lucide-react";
import type { WorkflowConfig } from "./WorkflowGraph";

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, WorkflowConfig>;
  [key: string]: unknown;
}

interface Props {
  name: string;
  workflow: WorkflowConfig;
  config: ConfigData;
  isDefault: boolean;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function WorkflowEditor({ name, workflow, config, isDefault, open, onClose, onSaved }: Props) {
  const navigate = useNavigate();
  const [wf, setWf] = useState<WorkflowConfig>(structuredClone(workflow));
  const [newState, setNewState] = useState("");
  const [transFrom, setTransFrom] = useState(workflow.states[0] || "");
  const [transTo, setTransTo] = useState(workflow.states[1] || workflow.states[0] || "");
  const [transPerm, setTransPerm] = useState("any");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  // Reset local state when workflow prop changes (after refetch)
  useEffect(() => {
    setWf(structuredClone(workflow));
  }, [workflow]);

  const showToast = (msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 3000);
  };

  // --- States ---

  const addState = () => {
    const val = newState.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!val || wf.states.includes(val)) return;
    setWf({ ...wf, states: [...wf.states, val] });
    setNewState("");
  };

  const removeState = (state: string) => {
    const states = wf.states.filter((s) => s !== state);
    const transitions = { ...wf.transitions };
    delete transitions[state];
    for (const from of Object.keys(transitions)) {
      const { [state]: _, ...rest } = transitions[from];
      if (Object.keys(rest).length > 0) transitions[from] = rest;
      else delete transitions[from];
    }
    setWf({ ...wf, states, transitions });
  };

  // --- Transitions ---

  const addTransition = () => {
    if (!transFrom || !transTo || transFrom === transTo) return;
    const transitions = { ...wf.transitions };
    transitions[transFrom] = { ...(transitions[transFrom] || {}), [transTo]: transPerm };
    setWf({ ...wf, transitions });
  };

  const removeTransition = (from: string, to: string) => {
    const transitions = { ...wf.transitions };
    if (transitions[from]) {
      const { [to]: _, ...rest } = transitions[from];
      if (Object.keys(rest).length > 0) transitions[from] = rest;
      else delete transitions[from];
    }
    setWf({ ...wf, transitions });
  };

  const updatePerm = (from: string, to: string, perm: string) => {
    const transitions = { ...wf.transitions };
    transitions[from] = { ...(transitions[from] || {}), [to]: perm };
    setWf({ ...wf, transitions });
  };

  // --- Save ---

  const handleSave = async () => {
    setSaving(true);
    try {
      const updatedConfig = {
        ...config,
        workflows: { ...config.workflows, [name]: wf },
      };
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", updatedConfig);
      if (res.success) {
        showToast("✓ Workflow saved");
        onSaved();
        onClose();
      } else {
        showToast(res.error || "Save failed", true);
      }
    } catch (e) {
      showToast("Network error: " + (e as Error).message, true);
    }
    setSaving(false);
  };

  // --- Delete ---

  const handleDelete = async () => {
    if (!confirm(`Delete workflow "${name}"? This cannot be undone.`)) return;
    setSaving(true);
    try {
      const { [name]: _, ...restWorkflows } = config.workflows;
      const updatedConfig = { ...config, workflows: restWorkflows };
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", updatedConfig);
      if (res.success) {
        navigate("/workflows");
      } else {
        showToast(res.error || "Delete failed", true);
      }
    } catch (e) {
      showToast("Network error: " + (e as Error).message, true);
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Workflow: {name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* States */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold">States</h3>
              <div className="flex gap-1 flex-wrap">
                {wf.states.map((s) => (
                  <Badge key={s} variant="outline" className="gap-1">
                    {s}
                    <button onClick={() => removeState(s)} className="hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="New state..."
                  value={newState}
                  onChange={(e) => setNewState(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addState()}
                  className="max-w-[160px]"
                />
                <Button variant="outline" size="sm" onClick={addState}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Transitions */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold">Transitions</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="pb-1 font-medium">From</th>
                    <th className="pb-1 font-medium">To</th>
                    <th className="pb-1 font-medium text-right">Permission</th>
                    <th className="pb-1 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(wf.transitions)
                    .flatMap(([from, targets]) =>
                      Object.entries(targets).map(([to, perm]) => ({ from, to, perm }))
                    )
                    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
                    .map(({ from, to, perm }) => (
                      <tr key={`${from}-${to}`} className="border-b border-border/50">
                        <td className="py-1.5">
                          <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{from}</span>
                        </td>
                        <td className="py-1.5">
                          <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{to}</span>
                        </td>
                        <td className="py-1.5 text-right">
                          <Select value={perm} onValueChange={(v) => { if (v) updatePerm(from, to, v); }}>
                            <SelectTrigger className="h-7 w-[100px] text-xs ml-auto">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="any">any</SelectItem>
                              <SelectItem value="teammate">teammate</SelectItem>
                              <SelectItem value="lead">lead</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeTransition(from, to)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <div className="flex items-center gap-2">
                <Select value={transFrom} onValueChange={(v) => { if (v) setTransFrom(v); }}>
                  <SelectTrigger className="h-8 w-[110px] text-xs">
                    <SelectValue placeholder="From" />
                  </SelectTrigger>
                  <SelectContent>
                    {wf.states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">→</span>
                <Select value={transTo} onValueChange={(v) => { if (v) setTransTo(v); }}>
                  <SelectTrigger className="h-8 w-[110px] text-xs">
                    <SelectValue placeholder="To" />
                  </SelectTrigger>
                  <SelectContent>
                    {wf.states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={transPerm} onValueChange={(v) => { if (v) setTransPerm(v); }}>
                  <SelectTrigger className="h-8 w-[100px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">any</SelectItem>
                    <SelectItem value="teammate">teammate</SelectItem>
                    <SelectItem value="lead">lead</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={addTransition}>Add</Button>
              </div>
            </CardContent>
          </Card>

          {/* Save / Delete bar */}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div>
              {!isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive gap-1"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete Workflow
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {toast && (
                <span className={`text-sm ${toast.error ? "text-destructive" : "text-green-600 dark:text-green-400"}`}>
                  {toast.msg}
                </span>
              )}
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

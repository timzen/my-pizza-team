/**
 * InstructionsEditor — Collapsible markdown editor for each workflow state's
 * instruction file. Fetches, displays, and saves instruction markdown via
 * the workflow instructions API endpoints.
 *
 * Each state gets a collapsible section with a textarea for editing and
 * a save button that PUTs to /api/workflows/:name/instructions/:state.
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiPut } from "@/hooks/useApi";
import { ChevronDown, ChevronRight, Save, Check, FileText } from "lucide-react";

interface Props {
  workflowName: string;
  states: string[];
}

interface StateInstruction {
  content: string;
  loaded: boolean;
  modified: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

export function InstructionsEditor({ workflowName, states }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState<Record<string, StateInstruction>>({});

  /** Fetch instruction content for a state */
  const fetchInstruction = useCallback(async (state: string) => {
    try {
      const res = await fetch(`/api/workflows/${workflowName}/instructions/${state}`);
      if (res.ok) {
        const data = await res.json();
        setInstructions((prev) => ({
          ...prev,
          [state]: { content: data.content, loaded: true, modified: false, saving: false, saved: false, error: null },
        }));
      } else if (res.status === 404) {
        setInstructions((prev) => ({
          ...prev,
          [state]: { content: "", loaded: true, modified: false, saving: false, saved: false, error: null },
        }));
      }
    } catch {
      setInstructions((prev) => ({
        ...prev,
        [state]: { content: "", loaded: true, modified: false, saving: false, saved: false, error: "Failed to load" },
      }));
    }
  }, [workflowName]);

  /** Load instruction when a section is expanded */
  useEffect(() => {
    for (const state of expanded) {
      if (!instructions[state]?.loaded) {
        fetchInstruction(state);
      }
    }
  }, [expanded, instructions, fetchInstruction]);

  const toggleExpand = (state: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  const updateContent = (state: string, content: string) => {
    setInstructions((prev) => ({
      ...prev,
      [state]: { ...prev[state], content, modified: true, saved: false },
    }));
  };

  const saveInstruction = async (state: string) => {
    const inst = instructions[state];
    if (!inst) return;

    setInstructions((prev) => ({
      ...prev,
      [state]: { ...prev[state], saving: true, error: null },
    }));

    try {
      const res = await apiPut<{ success: boolean; error?: string }>(
        `/api/workflows/${workflowName}/instructions/${state}`,
        { content: inst.content }
      );
      if (res.success) {
        setInstructions((prev) => ({
          ...prev,
          [state]: { ...prev[state], saving: false, modified: false, saved: true },
        }));
        // Clear saved indicator after 2s
        setTimeout(() => {
          setInstructions((prev) => ({
            ...prev,
            [state]: prev[state] ? { ...prev[state], saved: false } : prev[state],
          }));
        }, 2000);
      } else {
        setInstructions((prev) => ({
          ...prev,
          [state]: { ...prev[state], saving: false, error: res.error || "Save failed" },
        }));
      }
    } catch (e) {
      setInstructions((prev) => ({
        ...prev,
        [state]: { ...prev[state], saving: false, error: (e as Error).message },
      }));
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">State Instructions</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Markdown files that guide agents when tasks enter each state.
          </p>
        </div>

        <div className="space-y-1">
          {states.map((state) => {
            const isExpanded = expanded.has(state);
            const inst = instructions[state];
            const hasContent = inst?.loaded && inst.content.length > 0;

            return (
              <div key={state} className="border border-border rounded-md">
                {/* Header */}
                <button
                  onClick={() => toggleExpand(state)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors rounded-md"
                >
                  {isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  }
                  <span className="font-medium">{state}</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    {state}.md
                  </span>
                  {hasContent && (
                    <span className="ml-auto text-xs text-green-600 dark:text-green-400">●</span>
                  )}
                </button>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2">
                    {!inst?.loaded ? (
                      <p className="text-xs text-muted-foreground">Loading...</p>
                    ) : (
                      <>
                        <textarea
                          value={inst.content}
                          onChange={(e) => updateContent(state, e.target.value)}
                          placeholder={`# ${state}\n\nInstructions for agents entering the "${state}" state...`}
                          className="w-full min-h-[150px] resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <div className="flex items-center justify-between">
                          <div className="text-xs">
                            {inst.error && <span className="text-destructive">{inst.error}</span>}
                            {inst.saved && (
                              <span className="text-green-600 dark:text-green-400 flex items-center gap-1">
                                <Check className="h-3 w-3" /> Saved
                              </span>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveInstruction(state)}
                            disabled={inst.saving || !inst.modified}
                            className="gap-1"
                          >
                            <Save className="h-3.5 w-3.5" />
                            {inst.saving ? "Saving..." : "Save"}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

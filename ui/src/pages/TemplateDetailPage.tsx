/**
 * TemplateDetailPage — View, edit, and delete a Task Template (`/templates/:id`).
 *
 * A template is a reusable mold for a Solitary task (see the daemon's
 * docs/ARCHITECTURE.md "Templates"). This page edits its authored fields —
 * title, goal, acceptance criteria, additional context, directory, context —
 * the same fields that get copied onto a new task created from it. "New Task"
 * jumps to the New Task form seeded from this template. There is no run thread
 * or cron: a template is never executed, only molded from.
 */

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi, apiPut, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { MarkdownField } from "@/components/ui/markdown-field";
import { AcceptanceCriteriaEditor } from "@/components/ui/acceptance-criteria-editor";
import { DirectoryInput } from "@/components/ui/directory-input";
import { ContextSelector } from "@/components/board/ContextSelector";
import { BackButton } from "@/components/ui/back-button";
import { Save, Trash2, Zap, FileText } from "lucide-react";

interface Template {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  contextRefs?: string[];
  directory?: string | null;
}

export function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, refetch } = useApi<{ template?: Template; success?: boolean }>(`/api/templates/${id}`, [id]);
  const tpl = data?.template;

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [directory, setDirectory] = useState("");
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [error, setError] = useState("");

  // Seed edit fields once the template loads (derive-state-in-render pattern).
  const [seededId, setSeededId] = useState<string | null>(null);
  if (tpl && tpl.id !== seededId) {
    setSeededId(tpl.id);
    setTitle(tpl.title);
    setGoal(tpl.goal);
    setAcceptanceCriteria(tpl.acceptanceCriteria || "");
    setAdditionalContext(tpl.additionalContext || "");
    setDirectory(tpl.directory || "");
    setContextRefs(tpl.contextRefs ? [...tpl.contextRefs] : []);
    setError("");
  }

  if (!tpl) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Template not found. <Link to="/templates" className="underline">Back to Templates</Link></p>
      </div>
    );
  }

  const handleSave = async () => {
    setError("");
    const res = await apiPut<{ success: boolean; error?: string }>(`/api/templates/${tpl.id}`, {
      title, goal, acceptanceCriteria, additionalContext,
      directory: directory.trim() || null,
      contextRefs,
    });
    if (res.success) refetch();
    else setError(res.error || "Failed to save");
  };

  const remove = async () => {
    if (!confirm(`Delete template "${tpl.title}"? This can't be undone.`)) return;
    await apiDelete(`/api/templates/${tpl.id}`);
    navigate("/templates");
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback="/templates" title="Back" />
        <h1 className="text-2xl font-bold flex-1">{tpl.title}</h1>
        <Badge variant="outline" className="flex items-center gap-1"><FileText className="h-3 w-3" />Template</Badge>
        <Button variant="outline" size="sm" onClick={() => navigate(`/work-defs/new?type=Solitary&template=${encodeURIComponent(tpl.id)}`)}>
          <Zap className="h-3.5 w-3.5 mr-1" />New Task
        </Button>
      </div>

      <div className="space-y-4">
        <div><div className="mb-2 pb-1 border-b border-border"><Label>Title</Label></div><Input value={title} onChange={e => setTitle(e.target.value)} /></div>
        <MarkdownField label="Goal" value={goal} onChange={setGoal} rows={3} />
        <div>
          <div className="mb-2 pb-1 border-b border-border"><Label>Acceptance criteria</Label></div>
          <div className="mt-1"><AcceptanceCriteriaEditor value={acceptanceCriteria} onChange={setAcceptanceCriteria} /></div>
        </div>
        <MarkdownField label="Additional context" value={additionalContext} onChange={setAdditionalContext} rows={2} />
        <div><div className="mb-2 pb-1 border-b border-border"><Label>Directory</Label></div><div className="mt-1"><DirectoryInput value={directory} onChange={setDirectory} /></div></div>
        <div><div className="mb-2 pb-1 border-b border-border"><Label>Context</Label></div><div className="mt-1"><ContextSelector value={contextRefs} onChange={setContextRefs} /></div></div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={handleSave}><Save className="h-4 w-4 mr-1" />Save</Button>
          <Button variant="destructive" onClick={remove}><Trash2 className="h-4 w-4 mr-1" />Delete</Button>
        </div>
      </div>
    </div>
  );
}

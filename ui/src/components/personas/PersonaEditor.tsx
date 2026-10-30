/**
 * PersonaEditor — The form for one team persona: title, description, tags, the
 * picker hints (`kinds`), and the markdown body injected into prompts
 * (docs/DESIGN.md "The model: personas/<id>.md"). Creates (`POST
 * /api/personas`) or updates (`PUT /api/personas/:id`) it.
 *
 * Formerly the workflow page's per-state markdown editor; personas replaced
 * those files, so it now edits library entries. Saving is linted by the daemon
 * (docs/DESIGN.md "Linting: one linter for every persona"): an error (an
 * unbalanced code fence would swallow the rest of the prompt) refuses the save
 * and is shown here; warnings (shallow headings, stray `---`) are saved and
 * listed under the form.
 */

import { useState } from "react";
import { apiPost, apiPut } from "@/hooks/useApi";
import { notifyPersonasChanged } from "@/hooks/usePersonas";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { PERSONA_KINDS, parseTags, slugHint, type Persona, type PersonaKind, type SavePersonaResponse } from "@/lib/personas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Check, Save, X } from "lucide-react";

interface Props {
  /** The persona being edited; null creates a new team persona. */
  persona: Persona | null;
  /** After a successful save, with the saved persona and any lint warnings. */
  onSaved: (persona: Persona, warnings: string[]) => void;
  onCancel: () => void;
}

/** What each kind hint means, shown beside its checkbox. */
const KIND_HINT: Record<PersonaKind, string> = {
  worker: "listed first on workflow states, tasks, schedules and sources",
  triage: "listed first by the triage pickers",
  assistant: "offered as an assistant chip",
};

export function PersonaEditor({ persona, onSaved, onCancel }: Props) {
  const [title, setTitle] = useState(persona?.title ?? "");
  const [id, setId] = useState("");
  const [description, setDescription] = useState(persona?.description ?? "");
  const [tags, setTags] = useState(persona?.tags.join(", ") ?? "");
  const [kinds, setKinds] = useState<PersonaKind[]>(persona?.kinds ?? []);
  const [content, setContent] = useState(persona?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lintErrors, setLintErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const dirty = title !== (persona?.title ?? "") || description !== (persona?.description ?? "")
    || tags !== (persona?.tags.join(", ") ?? "") || content !== (persona?.content ?? "")
    || kinds.join() !== (persona?.kinds ?? []).join() || id !== "";
  useUnsavedChangesGuard(dirty && !saving);

  const toggleKind = (k: PersonaKind) =>
    setKinds((ks) => ks.includes(k) ? ks.filter((x) => x !== k) : PERSONA_KINDS.filter((x) => x === k || ks.includes(x)));

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    setLintErrors([]);
    const body = { title: title.trim(), description: description.trim(), tags: parseTags(tags), kinds, content };
    try {
      const res = persona
        ? await apiPut<SavePersonaResponse>(`/api/personas/${encodeURIComponent(persona.id)}`, body)
        : await apiPost<SavePersonaResponse>("/api/personas", { ...body, ...(id.trim() ? { id: id.trim() } : {}) });
      setWarnings(res.warnings ?? []);
      if (!res.success || !res.persona) {
        setLintErrors(res.errors ?? []);
        setError(res.errors?.length ? "Not saved — fix the problem below." : res.error || "Save failed");
        return;
      }
      await notifyPersonasChanged();
      onSaved(res.persona, res.warnings ?? []);
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="persona-title">Title</Label>
          <Input id="persona-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reviewer" autoFocus required />
        </div>
        {!persona && (
          <div className="space-y-1">
            <Label htmlFor="persona-id">Id <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="persona-id" value={id} onChange={(e) => setId(e.target.value)} placeholder={slugHint(title) || "from the title"} className="font-mono text-xs" />
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="persona-description">Description</Label>
        <Input id="persona-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line, shown in pickers" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="persona-tags">Tags <span className="font-normal text-muted-foreground">(comma-separated, for filtering)</span></Label>
        <Input id="persona-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="coding, review" />
      </div>
      <div className="space-y-1">
        <Label>Suggested for</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {PERSONA_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5" title={KIND_HINT[k]}>
              <input type="checkbox" id={`persona-kind-${k}`} checked={kinds.includes(k)} onChange={() => toggleKind(k)} />
              {k}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">A hint for pickers only — any persona can be picked anywhere.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="persona-content">Instructions</Label>
        <Textarea
          id="persona-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"You are the … (role, voice, process, checklists — how to do the work)"}
          rows={14}
          className="min-h-[16rem] font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Injected verbatim into the prompt (headings are nested under the prompt's own sections). Project knowledge —
          conventions, build commands — belongs in the project's AGENTS.md, which teammates already read.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {lintErrors.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive">
          {lintErrors.map((w) => <li key={w} className="flex items-start gap-1"><X className="mt-0.5 h-3 w-3 shrink-0" />{w}</li>)}
        </ul>
      )}
      <LintWarnings warnings={warnings} />

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!title.trim() || saving} className="gap-1">
          {persona ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          {saving ? "Saving…" : persona ? "Save" : "Create persona"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>
      </div>
    </div>
  );
}

/** The daemon's lint warnings for a saved persona (saved anyway). */
export function LintWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
      {warnings.map((w) => (
        <li key={w} className="flex items-start gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /><span>{w}</span></li>
      ))}
    </ul>
  );
}

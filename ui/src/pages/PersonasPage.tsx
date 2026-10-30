/**
 * PersonasPage — Config → **Personas** (`/config/personas`, one persona at
 * `/config/personas/:id`): the team's persona library, the one place that says
 * how an agent behaves (docs/DESIGN.md "Personas: One Library, Selected by
 * Reference"). Workflow states, Triage, the Assistant, Solitary and Scheduled
 * tasks, and Work Sources each *pick* one of these by id.
 *
 * - **The list**: every persona — team, built-in (`builtin:*`), and those from
 *   plugin packages — with search, tag filter chips, an origin badge (team /
 *   built-in / the package's name), and the kinds it's suggested for.
 *   **New persona** opens the editor inline; saving lands on its page.
 * - **One persona**: its description, tags, and body, plus **Used by** (each
 *   workflow state, setting, task, or source that references it, linked to
 *   where that reference is edited). A team persona has **Edit** (the
 *   PersonaEditor, with the daemon's lint warnings) and **Delete**, which is
 *   off while anything uses it (the daemon refuses too, 409 + `usedBy`).
 *   Built-in and package personas are read-only: **Duplicate to edit** copies
 *   one into the team library.
 *
 * Rendered inside ConfigPage (which supplies the tab bar); saves are its own,
 * not the page's Save button. Pure rules live in lib/personas.ts.
 */

import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { apiDelete, apiPost, useApi } from "@/hooks/useApi";
import { notifyPersonasChanged, usePersonas } from "@/hooks/usePersonas";
import { LintWarnings, PersonaEditor } from "@/components/personas/PersonaEditor";
import {
  deleteBlockedReason, filterPersonas, originLabel, personaPath, personaTagCounts, readOnlyReason, usageHref, usageLabel,
  PERSONAS_TAB_PATH, type DeletePersonaResponse, type Persona, type PersonaUsage, type SavePersonaResponse,
} from "@/lib/personas";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { uniqueKeys } from "@/lib/list-keys";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BackButton } from "@/components/ui/back-button";
import { AlertTriangle, Copy, Lock, Pencil, Plus, Search, Sparkles, Trash2 } from "lucide-react";

export function PersonasPage({ personaId }: { personaId: string | null }) {
  return personaId ? <PersonaDetail key={personaId} id={personaId} /> : <PersonaList />;
}

/** The origin badge: team (plain), built-in, or the package's name. */
export function OriginBadge({ persona }: { persona: Pick<Persona, "origin"> }) {
  const label = originLabel(persona.origin);
  const tone = persona.origin.kind === "team" ? "" : persona.origin.kind === "builtin" ? "border-sky-500/50 text-sky-700 dark:text-sky-300" : "border-violet-500/50 text-violet-700 dark:text-violet-300";
  return <Badge variant="outline" className={`text-[10px] ${tone}`} title={persona.origin.kind === "package" ? `From the ${label} package` : undefined}>{label}</Badge>;
}

// ─── The list ───────────────────────────────────────────────────────

function PersonaList() {
  const navigate = useNavigate();
  const personas = usePersonas();
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const all = useMemo(() => personas ?? [], [personas]);
  const tagCounts = useMemo(() => personaTagCounts(all), [all]);
  const filtered = useMemo(() => filterPersonas(all, query, activeTag), [all, query, activeTag]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Personas</h2>
          <p className="text-sm text-muted-foreground">
            How a teammate, triage, or the assistant behaves. Workflow states, Triage, the Assistant, tasks,
            schedules and sources pick one of these — edit it here and it changes everywhere it's used.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}><Plus className="mr-1 h-4 w-4" />New persona</Button>
      </div>

      {creating && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 font-semibold">New persona</h3>
            <PersonaEditor persona={null} onCancel={() => setCreating(false)} onSaved={(p, warnings) => navigate(personaPath(p.id), { state: { warnings } })} />
          </CardContent>
        </Card>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Filter by title, id, description, tags, origin, or text…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
      </div>

      {tagCounts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button variant={activeTag === null ? "default" : "outline"} size="sm" onClick={() => setActiveTag(null)}>All ({all.length})</Button>
          {tagCounts.map(([tag, count]) => (
            <Button key={tag} variant={activeTag === tag ? "default" : "outline"} size="sm" onClick={() => setActiveTag(activeTag === tag ? null : tag)}>
              {tag} ({count})
            </Button>
          ))}
        </div>
      )}

      {personas === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="grid gap-2">
        {filtered.map((p) => (
          <Link key={p.id} to={personaPath(p.id)} className="block">
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{p.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
                  <OriginBadge persona={p} />
                  {p.readOnly && <Lock className="h-3 w-3 text-muted-foreground" aria-label="read-only" />}
                  {p.lintError && <span className="flex items-center gap-1 text-xs text-destructive" title={p.lintError}><AlertTriangle className="h-3 w-3" />lint error</span>}
                  <span className="ml-auto flex gap-1">
                    {(p.kinds ?? []).map((k) => <Badge key={k} variant="secondary" className="text-[10px]">{k}</Badge>)}
                  </span>
                </div>
                {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
                {p.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>)}</div>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
        {personas !== null && filtered.length === 0 && (
          <p className="py-8 text-center text-muted-foreground">{all.length === 0 ? "No personas yet." : "No personas match your filter."}</p>
        )}
      </div>
    </div>
  );
}

// ─── One persona ────────────────────────────────────────────────────

function PersonaDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, loading, refetch } = useApi<{ persona?: Persona; usedBy?: PersonaUsage[]; error?: string }>(`/api/personas/${encodeURIComponent(id)}`, [id]);
  const [editing, setEditing] = useState(false);
  // A just-created persona arrives with its lint warnings (PersonaList's navigate state).
  const { state } = useLocation() as { state: { warnings?: string[] } | null };
  const [warnings, setWarnings] = useState<string[]>(state?.warnings ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusedBy, setRefusedBy] = useState<PersonaUsage[] | null>(null);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const persona = data?.persona;
  if (!persona) {
    return (
      <div className="space-y-2">
        <BackButton fallback={PERSONAS_TAB_PATH} title="Back to personas" />
        <p className="text-sm text-muted-foreground">
          No persona “{id}” — it may have been deleted, or its package removed.{" "}
          <Link to={PERSONAS_TAB_PATH} className="text-primary underline">All personas</Link>
        </p>
      </div>
    );
  }
  const usedBy = refusedBy ?? data?.usedBy ?? [];
  const readOnly = readOnlyReason(persona);
  const blocked = deleteBlockedReason(persona, usedBy);

  const duplicate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<SavePersonaResponse>(`/api/personas/${encodeURIComponent(persona.id)}/duplicate`, {});
      if (!res.success || !res.persona) { setError(res.error || "Couldn't duplicate it"); return; }
      await notifyPersonasChanged();
      navigate(personaPath(res.persona.id));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(`Delete persona “${persona.title}”? Its file is removed from the team's library.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiDelete<DeletePersonaResponse>(`/api/personas/${encodeURIComponent(persona.id)}`);
      if (!res.success) { setError(res.error || "Couldn't delete it"); if (res.usedBy) setRefusedBy(res.usedBy); return; }
      await notifyPersonasChanged();
      navigate(PERSONAS_TAB_PATH, { replace: true });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BackButton fallback={PERSONAS_TAB_PATH} title="Back to personas" />
        <Sparkles className="h-5 w-5" />
        <h2 className="text-xl font-bold">{persona.title}</h2>
        <span className="font-mono text-xs text-muted-foreground">{persona.id}</span>
        <OriginBadge persona={persona} />
        <div className="ml-auto flex gap-2">
          {!persona.readOnly && !editing && (
            <Button size="sm" variant="outline" onClick={() => { setEditing(true); setWarnings([]); }}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>
          )}
          <Button size="sm" variant={persona.readOnly ? "default" : "outline"} onClick={duplicate} disabled={busy}
            title="Copy it into your team's library as a new, editable persona (no link back: later changes to this one don't flow into the copy)">
            <Copy className="mr-1 h-3.5 w-3.5" />{persona.readOnly ? "Duplicate to edit" : "Duplicate"}
          </Button>
          {!persona.readOnly && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={remove} disabled={busy || blocked !== null} title={blocked ?? "Delete this persona"}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />Delete
            </Button>
          )}
        </div>
      </div>

      {readOnly && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3 w-3" />{readOnly}</p>}
      {persona.lintError && <p className="flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3 w-3" />{persona.lintError}</p>}
      {persona.duplicatedFrom && (
        <p className="text-xs text-muted-foreground">
          Duplicated from <Link to={personaPath(persona.duplicatedFrom)} className="font-mono text-primary hover:underline">{persona.duplicatedFrom}</Link> (a copy — it doesn't follow later changes).
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <Card>
          <CardContent className="p-4">
            {editing ? (
              <PersonaEditor
                persona={persona}
                onCancel={() => setEditing(false)}
                onSaved={(_p, w) => { setWarnings(w); setEditing(false); refetch(); }}
              />
            ) : (
              <div className="space-y-3">
                {persona.description && <p className="text-sm text-muted-foreground">{persona.description}</p>}
                {(persona.tags.length > 0 || (persona.kinds ?? []).length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {persona.tags.map((t) => <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>)}
                    {(persona.kinds ?? []).map((k) => <Badge key={k} variant="secondary" className="text-[10px]" title="Suggested for">{k}</Badge>)}
                  </div>
                )}
                <LintWarnings warnings={warnings} />
                <div className="border-t border-border pt-3">
                  {persona.content ? <MarkdownView content={persona.content} /> : <p className="text-sm italic text-muted-foreground">No instructions.</p>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <UsedByPanel usedBy={usedBy} />
      </div>
    </div>
  );
}

/** "Used by": everything that references this persona, each linked to where it's set. */
function UsedByPanel({ usedBy }: { usedBy: PersonaUsage[] }) {
  // A usage has no id; its content identifies it (lib/list-keys.ts).
  const usedByKeys = uniqueKeys(usedBy, (u) => JSON.stringify(u));
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <h3 className="text-sm font-semibold">Used by</h3>
        {usedBy.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing picks this persona yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {usedBy.map((u, i) => (
              <li key={usedByKeys[i]}><Link to={usageHref(u)} className="text-primary hover:underline">{usageLabel(u)}</Link></li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">A persona in use can't be deleted — re-point these first.</p>
      </CardContent>
    </Card>
  );
}

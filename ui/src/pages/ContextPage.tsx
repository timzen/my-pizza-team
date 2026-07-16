/**
 * ContextPage — The context library: a collection of reusable prompt/context
 * entries that can be injected into teammates or the assistant.
 *
 * Entries are small markdown documents with title/description/tags frontmatter.
 * Each renders as a card with an inline view/edit toggle — metadata (title,
 * description, tags) lives in the left quarter, the markdown body in the right
 * three-quarters. The collection is expected to stay small, so search and tag
 * filtering are done entirely client-side.
 */

import { useMemo, useState } from "react";
import { useApi, apiPost, apiPut, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Label } from "@/components/ui/label";
import { Plus, Search, Trash2, Pencil, Check, X, Sparkles } from "lucide-react";

/** The tag that marks a context entry as a selectable assistant persona. */
const PERSONA_TAG = "persona";

interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

export function ContextPage() {
  const { data, refetch } = useApi<{ entries: ContextEntry[] }>("/api/context");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // `creating` holds the initial tags string for a new card (null = not creating).
  // "New Entry" opens it blank; "New Persona" pre-tags it with `persona`.
  const [creating, setCreating] = useState<string | null>(null);

  const entries = data?.entries || [];

  // Unique tags across all entries, with counts, for the filter chips.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  // Client-side filter: tag chip + free-text over title/description/tags/body.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (activeTag && !e.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, query, activeTag]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Reusable prompts and context to inject into teammates or the assistant.</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setCreating(PERSONA_TAG)} disabled={creating !== null}><Sparkles className="h-4 w-4 mr-1" />New Persona</Button>
          <Button size="sm" onClick={() => setCreating("")} disabled={creating !== null}><Plus className="h-4 w-4 mr-1" />New Entry</Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter by title, description, tags, or content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Tag filter chips */}
      {tagCounts.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <Button variant={activeTag === null ? "default" : "outline"} size="sm" onClick={() => setActiveTag(null)}>
            All ({entries.length})
          </Button>
          {tagCounts.map(([tag, count]) => (
            <Button key={tag} variant={activeTag === tag ? "default" : "outline"} size="sm" onClick={() => setActiveTag(activeTag === tag ? null : tag)}>
              {tag} ({count})
            </Button>
          ))}
        </div>
      )}

      {/* Entry list */}
      <div className="space-y-3">
        {creating !== null && (
          <ContextCard
            entry={null}
            startEditing
            initialTags={creating}
            onSaved={() => { setCreating(null); refetch(); }}
            onCancel={() => setCreating(null)}
            onDeleted={refetch}
          />
        )}
        {filtered.map((entry) => (
          <ContextCard key={entry.id} entry={entry} onSaved={refetch} onDeleted={refetch} />
        ))}
        {filtered.length === 0 && creating === null && (
          <p className="text-center text-muted-foreground py-8">
            {entries.length === 0 ? "No context entries yet." : "No entries match your filter."}
          </p>
        )}
      </div>
    </div>
  );
}

interface ContextCardProps {
  entry: ContextEntry | null; // null → an unsaved new entry
  startEditing?: boolean;
  initialTags?: string; // seed tags for a new entry (e.g. "persona")
  onSaved: () => void;
  onCancel?: () => void;
  onDeleted: () => void;
}

/**
 * A single context entry card with an inline view/edit toggle. Metadata sits in
 * the left quarter; the markdown body fills the right three-quarters.
 */
function ContextCard({ entry, startEditing, initialTags, onSaved, onCancel, onDeleted }: ContextCardProps) {
  const [editing, setEditing] = useState(!!startEditing);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(entry?.title ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [tags, setTags] = useState(entry?.tags.join(", ") ?? initialTags ?? "");
  const [content, setContent] = useState(entry?.content ?? "");

  // Whether `persona` is among the current tags, and a toggle for it. Lets any
  // entry be marked (or unmarked) as a swappable assistant persona.
  const isPersona = tags.split(",").map((t) => t.trim()).includes(PERSONA_TAG);
  const togglePersona = () => {
    const list = tags.split(",").map((t) => t.trim()).filter(Boolean);
    setTags((isPersona ? list.filter((t) => t !== PERSONA_TAG) : [...list, PERSONA_TAG]).join(", "));
  };

  const resetFromEntry = () => {
    setTitle(entry?.title ?? "");
    setDescription(entry?.description ?? "");
    setTags(entry?.tags.join(", ") ?? initialTags ?? "");
    setContent(entry?.content ?? "");
  };

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      description: description.trim(),
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      content,
    };
    try {
      if (entry) await apiPut(`/api/context/${entry.id}`, payload);
      else await apiPost("/api/context", payload);
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (entry) {
      resetFromEntry();
      setEditing(false);
    } else {
      onCancel?.();
    }
  };

  const remove = async () => {
    if (!entry) return;
    if (!confirm(`Delete context entry "${entry.title}"?`)) return;
    await apiDelete(`/api/context/${entry.id}`);
    onDeleted();
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Left quarter: metadata + actions */}
          <div className="md:w-1/4 md:shrink-0 space-y-3">
            {editing ? (
              <>
                <div>
                  <Label className="text-xs">Title</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Entry title" autoFocus required />
                </div>
                <div>
                  <Label className="text-xs">Description</Label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When to use this" rows={3} />
                </div>
                <div>
                  <Label className="text-xs">Tags (comma-separated)</Label>
                  <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="coding, review" />
                  <Button
                    type="button"
                    size="sm"
                    variant={isPersona ? "default" : "outline"}
                    className="mt-2 h-7 text-xs"
                    onClick={togglePersona}
                    title="Mark this entry as a swappable assistant persona"
                  >
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                    {isPersona ? "Persona" : "Mark as persona"}
                  </Button>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={save} disabled={!title.trim() || saving}><Check className="h-4 w-4 mr-1" />Save</Button>
                  <Button size="sm" variant="ghost" onClick={cancel}><X className="h-4 w-4 mr-1" />Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium break-words">{entry?.title}</p>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => setEditing(true)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Delete" onClick={remove}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {entry?.description && <p className="text-sm text-muted-foreground break-words">{entry.description}</p>}
                {entry && entry.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {entry.tags.map((t) => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right three-quarters: markdown body */}
          <div className="md:w-3/4 md:flex-1 min-w-0 md:border-l md:border-border md:pl-4">
            {editing ? (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Markdown content…"
                rows={12}
                className="font-mono text-sm min-h-[16rem]"
              />
            ) : entry?.content ? (
              <MarkdownView content={entry.content} />
            ) : (
              <p className="text-sm text-muted-foreground italic">No content.</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

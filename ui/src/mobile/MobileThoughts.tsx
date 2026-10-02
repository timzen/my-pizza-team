/**
 * MobileThoughts — The phone view's **Thoughts** tab: the notes as a list
 * (`/m/thoughts`), and one note to read or write (`/m/thoughts/:id`).
 *
 * The desktop list view's rules (lib/thoughtList.ts — titles, snippets, folders,
 * ordering, search) in a phone layout: folders as collapsible sections, a row
 * per note, tap to open. No canvas — dragging notes around is a desktop job.
 *
 * A note opens full-screen in **Preview** (checklists tappable), with **Edit**
 * a plain textarea rather than the desktop's CodeMirror editor: vim keys are on
 * by default there, which is no use on a phone keyboard, and a native textarea
 * is what iOS selection, dictation, and autocorrect work with. Edits autosave
 * shortly after you stop typing and when you leave the note, as in the desktop
 * list's pane, so there is no path that loses a thought. New notes are placed on
 * the canvas by the daemon.
 *
 * Grouping, triage decisions, and the archive drawer stay on the desktop; a
 * note's triage badge links to its (desktop) triage page.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { useApi, apiDelete, apiPatch, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/ui/markdown-view";
import { TriageBadge } from "@/components/thoughts/TriageBadge";
import { buildThoughtTree, noteSnippet, noteTitle } from "@/lib/thoughtList";
import { THOUGHT_COLORS, dotClass, nextRotatedColor, noteClass } from "@/lib/thoughtColors";
import { toggleTaskMarker } from "@/lib/taskMarkers";
import { MOBILE_TAB_PATHS } from "@/lib/mobile";
import type { TriageBadge as TriageBadgeState } from "@/lib/triage";
import { Archive, ChevronDown, ChevronLeft, ChevronRight, Eye, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";

/** The fields of `/api/thoughts` this view reads (shared/types.ts `Thought`). */
interface Note {
  id: string;
  content: string;
  color: string;
  x: number;
  y: number;
  pinned: boolean;
  groupId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Group { id: string; title: string; x: number; y: number; w: number; h: number }

/** How long Edit waits after the last keystroke before saving (as the desktop pane). */
const AUTOSAVE_MS = 600;

export function MobileThoughts({ active }: { active: boolean }) {
  const noteId = useMatch(`${MOBILE_TAB_PATHS.thoughts}/:id`)?.params.id ?? null;
  // Polled slowly: the leader can write notes too, and the tab stays mounted.
  const { data, refetch } = useApi<{ thoughts: Note[]; groups: Group[] }>("/api/thoughts?status=active", [], { pollInterval: 30_000 });
  const { data: triage } = useApi<{ badges: Record<string, TriageBadgeState> }>("/api/triage/badges", [], { pollInterval: 60_000 });

  // Coming back to the tab shows what changed elsewhere without waiting for the poll.
  useEffect(() => { if (active) refetch(); }, [active, refetch]);

  const notes = data?.thoughts ?? [];
  if (noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) {
      return (
        <div className="space-y-3 p-4 text-sm">
          <BackToList />
          <p className="text-muted-foreground">{data ? "This note isn't here — it may have been archived or deleted." : "Loading…"}</p>
        </div>
      );
    }
    return <NoteView key={note.id} note={note} onChanged={refetch} />;
  }
  return <NoteList notes={notes} groups={data?.groups ?? []} badges={triage?.badges ?? {}} loaded={!!data} onCreated={refetch} />;
}

function BackToList() {
  return (
    <Link to={MOBILE_TAB_PATHS.thoughts} className="flex items-center gap-1 text-sm text-muted-foreground">
      <ChevronLeft className="h-4 w-4" />Thoughts
    </Link>
  );
}

// ─── The list ────────────────────────────────────────────────────────

function NoteList({ notes, groups, badges, loaded, onCreated }: {
  notes: Note[];
  groups: Group[];
  badges: Record<string, TriageBadgeState>;
  loaded: boolean;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const tree = buildThoughtTree(notes, groups, query);

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const create = async () => {
    const res = await apiPost<{ thought?: Note }>("/api/thoughts", { content: "", color: nextRotatedColor(notes) });
    onCreated();
    if (res.thought) navigate(`${MOBILE_TAB_PATHS.thoughts}/${encodeURIComponent(res.thought.id)}?edit=1`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <Input type="search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 flex-1" />
        <Button size="sm" className="h-9" onClick={create}><Plus className="mr-1 h-4 w-4" />Note</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tree.folders.map(({ group, notes: inFolder }) => {
          const open = searching || !collapsed.has(group.id);
          return (
            <section key={group.id}>
              <button
                type="button"
                onClick={() => toggle(group.id)}
                className="flex w-full items-center gap-1 border-b border-border bg-muted/40 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="truncate">{group.title}</span>
                <span className="font-normal">({inFolder.length})</span>
              </button>
              {open && inFolder.map((n) => <NoteRow key={n.id} note={n} badge={badges[n.id]} />)}
            </section>
          );
        })}
        {tree.loose.map((n) => <NoteRow key={n.id} note={n} badge={badges[n.id]} />)}
        {loaded && notes.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">No notes yet — tap <strong>Note</strong> to write one.</p>
        )}
        {searching && tree.loose.length === 0 && tree.folders.length === 0 && notes.length > 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">No notes match “{query.trim()}”.</p>
        )}
      </div>
    </div>
  );
}

function NoteRow({ note, badge }: { note: Note; badge: TriageBadgeState | undefined }) {
  const title = noteTitle(note.content);
  const snippet = noteSnippet(note.content);
  return (
    <div className="relative flex items-start gap-3 border-b border-border px-3 py-2.5">
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(note.color)}`} />
      <div className="min-w-0 flex-1">
        {/* Stretched link: the whole row opens the note, the badge stays its own link above it. */}
        <Link
          to={`${MOBILE_TAB_PATHS.thoughts}/${encodeURIComponent(note.id)}`}
          className={`block truncate text-sm after:absolute after:inset-0 after:content-[''] ${title ? "font-medium" : "italic text-muted-foreground"}`}
        >
          {title || "Empty note"}
        </Link>
        {snippet && <p className="truncate text-xs text-muted-foreground">{snippet}</p>}
      </div>
      {note.pinned && <Pin className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />}
      <TriageBadge noteId={note.id} badge={badge} className="relative z-10 mt-0.5" />
    </div>
  );
}

// ─── One note ────────────────────────────────────────────────────────

function NoteView({ note, onChanged }: { note: Note; onChanged: () => void }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [draft, setDraft] = useState(note.content);
  const [mode, setMode] = useState<"preview" | "edit">(params.has("edit") || !note.content.trim() ? "edit" : "preview");

  // The last content known to be saved, and what the unmount flush needs — the
  // same bookkeeping as the desktop NoteEditor's pane mode.
  const saved = useRef(note.content);
  const latest = useRef({ draft, id: note.id, onChanged });
  useEffect(() => { latest.current = { draft, id: note.id, onChanged }; });

  /** Persist the draft if it changed since the last save. */
  const flush = () => {
    const { draft: d, id, onChanged: changed } = latest.current;
    if (d === saved.current) return;
    saved.current = d;
    void apiPatch(`/api/thoughts/${encodeURIComponent(id)}`, { content: d }).then(changed);
  };

  // Autosave a moment after typing stops; leaving the note saves anything pending.
  useEffect(() => {
    if (draft === saved.current) return;
    const t = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(t);
  });
  useEffect(() => () => flush(), []);

  const patch = async (body: Record<string, unknown>) => {
    await apiPatch(`/api/thoughts/${encodeURIComponent(note.id)}`, body);
    onChanged();
  };
  const leave = () => navigate(MOBILE_TAB_PATHS.thoughts);
  const archive = async () => {
    flush();
    await apiPost(`/api/thoughts/${encodeURIComponent(note.id)}/archive`, {});
    onChanged();
    leave();
  };
  const remove = async () => {
    if (!window.confirm("Delete this note? This can't be undone.")) return;
    saved.current = latest.current.draft; // nothing left to flush
    await apiDelete(`/api/thoughts/${encodeURIComponent(note.id)}`);
    onChanged();
    leave();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <BackToList />
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon" onClick={() => { flush(); setMode(mode === "edit" ? "preview" : "edit"); }} title={mode === "edit" ? "Preview" : "Edit"}>
            {mode === "edit" ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => patch({ pinned: !note.pinned })} title={note.pinned ? "Unpin" : "Pin"}>
            {note.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={archive} title="Archive">
            <Archive className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="text-destructive" onClick={remove} title="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2" role="radiogroup" aria-label="Color">
        {THOUGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={note.color === c}
            onClick={() => patch({ color: c })}
            className={`h-6 w-6 rounded-full ${dotClass(c)} ${note.color === c ? "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background" : ""}`}
            title={c}
          />
        ))}
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto ${noteClass(note.color)}`}>
        {mode === "edit" ? (
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a thought… (markdown)"
            className="h-full min-h-full resize-none rounded-none border-0 bg-transparent p-4 text-base focus-visible:ring-0 dark:bg-transparent"
          />
        ) : (
          <div className="p-4" onClick={() => { if (!draft.trim()) setMode("edit"); }}>
            {draft.trim() ? (
              <MarkdownView
                content={draft}
                className="text-base"
                onToggleTask={(i) => {
                  // Toggle against the draft and save that, so a tap never
                  // clobbers unsaved text (or vice versa).
                  const next = toggleTaskMarker(draft, i);
                  setDraft(next);
                  saved.current = next;
                  void patch({ content: next });
                }}
              />
            ) : (
              <p className="text-muted-foreground">Empty note — tap to write.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

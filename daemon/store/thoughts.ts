/**
 * daemon/store/thoughts.ts — On-disk IO for Thoughts (markdown sticky notes)
 * and their groups. See docs/ARCHITECTURE.md "Thoughts".
 *
 * Each note is `<teamDir>/thoughts/<id>.md`: a frontmatter block of structural
 * + canvas metadata over a markdown body (the note content). The filename is
 * the id (no `id:` key in the frontmatter — the file path is the source of
 * truth, same discipline as WorkDefs). Groups are a single `groups.json`
 * (`[{id, title}]`) — membership lives on each note's `groupId`, so a group
 * file only needs its title.
 *
 * The functions here are pure IO (read/write/parse). `ThoughtStore`, below, is
 * the Store's domain class for notes on top of them: id minting, free-position
 * placement, partial updates, and the cascade of archive/restore/delete to a
 * note's triage WorkDef (docs/DESIGN.md "Auto Triage"). The Store delegates its
 * thought methods to it one line each; what it needs from the queue comes in as
 * `ThoughtStoreDeps`.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { writeFileAtomic } from "../../shared/atomic-write.ts";
import {
  type Thought,
  type ThoughtGroup,
  THOUGHTS_DIR,
  THOUGHT_GROUPS_FILE,
  DEFAULT_THOUGHT_COLOR,
  DEFAULT_GROUP_SIZE,
  type ThoughtStatus,
  type WorkItem,
  type WorkItemState,
} from "../../shared/types.ts";
import { triageWorkDefId } from "../triage.ts";
import { getWorkDef, updateWorkDef, deleteWorkDef } from "./workdefs.ts";
import type { StoreDomainContext } from "./domain.ts";

function thoughtsDir(teamDir: string): string {
  return path.join(teamDir, THOUGHTS_DIR);
}

function thoughtFile(teamDir: string, id: string): string {
  return path.join(thoughtsDir(teamDir), `${id}.md`);
}

// ─── Serialize / Parse ──────────────────────────────────────────────

/** Serialize a Thought to its markdown+frontmatter file body. */
export function serializeThought(t: Thought): string {
  const fm: string[] = ["---"];
  fm.push(`status: ${t.status}`);
  fm.push(`color: ${t.color}`);
  if (t.pinned) fm.push("pinned: true");
  if (t.groupId) fm.push(`groupId: ${quote(t.groupId)}`);
  fm.push(`x: ${t.x}`);
  fm.push(`y: ${t.y}`);
  if (t.w !== null) fm.push(`w: ${t.w}`);
  if (t.h !== null) fm.push(`h: ${t.h}`);
  fm.push(`z: ${t.zIndex}`);
  fm.push(`createdBy: ${quote(t.createdBy)}`);
  fm.push(`createdAt: ${quote(t.createdAt)}`);
  fm.push(`updatedAt: ${quote(t.updatedAt)}`);
  // Runtime state for auto-triage, on the parent rather than in the triage
  // WorkDef (as a Schedule keeps lastEnqueuedAt). Writing it doesn't touch
  // `updatedAt`, which only a content edit moves.
  if (t.triagedVersion) fm.push(`triagedVersion: ${quote(t.triagedVersion)}`);
  fm.push("---");
  const body = t.content.replace(/^\n+/, "").replace(/\s+$/, "");
  return `${fm.join("\n")}\n${body}\n`;
}

/** Parse a thought markdown file. Returns null when the frontmatter is missing. */
export function parseThought(id: string, raw: string): Thought | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = m[2] ?? "";
  const status = scalar(fm, "status") === "archived" ? "archived" : "active";
  const triagedVersion = scalar(fm, "triagedVersion");
  return {
    id,
    content: body.replace(/^\n+/, "").replace(/\s+$/, ""),
    color: scalar(fm, "color") || DEFAULT_THOUGHT_COLOR,
    status,
    x: num(fm, "x") ?? 0,
    y: num(fm, "y") ?? 0,
    w: num(fm, "w"),
    h: num(fm, "h"),
    zIndex: num(fm, "z") ?? 0,
    pinned: scalar(fm, "pinned") === "true",
    groupId: scalar(fm, "groupId") || null,
    createdBy: scalar(fm, "createdBy") || "human",
    createdAt: scalar(fm, "createdAt") || "",
    updatedAt: scalar(fm, "updatedAt") || "",
    ...(triagedVersion ? { triagedVersion } : {}),
  };
}

// ─── Notes ──────────────────────────────────────────────────────────

/** List all thoughts on disk, sorted by id. */
export function listThoughts(teamDir: string): Thought[] {
  const dir = thoughtsDir(teamDir);
  if (!existsSync(dir)) return [];
  const out: Thought[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    const t = getThought(teamDir, id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getThought(teamDir: string, id: string): Thought | null {
  const file = thoughtFile(teamDir, id);
  if (!existsSync(file)) return null;
  return parseThought(id, fs.readFileSync(file, "utf8"));
}

/** Write a thought's file (crash-safe: temp then rename). */
export function writeThought(teamDir: string, t: Thought): void {
  const dir = thoughtsDir(teamDir);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(thoughtFile(teamDir, t.id), serializeThought(t) + "\n");
}

export function deleteThoughtFile(teamDir: string, id: string): boolean {
  const file = thoughtFile(teamDir, id);
  if (!existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// ─── Groups (groups.json) ───────────────────────────────────────────

export function listThoughtGroups(teamDir: string): ThoughtGroup[] {
  const file = path.join(teamDir, THOUGHT_GROUPS_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const validOpacity = (v: unknown): ThoughtGroup["plateOpacity"] =>
      v === "subtle" || v === "solid" ? v : "medium";
    return parsed
      .filter((g): g is Record<string, unknown> => !!g && typeof g.id === "string")
      .map((g) => ({
        id: g.id as string,
        title: typeof g.title === "string" ? g.title : "",
        x: n(g.x, 0),
        y: n(g.y, 0),
        w: n(g.w, DEFAULT_GROUP_SIZE.w),
        h: n(g.h, DEFAULT_GROUP_SIZE.h),
        groupColor: typeof g.groupColor === "string" ? g.groupColor : null,
        plateOpacity: validOpacity(g.plateOpacity),
      }));
  } catch {
    return [];
  }
}

export function writeThoughtGroups(teamDir: string, groups: ThoughtGroup[]): void {
  writeFileAtomic(path.join(teamDir, THOUGHT_GROUPS_FILE), JSON.stringify(groups, null, 2) + "\n");
}

// ─── helpers ────────────────────────────────────────────────────────

function quote(v: string): string {
  if (v === "") return '""';
  return /[:#\[\]"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "") : "";
}

/** Parse a numeric frontmatter value; null when absent or non-finite. */
function num(fm: string, key: string): number | null {
  const s = scalar(fm, key);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ─── The Store's domain class ───────────────────────────────────────

/** What the thought domain needs from the queue. */
export interface ThoughtStoreDeps {
  /** A WorkDef's active WorkItem (a note's queued or running triage run). */
  getActiveWorkItem(workDefId: string): WorkItem | null;
  /** The queue's bare row transition (cancels a note's triage run; no source hook). */
  setWorkItemStateRow(id: string, state: WorkItemState): void;
}

export class ThoughtStore {
  private teamDir: string;
  private deps: ThoughtStoreDeps;

  constructor(ctx: StoreDomainContext, deps: ThoughtStoreDeps) {
    this.teamDir = ctx.teamDir;
    this.deps = deps;
  }

  // ─── Thoughts (markdown sticky notes; personal workspace/outbox) ────
  //
  // Files are the source of truth (thoughts/<id>.md + groups.json), read and
  // written directly like Schedules/standalone WorkDefs — no SQLite index.
  // Two-state lifecycle (active⇄archived), pinning is an orthogonal flag, and
  // there are no auto-sweeps: nothing moves a note without an explicit action.
  // See docs/ARCHITECTURE.md "Thoughts".

  /** All thoughts, optionally filtered by status; sorted by zIndex then id. */
  getThoughts(status?: string): Thought[] {
    let all = listThoughts(this.teamDir);
    if (status === "active" || status === "archived") all = all.filter((t) => t.status === status);
    return all.sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
  }

  /** One note, or null. */
  getThought(id: string): Thought | null { return getThought(this.teamDir, id); }

  /** Every group (groups.json). */
  getThoughtGroups(): ThoughtGroup[] { return listThoughtGroups(this.teamDir); }
  /** One group, or null. */
  getThoughtGroup(id: string): ThoughtGroup | null {
    return this.getThoughtGroups().find((g) => g.id === id) ?? null;
  }

  /** Mint a collision-free id with the given prefix (`th-`/`grp-`). */
  private mintId(prefix: string, exists: (id: string) => boolean): string {
    let id = `${prefix}${Date.now()}`;
    while (exists(id)) id = `${prefix}${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return id;
  }

  /**
   * Auto-place a new note in free space below existing active content, so an
   * agent (or a coordinate-less create) never stacks notes at the origin.
   */
  private findFreePosition(): { x: number; y: number } {
    const notes = this.getThoughts("active");
    if (notes.length === 0) return { x: 0, y: 0 };
    let maxBottom = 0;
    for (const n of notes) maxBottom = Math.max(maxBottom, n.y + (n.h ?? 120));
    return { x: 0, y: maxBottom + 24 };
  }

  /** Highest zIndex among active notes (new notes land on top). */
  private topZIndex(): number {
    return this.getThoughts("active").reduce((max, t) => Math.max(max, t.zIndex), 0);
  }

  /** Create a note (auto-placed below active content when no x/y; on top of the stack). */
  createThought(input: {
    content?: string; color?: string; x?: number; y?: number; w?: number | null; h?: number | null;
    zIndex?: number; pinned?: boolean; createdBy?: string; groupId?: string;
  }): Thought {
    const now = new Date().toISOString();
    const pos = (input.x !== undefined && input.y !== undefined)
      ? { x: input.x, y: input.y }
      : this.findFreePosition();
    const t: Thought = {
      id: this.mintId("th-", (id) => getThought(this.teamDir, id) !== null),
      content: input.content ?? "",
      color: input.color || DEFAULT_THOUGHT_COLOR,
      status: "active",
      x: pos.x,
      y: pos.y,
      w: input.w ?? null,
      h: input.h ?? null,
      zIndex: input.zIndex ?? this.topZIndex() + 1,
      pinned: input.pinned ?? false,
      groupId: input.groupId && this.getThoughtGroup(input.groupId) ? input.groupId : null,
      createdBy: input.createdBy || "human",
      createdAt: now,
      updatedAt: now,
    };
    writeThought(this.teamDir, t);
    return t;
  }

  /** Partial update; only provided fields are written. A groupId that doesn't
   * resolve is ignored (null clears membership).
   *
   * `updatedAt` means "last edited": only a change to the note's *content* bumps
   * it. The list view orders notes by it, so moving a note on the canvas,
   * recoloring, pinning, or filing it in a group must not make it jump to the top. */
  updateThought(id: string, updates: {
    content?: string; color?: string; status?: ThoughtStatus; pinned?: boolean;
    groupId?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; zIndex?: number;
  }): Thought | null {
    const t = getThought(this.teamDir, id);
    if (!t) return null;
    const edited = updates.content !== undefined && updates.content !== t.content;
    if (updates.content !== undefined) t.content = updates.content;
    if (updates.color !== undefined) t.color = updates.color;
    if (updates.status !== undefined) t.status = updates.status;
    if (updates.pinned !== undefined) t.pinned = updates.pinned;
    if (updates.groupId !== undefined) {
      t.groupId = updates.groupId && this.getThoughtGroup(updates.groupId) ? updates.groupId : null;
    }
    if (updates.x !== undefined) t.x = updates.x;
    if (updates.y !== undefined) t.y = updates.y;
    if (updates.w !== undefined) t.w = updates.w;
    if (updates.h !== undefined) t.h = updates.h;
    if (updates.zIndex !== undefined) t.zIndex = updates.zIndex;
    if (edited) t.updatedAt = new Date().toISOString();
    writeThought(this.teamDir, t);
    return t;
  }

  /** Batch position/size update (one drag gesture). Missing ids are skipped. */
  updateThoughtPositions(moves: Array<{ id: string; x: number; y: number; w?: number | null; h?: number | null; zIndex?: number }>): Thought[] {
    const updated: Thought[] = [];
    for (const m of moves) {
      const t = this.updateThought(m.id, { x: m.x, y: m.y, w: m.w, h: m.h, zIndex: m.zIndex });
      if (t) updated.push(t);
    }
    return updated;
  }

  /** Archive a note; its triage WorkDef (if any) follows, and a queued run is canceled. */
  archiveThought(id: string): Thought | null {
    const t = this.updateThought(id, { status: "archived" });
    if (t) {
      const item = this.deps.getActiveWorkItem(triageWorkDefId(id));
      if (item) this.deps.setWorkItemStateRow(item.id, "CANCELED");
      if (getWorkDef(this.teamDir, triageWorkDefId(id))) {
        updateWorkDef(this.teamDir, triageWorkDefId(id), { status: "archived" });
      }
    }
    return t;
  }

  /** Restore a note; its triage WorkDef comes back with it (the thread is kept). */
  restoreThought(id: string): Thought | null {
    const t = this.updateThought(id, { status: "active" });
    if (t && getWorkDef(this.teamDir, triageWorkDefId(id))) {
      updateWorkDef(this.teamDir, triageWorkDefId(id), { status: "active" });
    }
    return t;
  }

  /**
   * Hard delete (direct — no archive-first guard; it's a personal workspace).
   * Takes the note's triage WorkDef — thread included — with it: the thread is
   * about a note that no longer exists.
   */
  deleteThought(id: string): boolean {
    const defId = triageWorkDefId(id);
    const item = this.deps.getActiveWorkItem(defId);
    if (item) this.deps.setWorkItemStateRow(item.id, "CANCELED");
    if (getWorkDef(this.teamDir, defId)) deleteWorkDef(this.teamDir, defId);
    return deleteThoughtFile(this.teamDir, id);
  }

  /** Create a group, stamping membership on any `memberIds` (exclusive: they switch groups). */
  createThoughtGroup(input: { title?: string; x?: number; y?: number; w?: number; h?: number; memberIds?: string[] }): ThoughtGroup {
    const groups = this.getThoughtGroups();
    const group: ThoughtGroup = {
      id: this.mintId("grp-", (id) => groups.some((g) => g.id === id)),
      title: (input.title || "").trim() || "New Group",
      x: input.x ?? 0,
      y: input.y ?? 0,
      w: input.w ?? DEFAULT_GROUP_SIZE.w,
      h: input.h ?? DEFAULT_GROUP_SIZE.h,
      groupColor: null,
      plateOpacity: "medium",
    };
    writeThoughtGroups(this.teamDir, [...groups, group]);
    // Stamp membership on any provided notes (exclusive: switches groups).
    for (const memberId of input.memberIds ?? []) {
      this.updateThought(memberId, { groupId: group.id });
    }
    return group;
  }

  /** Partial update of a group's title, geometry, or look. Null when it doesn't exist. */
  updateThoughtGroup(id: string, updates: { title?: string; x?: number; y?: number; w?: number; h?: number; groupColor?: string | null; plateOpacity?: "subtle" | "medium" | "solid" }): ThoughtGroup | null {
    const groups = this.getThoughtGroups();
    const group = groups.find((g) => g.id === id);
    if (!group) return null;
    if (updates.title !== undefined) group.title = updates.title.trim() || "New Group";
    if (updates.x !== undefined) group.x = updates.x;
    if (updates.y !== undefined) group.y = updates.y;
    if (updates.w !== undefined) group.w = updates.w;
    if (updates.h !== undefined) group.h = updates.h;
    if (updates.groupColor !== undefined) group.groupColor = updates.groupColor;
    if (updates.plateOpacity !== undefined) group.plateOpacity = updates.plateOpacity;
    writeThoughtGroups(this.teamDir, groups);
    return group;
  }

  /** Ungroup: remove the group and clear its members' groupId (notes stay put). */
  deleteThoughtGroup(id: string): boolean {
    const groups = this.getThoughtGroups();
    if (!groups.some((g) => g.id === id)) return false;
    for (const t of listThoughts(this.teamDir)) {
      if (t.groupId === id) this.updateThought(t.id, { groupId: null });
    }
    writeThoughtGroups(this.teamDir, groups.filter((g) => g.id !== id));
    return true;
  }
}

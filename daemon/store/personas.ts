/**
 * daemon/store/personas.ts — The persona library and every persona resolution.
 *
 * The persona side of the Store (docs/DESIGN.md "Personas: One Library,
 * Selected by Reference", "Work Source personas"):
 *   - the library: team files (`personas/<id>.md`), read-only built-ins
 *     (`builtin:*`), and read-only package personas (`<package>/<id>`,
 *     registered by the plugin loader) — list, get, create/update/delete/duplicate,
 *     and the "Used by" list (`getPersonaUsage`);
 *   - `resolvePersona` (a missing reference logged once per id per run, then the
 *     consumer's fallback), and each consumer's chain: workflow states
 *     (`resolveStatePersona`, `setStatePersona`), a run of any WorkDef
 *     (`resolveWorkPersona`), mirrors (`resolveMirrorPersona`, the per-mirror
 *     override), Work Sources (per-source settings, the triage-mode requirement,
 *     the startup seed and declared-persona check), and the assistant.
 *
 * The pure pieces live in daemon/personas/ and daemon/sources/persona.ts. The
 * Store delegates its persona methods here one line each. What this needs from
 * the other domains and the Work Source registry comes in as `PersonaStoreDeps`.
 */

import {
  parsePersonaId,
  type BuiltinPersonaId,
  type Persona,
  type PersonaUsage,
  type PersonaVia,
  type ResolvedPersona,
  type SourcePersonaSetting,
  type Story,
  type TeamConfig,
  type WorkDef,
  type WorkflowConfig,
} from "../../shared/types.ts";
import type { PluginLoadStatus } from "../../shared/protocol.ts";
import { listBuiltinPersonas, getBuiltinPersona } from "../personas/builtins.ts";
import { deleteTeamPersona, freeTeamPersonaId, listTeamPersonas, readTeamPersona, writeTeamPersona, type TeamPersonaInput } from "../personas/library.ts";
import { type PackagePersonaFile, type PackagePersonaResult, PackagePersonas } from "../personas/packages.ts";
import { personaUsage, resolvePersona } from "../personas/resolve.ts";
import { listMirrorPersonaOverrides } from "../personas/usage-disk.ts";
import { type SourceEntry, sourceIdForWorkDef } from "../sources/registry.ts";
import { mirrorMode } from "../sources/mirror.ts";
import { isSourceSwitchedOff } from "../sources/toggle.ts";
import { heldTriageItemsMessage, mirrorPersonaKey, mirrorPersonaPick, type PersonaPick, triagePersonaProblem } from "../sources/persona.ts";
import { fileSourceKv } from "./source-kv.ts";
import { getWorkDef, listWorkDefs } from "./workdefs.ts";
import type { TaskWithMeta } from "./board.ts";
import type { StoreDomainContext } from "./domain.ts";

/** What the persona domain needs from the rest of the Store. */
export interface PersonaStoreDeps {
  /** The loaded workflows (the board's). */
  getWorkflows(): Record<string, WorkflowConfig>;
  /** Save a workflow (the board's `saveWorkflow`). */
  saveWorkflow(name: string, wf: WorkflowConfig): void;
  /** A board task, for its workflow position. */
  getTask(id: string): TaskWithMeta | null;
  /** A story, for its workflow. */
  getStory(id: string): Story | null;
  /** The team's triage persona (the triage domain's). */
  resolveTriagePersona(): ResolvedPersona;
  /** Is this a triage-mode mirror (the triage domain's)? */
  isTriageModeMirror(def: Pick<WorkDef, "id" | "parent">): boolean;
  /** A registered Work Source by id. */
  getSourceEntry(sourceId: string): SourceEntry | undefined;
  /** Every registered Work Source. */
  listSourceEntries(): SourceEntry[];
  /** Sync an external source now, ignoring its backoff; fire-and-forget. */
  forceSync(entry: SourceEntry): void;
  /** The plugin packages' load status (which sources came from a package). */
  getPluginStatuses(): PluginLoadStatus[];
  /** Persist the live config to config.json (the Store's single writer). */
  saveConfig(): void;
  /** Autosave commit of the team dir. */
  commitToGit(message?: string): void;
}

export class PersonaStore {
  private teamDir: string;
  private config: TeamConfig;
  private deps: PersonaStoreDeps;
  /** Personas shipped by plugin packages (fed by daemon/plugins/loader.ts at startup). */
  readonly packagePersonas = new PackagePersonas();
  /** Missing references already warned about this run ("logged once per id"). */
  private warnedPersonaRefs = new Set<string>();
  /** Triage-mode mirrors the last sync of each source held for want of a triage persona. */
  private personaHeld = new Map<string, Set<string>>();

  constructor(ctx: StoreDomainContext, deps: PersonaStoreDeps) {
    this.teamDir = ctx.teamDir;
    this.config = ctx.config;
    this.deps = deps;
  }

  // --- State personas ---

  /**
   * The persona body for an agent state: the persona its `workflow.json` state
   * names (docs/DESIGN.md "References: select, don't embed"), or undefined when
   * it names none (the prompt then uses the one-line state framing). A name that
   * doesn't resolve falls back to `builtin:teammate` with a warning.
   */
  getStatePersona(workflowName: string | undefined, state: string): string | undefined {
    return this.resolveStatePersona(workflowName, state)?.body;
  }

  /** The resolved persona for an agent state, or null when it names none. */
  resolveStatePersona(workflowName: string | undefined, state: string): ResolvedPersona | null {
    const wfName = workflowName || this.config.defaultWorkflow;
    const st = this.deps.getWorkflows()[wfName]?.states.find((s) => s.name === state);
    if (!st || st.type !== "agent" || !st.persona) return null;
    return this.resolvePersona(st.persona, { via: "workflow-state", fallback: "builtin:teammate" }, `workflow '${wfName}' state '${state}'`);
  }

  /**
   * The persona a run of `def` works with, resolved at claim — the one the
   * prompt carries and the WorkItem snapshot records (docs/DESIGN.md "The
   * in-flight persona"). Each kind walks its own chain:
   *   - board task: its workflow state's `persona` (none = the one-line state framing);
   *   - note triage: the triage persona (`triage.persona`, else `builtin:triage`);
   *   - Solitary / Scheduled: the WorkDef's own `persona` (unset = none);
   *   - mirrors (work or triage mode): the Work Source chain — the person's
   *     override, the item's suggestion, the per-source setting, the source's
   *     declaration (`resolveMirrorPersona`; docs/DESIGN.md "Work Source personas").
   * A reference that doesn't resolve falls back to the consumer's built-in
   * (`resolvePersona`), so this never fails a claim.
   */
  resolveWorkPersona(def: WorkDef): ResolvedPersona | null {
    if (def.parent?.kind === "thought") return this.deps.resolveTriagePersona();
    if (def.parent?.kind === "external") return this.resolveMirrorPersona(def);
    if (!def.parent) return this.resolvePersona(def.persona, { via: "task", fallback: "builtin:teammate" }, `task '${def.id}'`);
    if (def.parent.kind === "schedule") return this.resolvePersona(def.persona, { via: "schedule", fallback: "builtin:teammate" }, `schedule '${def.id}'`);
    if (def.parent.kind === "story") {
      const task = this.deps.getTask(def.id);
      if (!task) return null;
      return this.resolveStatePersona(this.deps.getStory(task.storyId)?.workflow, task.status);
    }
    return null;
  }

  /**
   * A mirrored WorkDef's persona (docs/DESIGN.md "Work Source personas"), by
   * its chain (daemon/sources/persona.ts). Work mode: none when nothing names
   * one; a stale id falls back to `builtin:teammate`. Triage mode: always one — a
   * stale id, or (only for an item enqueued before its source lost its triage
   * persona) none at all, stands in as `builtin:triage`, so a claim never fails.
   */
  resolveMirrorPersona(def: WorkDef): ResolvedPersona | null {
    const triage = this.deps.isTriageModeMirror(def);
    const pick = this.mirrorPersonaPickFor(def);
    const where = `${triage ? "triage-mode " : ""}mirror '${def.id}'`;
    if (!triage) return pick ? this.resolvePersona(pick.ref, { via: pick.via, fallback: "builtin:teammate" }, where) : null;
    if (!pick) return this.resolvePersona("builtin:triage", { via: "source-default", fallback: "builtin:triage" }, where);
    return this.resolvePersona(pick.ref, { via: pick.via, fallback: "builtin:triage" }, where);
  }

  /** The persona id a mirror's chain picks (and how), or null when nothing names one. */
  private mirrorPersonaPickFor(def: WorkDef): PersonaPick | null {
    const sourceId = sourceIdForWorkDef(def);
    const kv = fileSourceKv(this.teamDir, sourceId);
    return mirrorPersonaPick({
      mode: mirrorMode(kv, def.id),
      override: kv.get(mirrorPersonaKey(def.id)),
      suggestion: def.persona,
      setting: this.config.sourcePersonas?.[sourceId],
      source: this.deps.getSourceEntry(sourceId)?.source,
    });
  }

  /**
   * Does a triage-mode mirror have a triage persona that resolves? Checked
   * before it is enqueued (and on Run), so a run never starts without one.
   */
  mirrorHasTriagePersona(def: WorkDef): boolean {
    const pick = this.mirrorPersonaPickFor(def);
    return pick !== null && this.getPersona(pick.ref) !== null;
  }

  /**
   * Why this source is refused a sync, or null: a **triage-mode** source (its
   * declared `mode`) whose source-level triage persona — per-source setting,
   * else declared — is missing or doesn't resolve. Computed on demand, so a
   * per-source save, a persona created or deleted, or a package's personas
   * changing at startup all count at once (docs/DESIGN.md "Work Source personas").
   */
  sourcePersonaProblem(sourceId: string): string | null {
    const source = this.deps.getSourceEntry(sourceId)?.source;
    if (!source || source.mode !== "triage") return null;
    return triagePersonaProblem(sourceId, this.config.sourcePersonas?.[sourceId], source, (id) => this.getPersona(id) !== null);
  }

  /**
   * A source's persona problem for its status (`GET /api/sources` `initError`):
   * the triage-mode requirement, else — for a work-mode source — its
   * triage-mode items the last sync couldn't enqueue for want of one.
   */
  sourcePersonaStatus(sourceId: string): string | null {
    const problem = this.sourcePersonaProblem(sourceId);
    if (problem) return problem;
    const held = this.personaHeld.get(sourceId);
    return held && held.size > 0 ? heldTriageItemsMessage(sourceId, held.size) : null;
  }

  /** Record the triage-mode mirrors a source's last sync held for want of a triage persona. */
  setPersonaHeld(sourceId: string, defIds: string[]): void {
    this.personaHeld.set(sourceId, new Set(defIds));
  }

  /**
   * Set a source's persona settings (`PUT /api/sources/:id/persona`):
   * `persona` for its work-mode items, `triagePersona` for its triage-mode
   * ones. Absent keeps a field, null/"" clears it; an id must resolve. Written
   * to config.json `sourcePersonas` — never the package's `config`, so the
   * source isn't re-initialized. The entry is kept (even empty) once set, so
   * the startup seed for triage plugins never refills a field a person cleared.
   * A changed triage persona on an enabled external source syncs it now (a
   * source that was refused for want of one picks up at once).
   */
  setSourcePersona(sourceId: string, update: { persona?: string | null; triagePersona?: string | null }):
    { ok: true; setting: SourcePersonaSetting } | { ok: false; status: 400 | 404; error: string } {
    const entry = this.deps.getSourceEntry(sourceId);
    if (!entry) return { ok: false, status: 404, error: `No work source "${sourceId}"` };
    for (const field of ["persona", "triagePersona"] as const) {
      const v = update[field];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") return { ok: false, status: 400, error: `Field '${field}' must be a persona id or null` };
      if (!this.getPersona(v)) return { ok: false, status: 400, error: `Persona "${v}" doesn't exist` };
    }
    const current = this.config.sourcePersonas?.[sourceId] ?? {};
    const next: SourcePersonaSetting = { ...current };
    for (const field of ["persona", "triagePersona"] as const) {
      const v = update[field];
      if (v === undefined) continue;
      if (v) next[field] = v;
      else delete next[field];
    }
    this.config.sourcePersonas = { ...this.config.sourcePersonas, [sourceId]: next };
    this.deps.saveConfig();
    if (update.triagePersona !== undefined && next.triagePersona !== current.triagePersona
      && entry.source.sync && !isSourceSwitchedOff(this.config, entry.toggle)) {
      this.deps.forceSync(entry);
    }
    return { ok: true, setting: next };
  }

  /** A person's persona override for a mirror (kv `persona:<defId>`), if any. */
  getMirrorPersonaOverride(def: Pick<WorkDef, "id" | "parent">): string | undefined {
    if (def.parent?.kind !== "external") return undefined;
    return fileSourceKv(this.teamDir, sourceIdForWorkDef(def)).get(mirrorPersonaKey(def.id)) || undefined;
  }

  /**
   * Set (or, with null, clear) a person's persona override on a mirror
   * (`PUT /api/work-defs/:id/persona`): in the source's kv, since only sync
   * writes a mirror's file — so it survives every re-sync. Refuses a def that
   * isn't a mirror (Solitary/Scheduled set `persona` through the ordinary
   * update) and an id that doesn't resolve.
   */
  setMirrorPersona(defId: string, persona: string | null): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string } {
    const def = getWorkDef(this.teamDir, defId);
    if (!def) return { ok: false, status: 404, error: "WorkDef not found" };
    if (def.parent?.kind !== "external") {
      return { ok: false, status: 409, error: "Only a mirrored WorkDef has a persona override; set a task's or schedule's persona with PUT /api/work-defs/:id" };
    }
    if (persona !== null && !this.getPersona(persona)) return { ok: false, status: 400, error: `Persona "${persona}" doesn't exist` };
    const kv = fileSourceKv(this.teamDir, sourceIdForWorkDef(def));
    if (persona) kv.set(mirrorPersonaKey(def.id), persona);
    else kv.delete(mirrorPersonaKey(def.id));
    return { ok: true };
  }

  /**
   * Startup, after the plugins load (docs/DESIGN.md "Work Source personas"): for
   * every plugin-package source that declares `mode: "triage"` but no
   * `triagePersona`, and has no `sourcePersonas` entry yet, seed
   * `sourcePersonas.<id>.triagePersona` with the team's triage persona, else
   * `builtin:triage` — so a newly added triage plugin that names no persona
   * still runs (a triage-mode item needs one). Guarded by "no entry", so it runs once per source (a
   * person clearing it later keeps the empty entry). Returns the seeded ids.
   */
  seedSourceTriagePersonas(): string[] {
    const fromPackages = new Set(this.deps.getPluginStatuses().flatMap((p) => p.sources));
    const seeded: string[] = [];
    for (const { source } of this.deps.listSourceEntries()) {
      if (!fromPackages.has(source.id) || source.mode !== "triage" || source.triagePersona) continue;
      if (this.config.sourcePersonas?.[source.id] !== undefined) continue;
      const ref = this.config.triage?.persona && this.getPersona(this.config.triage.persona) ? this.config.triage.persona : "builtin:triage";
      this.config.sourcePersonas = { ...this.config.sourcePersonas, [source.id]: { triagePersona: ref } };
      console.warn(`[personas] triage-mode source "${source.id}" declares no triagePersona: set its triage persona to ${ref}`);
      seeded.push(source.id);
    }
    if (seeded.length) {
      this.deps.saveConfig();
      if (this.config.autosave?.autoCommit) this.deps.commitToGit("mpt: seed triage personas for triage-mode sources");
    }
    return seeded;
  }

  /**
   * Warnings about the personas plugin sources declare (`defaultPersona`,
   * `triagePersona`) that don't resolve — added to their package's load status
   * at startup, after the plugins (and their personas) loaded. Not an error: a
   * stale work persona falls back to `builtin:teammate`, and a triage one is
   * reported by the source's own status. Returns the statuses with the
   * warnings added (the Store keeps them).
   */
  checkDeclaredSourcePersonas(statuses: PluginLoadStatus[]): PluginLoadStatus[] {
    return statuses.map((status) => {
      const warnings: string[] = [];
      for (const sid of status.sources) {
        const source = this.deps.getSourceEntry(sid)?.source;
        if (!source) continue;
        for (const field of ["defaultPersona", "triagePersona"] as const) {
          const ref = source[field];
          if (ref && !this.getPersona(ref)) warnings.push(`source "${sid}": ${field} "${ref}" doesn't exist (no such team, built-in, or package persona)`);
        }
      }
      if (!warnings.length) return status;
      for (const w of warnings) console.warn(`[plugins] ${status.spec}: warning: ${w}`);
      return { ...status, warnings: [...(status.warnings ?? []), ...warnings] };
    });
  }

  /**
   * Point a workflow agent state at a persona (`null` clears it). Errors name
   * why: unknown workflow/state, a manual state, or a persona that doesn't exist.
   */
  setStatePersona(workflowName: string, state: string, persona: string | null): { ok: true; workflow: WorkflowConfig } | { ok: false; status: 400 | 404; error: string } {
    const wf = this.deps.getWorkflows()[workflowName];
    if (!wf) return { ok: false, status: 404, error: `Workflow "${workflowName}" not found` };
    const st = wf.states.find((s) => s.name === state);
    if (!st) return { ok: false, status: 404, error: `Workflow "${workflowName}" has no state "${state}"` };
    if (persona !== null) {
      if (st.type !== "agent") return { ok: false, status: 400, error: `State "${state}" is manual; only agent states have a persona` };
      if (!this.getPersona(persona)) return { ok: false, status: 400, error: `Persona "${persona}" doesn't exist` };
    }
    const next: WorkflowConfig = {
      ...wf,
      states: wf.states.map((s) => {
        if (s.name !== state) return s;
        const { persona: _old, ...rest } = s;
        return persona ? { ...rest, persona } : rest;
      }),
    };
    this.deps.saveWorkflow(workflowName, next);
    return { ok: true, workflow: next };
  }

  // --- Assistant persona ---
  //
  // The assistant's persona is a persona id in config.json `assistant.persona`
  // (team configuration, committed with the team — docs/DESIGN.md "References");
  // its body follows the chat framing in the system prompt. Null means
  // `builtin:assistant`.

  /** The assistant's selected persona id (`assistant.persona`), or null for `builtin:assistant`. */
  getAssistantPersonaId(): string | null {
    return this.config.assistant?.persona || null;
  }

  /** Select (or, with null, clear) the assistant's persona, persisted to config.json. */
  setAssistantPersonaId(id: string | null): void {
    const { persona: _old, ...rest } = this.config.assistant ?? {};
    const next = id ? { ...rest, persona: id } : rest;
    if (Object.keys(next).length > 0) this.config.assistant = next;
    else delete this.config.assistant;
    this.deps.saveConfig();
  }

  /** The assistant's resolved persona: its selection, or `builtin:assistant`. */
  resolveAssistantPersona(): ResolvedPersona {
    const ref = this.getAssistantPersonaId() ?? "builtin:assistant";
    return this.resolvePersona(ref, { via: "assistant", fallback: "builtin:assistant" }, "assistant.persona")!;
  }

  // --- Personas (docs/DESIGN.md "Personas: One Library, Selected by Reference") ---
  //
  // One library, three origins: team files (`personas/<id>.md`, daemon/personas/
  // library.ts), read-only built-ins (`builtin:*`), and read-only package personas
  // (`<package>/<id>`, registered by the plugin loader). Consumers store an id;
  // `resolvePersona` turns it into a body.

  /**
   * Register a plugin package's personas, read-only, as `<name>/<id>` — the
   * loader's seam (daemon/plugins/loader.ts `PluginHost`). Loaded once at
   * startup, like sources.
   */
  registerPackagePersonas(pkg: { name: string; identity: string }, files: PackagePersonaFile[]): PackagePersonaResult {
    return this.packagePersonas.register(pkg, files);
  }

  /** The whole library: team personas, then built-ins, then package personas. */
  listPersonas(): Persona[] {
    return [...listTeamPersonas(this.teamDir), ...listBuiltinPersonas(), ...this.packagePersonas.list()];
  }

  /** One persona by id, whatever its origin, or null when it doesn't resolve. */
  getPersona(id: string): Persona | null {
    const kind = parsePersonaId(id).kind;
    if (kind === "builtin") return getBuiltinPersona(id);
    if (kind === "package") return this.packagePersonas.get(id);
    if (kind === "team") return readTeamPersona(this.teamDir, id);
    return null;
  }

  /**
   * Resolve a persona reference for a prompt (daemon/personas/resolve.ts). A
   * reference that doesn't resolve is logged once per id per run — `where` names
   * the referrer — and resolves to `opts.fallback`.
   */
  resolvePersona(ref: string | undefined | null, opts: { via: PersonaVia; fallback: BuiltinPersonaId | null }, where: string = opts.via): ResolvedPersona | null {
    const resolved = resolvePersona((id) => this.getPersona(id), ref, opts);
    if (ref && (!resolved || resolved.fallbackFrom) && !this.warnedPersonaRefs.has(`${where}\0${ref}`)) {
      this.warnedPersonaRefs.add(`${where}\0${ref}`);
      console.warn(`[personas] ${where} names persona '${ref}', which doesn't exist — ${resolved ? `using ${resolved.id}` : "using no persona"}`);
    }
    return resolved;
  }

  /** Everything that references persona `id` (the "Used by" list; computed on demand). */
  getPersonaUsage(id: string): PersonaUsage[] {
    return personaUsage(id, {
      workflows: this.deps.getWorkflows(),
      config: this.config,
      workDefs: listWorkDefs(this.teamDir),
      mirrorOverrides: this.listMirrorPersonaOverrides(),
    });
  }

  /** Per-mirror persona overrides: every source kv's `persona:<defId>` key (`sources/<id>.json`). */
  private listMirrorPersonaOverrides(): Array<{ workDefId: string; source: string; persona: string }> {
    return listMirrorPersonaOverrides(this.teamDir);
  }

  /**
   * Create a team persona. The id is `input.id` when given (must be a free,
   * valid team id), else derived from the title with `-2`… on collision.
   */
  createPersona(input: TeamPersonaInput & { id?: string }): { ok: true; persona: Persona } | { ok: false; status: 400 | 409; error: string } {
    let id = input.id;
    if (id !== undefined) {
      if (parsePersonaId(id).kind !== "team") return { ok: false, status: 400, error: `Invalid persona id "${id}" (lowercase letters, digits and "-", at most 64)` };
      if (readTeamPersona(this.teamDir, id)) return { ok: false, status: 409, error: `Persona "${id}" already exists` };
    } else {
      id = freeTeamPersonaId(input.title, (candidate) => readTeamPersona(this.teamDir, candidate) !== null);
    }
    const { id: _id, ...fields } = input;
    writeTeamPersona(this.teamDir, id, fields);
    return { ok: true, persona: readTeamPersona(this.teamDir, id)! };
  }

  /** Update a team persona in place (its id is kept). Null when it doesn't exist. */
  updatePersona(id: string, updates: Partial<TeamPersonaInput>): Persona | null {
    const existing = readTeamPersona(this.teamDir, id);
    if (!existing) return null;
    writeTeamPersona(this.teamDir, id, {
      title: updates.title ?? existing.title,
      description: updates.description ?? existing.description,
      tags: updates.tags ?? existing.tags,
      kinds: updates.kinds ?? existing.kinds,
      duplicatedFrom: existing.duplicatedFrom,
      content: updates.content ?? existing.content,
    });
    return readTeamPersona(this.teamDir, id);
  }

  /** Delete a team persona file. The route refuses one in use first (`getPersonaUsage`). */
  deletePersona(id: string): boolean {
    return deleteTeamPersona(this.teamDir, id);
  }

  /** Copy any persona into the team library (`duplicatedFrom` records the source; no inheritance). */
  duplicatePersona(id: string, overrides: { id?: string; title?: string } = {}): { ok: true; persona: Persona } | { ok: false; status: 400 | 404 | 409; error: string } {
    const src = this.getPersona(id);
    if (!src) return { ok: false, status: 404, error: `Persona "${id}" not found` };
    const title = overrides.title ?? src.title.replace(/ \(built-in\)$/, "");
    return this.createPersona({
      id: overrides.id, title, description: src.description,
      tags: src.tags.filter((t) => t !== "built-in"), kinds: src.kinds, duplicatedFrom: src.id, content: src.content,
    });
  }
}

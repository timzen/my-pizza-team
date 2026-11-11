/**
 * daemon/store.ts — The Store: a thin facade over the daemon's domain modules.
 *
 * Core data layer for the team lead. Opens `state.db` (Node's built-in
 * node:sqlite `DatabaseSync`), brings its schema up to date
 * (store/schema.ts), and wires the domain classes in daemon/store/ — board,
 * queue, threads, members, triage, personas, thoughts, the assistant chat —
 * to each other and to the Work Sources. What it owns itself: that wiring, the
 * Work Source registry and the external-source sync (ingest, mirrors), the
 * timers, readiness, WorkDef/Schedule/Template CRUD that crosses domains, and
 * config persistence. Every other public method is a one-line delegation, so
 * routes and tests call the Store and never a domain class
 * (docs/ARCHITECTURE.md "daemon/" — "The split").
 *
 * Key invariants:
 * - JSON files are the source of truth for story/task definitions
 * - SQLite is the runtime engine for fast atomic reads/writes
 * - Comments are always appended to JSONL immediately (never lost)
 * - Assignments and members are ephemeral (never written to JSON)
 */

import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DAEMON_URL,
  resolveTerminal,
  type Assignment,
  type BuiltinPersonaId,
  type Comment,
  type Member,
  type MemberSessionStats,
  type Persona,
  type PersonaRef,
  type PersonaUsage,
  type PersonaVia,
  type ResolvedPersona,
  type Schedule,
  type SourcePersonaSetting,
  type Story,
  type TeamConfig,
  type TeamReadiness,
  type Template,
  type ThreadEntry,
  type Thought,
  type ThoughtGroup,
  type TriageBadge,
  type TriageOutcome,
  type TriageProposal,
  type UnmanagedWindow,
  type WorkDef,
  type WorkDefOrigin,
  type WorkDefParent,
  type WorkflowConfig,
  type WorkItem,
  type WorkItemRef,
  type TaskPollRecord,
  type WorkflowStateCompletion,
  type WorkItemState,
} from "../shared/types.ts";
import { normalizeDirectory } from "../shared/directory.ts";
import { saveTeamConfig } from "../shared/team-config.ts";
import type { PluginLoadStatus } from "../shared/protocol.ts";
import type { TeamPersonaInput } from "./personas/library.ts";
import { cachedTerminalStatus, type SpawnCapability } from "./spawner.ts";
import type { TerminalBackend, TerminalStatus } from "./terminal/backend.ts";
import { UnmanagedWindowTracker, type CloseUnmanagedResult } from "./unmanaged-windows.ts";
import type { AssistantStartability } from "./leader-start.ts";
import type { PackagePersonaFile, PackagePersonaResult, PackagePersonas } from "./personas/packages.ts";
import { triageWorkDefId, type TriageSkipReason } from "./triage.ts";
import { listWorkDefs, getWorkDef, saveWorkDef, someWorkDef, updateWorkDef, deleteWorkDef } from "./store/workdefs.ts";
import { listSchedules, getSchedule, saveSchedule, updateSchedule, deleteSchedule } from "./store/schedules.ts";
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate } from "./store/templates.ts";
import {
  AssistantChat,
  type AssistantDelivery,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantOrigin,
  type AssistantSendMode,
  type AssistantSession,
  type InboxMessage,
} from "./store/assistant-chat.ts";
import { type RegisterSourceOptions, type SourceEntry, sourceIdForWorkDef, SourceRegistry } from "./sources/registry.ts";
import type { ExternalDef, ItemTerminalOutcome, RunResult, SourceContext, SyncOutcome, WorkSource, WorkSourceMode } from "./sources/types.ts";
import { disconnectedKey, mirrorMode, mirrorRevisionKey, upsertMirror, vanishedKey } from "./sources/mirror.ts";
import { mergeExternalComments } from "./sources/comments.ts";
import { isSourceSwitchedOff } from "./sources/toggle.ts";
import { ExternalTriage } from "./sources/external-triage.ts";
import { heldTriageItemsMessage, mirrorPersonaKey } from "./sources/persona.ts";
import { DEFAULT_SYNC_EVERY_MS, DEFAULT_SYNC_TIMEOUT_MS, SyncRunner, type SyncStatus } from "./sources/sync.ts";
import { SCHEDULE_SOURCE_ID, scheduleSource } from "./sources/schedule.ts";
import { runSolitary, taskSource } from "./sources/task.ts";
import { ThoughtSource } from "./sources/thought.ts";
import { StorySource } from "./sources/story.ts";
import { enqueueRevision, kvRevisionCursor } from "./sources/revision.ts";
import { fileSourceKv } from "./store/source-kv.ts";
import { commitTeamDir } from "./store/git-sync.ts";
import { TeammateTranscripts } from "./store/transcripts.ts";
import { TeammatePairing } from "./store/pairing.ts";
import { migrateSchema, cleanRetiredData } from "./store/schema.ts";
import { DISMISS_EXIT_GRACE_MS, MemberStore, type LeaderDirective, type TeammatePoolState } from "./store/members.ts";
import { QueueStore, type WorkDefExecutionStats } from "./store/queue.ts";
import { ThreadStore, type AttachmentInfo } from "./store/threads.ts";
import { BoardStore, type TaskWithMeta, type WorkflowUsage } from "./store/board.ts";
import { TriageStore, type AcceptProposalOptions, type ProposalResult, type TriageThread } from "./store/triage.ts";
import { PersonaStore } from "./store/personas.ts";
import { ThoughtStore } from "./store/thoughts.ts";
import { recordUsage, dailyUsage, runsOnDay, syncUsageLedger, type UsageEntry, type UsageDay, type UsageRun } from "./store/usage.ts";
import * as path from "node:path";

// Domain constants and types live with their domain stores; re-exported so importers
// of the Store keep their imports.
export { DISMISS_EXIT_GRACE_MS, SPAWN_REGISTER_GRACE_MS, SELF_HANDLED_ACTIONS, LEADER_MEMBER_NAME, isPoolTeammate, type LeaderDirective, type TeammatePoolState } from "./store/members.ts";
export type { WorkDefExecutionStats } from "./store/queue.ts";
export type { Task, TaskWithMeta } from "./store/board.ts";
export { StoryUpdateError, WorkflowDeleteError, DELETED_WORKFLOWS_DIR, type WorkflowUsage } from "./store/board.ts";
export type { AcceptProposalOptions, ProposalResult, TriageProposalOverrides, TriageThread } from "./store/triage.ts";

/** `ctx.options()` of a source registered without settings (the built-ins). */
const EMPTY_SOURCE_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The settings key holding the context-library notice the persona migration
 * (0.34–0.36) raised; dismissing the notice deletes it.
 */
const CONTEXT_NOTICE_KEY = "notice:context-library-removed";

export class Store {
  private db: DatabaseSync;
  private teamDir: string;
  private config: TeamConfig;
  /** Autosave commit every `autosave.flushIntervalMinutes` (only when autoCommit is on). */
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** One interval per ticking Work Source (Schedule every 30s, Thought every triage interval). */
  private sourceTimers: Array<ReturnType<typeof setInterval>> = [];
  /** External sources' sync timers (and their first, prompt run), cleared by `stopTimers`. */
  private syncTimers: Array<ReturnType<typeof setInterval>> = [];
  /**
   * The team's readiness, from the daemon's own probe (daemon/readiness.ts) or a
   * harness's `POST /api/readiness` (see TeamReadiness). Held in memory only: like
   * member connections, it's live state a freshly-booted daemon has no knowledge
   * of — with no report yet the team is treated as ready until the probe's first
   * run says otherwise (at startup).
   */
  private teamReadiness: TeamReadiness | undefined;
  /**
   * Members, heartbeats, session stats, dismissals, the reaper, leader
   * directives, and the teammate pool (daemon/store/members.ts). Built in the
   * constructor, once the db is open.
   */
  private members!: MemberStore;
  /**
   * The WorkItem queue: enqueue, next-work, claim, transitions, retries,
   * directory leases, execution stats (daemon/store/queue.ts). Built in the
   * constructor, once the db is open.
   */
  private queue!: QueueStore;
  /**
   * A ref's thread (comments, triage decisions, write-back tracking),
   * attachments and token usage (daemon/store/threads.ts). Built in the
   * constructor, once the db is open.
   */
  private threads!: ThreadStore;
  /**
   * Stories, board tasks, ordering, assignments, archive, and workflows
   * (daemon/store/board.ts). Built in the constructor, once the db is open.
   */
  private board!: BoardStore;
  /**
   * Triage subjects, analyses, proposals, badges, and the triage persona
   * (daemon/store/triage.ts). Built in the constructor.
   */
  private triage!: TriageStore;
  /**
   * The persona library and every persona resolution — states, runs, mirrors,
   * sources, the assistant (daemon/store/personas.ts). Built in the constructor.
   */
  private personas!: PersonaStore;
  /** Thought notes and groups (daemon/store/thoughts.ts `ThoughtStore`). Built in the constructor. */
  private notes!: ThoughtStore;

  /**
   * The assistant conversation (sessions, messages, receipts, inbox, thoughts,
   * SSE). Delegated wholesale to store/assistant-chat.ts — see
   * docs/DESIGN.md "Assistant Chat Model".
   */
  private chat!: AssistantChat;
  /**
   * Live teammate transcripts for the watch view (docs/DESIGN.md "Watching and Pairing with a Teammate").
   * In-memory only; routes use it directly — it has no DB or config coupling.
   */
  readonly transcripts = new TeammateTranscripts();
  /** Web-UI pairing intent per teammate (docs/DESIGN.md "Watching and Pairing with a Teammate"). In-memory. */
  readonly pairing = new TeammatePairing();
  /**
   * The Work Sources (WorkDef kinds as plugins; docs/DESIGN.md "Work Sources:
   * WorkDef Kinds as Plugins"). The Store calls them at its hook points
   * (eligibility, enqueue, terminal, the periodic tick) instead of switching on
   * kind; a kind with no registered source keeps the inline default.
   */
  private sources = new SourceRegistry(
    (sourceId, options) => this.makeSourceContext(sourceId, options),
    (entry) => isSourceSwitchedOff(this.config, entry.toggle),
  );
  /**
   * The sync loop for external (pull-only) sources: timeout, backoff, and
   * isolation (daemon/sources/sync.ts); a good result comes back to
   * `ingestExternalDefs`.
   */
  private syncRunner = new SyncRunner(
    (entry, defs) => this.ingestExternalDefs(entry, defs),
    undefined,
    (entry) => isSourceSwitchedOff(this.config, entry.toggle),
    // A triage-mode source without a triage persona doesn't sync (docs/DESIGN.md "Work Source personas").
    (entry) => this.sourcePersonaProblem(entry.source.id),
  );
  /**
   * The built-in Thought (auto-triage) source, kept by reference because the
   * triage domain's sweep, Triage now, and status delegate to it.
   */
  private thoughtSource = new ThoughtSource({
    getThought: (id) => this.getThought(id),
    getActiveThoughts: () => this.getThoughts("active"),
    getThoughtGroup: (id) => this.getThoughtGroup(id),
    leaderDirectory: () => this.getLeader()?.directory,
    getTriageInstructions: () => this.getTriageInstructions(),
    getOpenStories: () => this.openStoryRefs(),
    getComments: (workDefId) => this.commentsForWorkDef(workDefId),
    decisionSummary: (thoughtId) => this.triageDecisionSummary(triageWorkDefId(thoughtId)),
  });

  /**
   * Triage mode for external sources (docs/DESIGN.md "External sources" —
   * "Triage mode"): the title, directory, prompt, and Run of a triage-mode
   * mirror, which the daemon owns in place of the source's hooks.
   */
  private externalTriage = new ExternalTriage({
    leaderDirectory: () => this.getLeader()?.directory,
    getOpenStories: () => this.openStoryRefs(),
    getComments: (workDefId) => this.commentsForWorkDef(workDefId),
    decisionSummary: (workDefId) => this.triageDecisionSummary(workDefId),
    sourceLabel: (sourceId) => this.sources.get(sourceId)?.source.label ?? sourceId,
  });

  /**
   * The built-in Story (board) source, kept by reference because the board
   * domain's moves, admission, and position changes delegate to its policy.
   * Story persistence is the board domain's; these deps are how the source reaches it.
   */
  private storySource = new StorySource({
    getStory: (id) => this.getStory(id),
    getStories: () => this.getStories(),
    isStoryReady: (id) => this.isStoryReady(id),
    getTask: (id) => this.getTask(id),
    getTasksForStory: (id) => this.getTasksForStory(id),
    getWorkflowForStory: (id) => this.getWorkflowForStory(id),
    isPending: (id) => this.isPending(id),
    writeTaskPosition: (taskId, status) => this.board.writeTaskPosition(taskId, status),
    writeTaskPoll: (taskId, poll) => this.board.writeTaskPoll(taskId, poll),
    getLatestItemState: (defId) => this.getLatestWorkItemState(defId),
    setStoryStatus: (id, status) => this.updateStoryStatus(id, status),
    getActiveItem: (defId) => this.getActiveWorkItem(defId),
    cancelActiveItem: (defId) => this.abandonActiveWorkItem(defId),
    recordAssignment: (taskId, memberId) => this.board.recordAssignment(taskId, memberId),
    releaseAssignment: (taskId) => this.releaseTask(taskId),
    getStatePersona: (workflow, state) => this.getStatePersona(workflow, state),
    getComments: (defId) => this.commentsForWorkDef(defId),
  });

  /** The stories not yet done, as `{ id, title }` (a triage prompt's "Open Stories"). */
  private openStoryRefs(): Array<{ id: string; title: string }> {
    return this.getStories().filter((s) => s.status !== "done").map((s) => ({ id: s.id, title: s.title }));
  }

  /** A WorkDef's comments (the sources' `getComments` dependency). */
  private commentsForWorkDef(workDefId: string): Comment[] {
    return this.getCommentsForRef({ workDefId });
  }

  constructor(teamDir: string, config: TeamConfig) {
    this.teamDir = teamDir;
    this.config = config;
    const dbPath = path.join(teamDir, "state.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    // Numbered migrations against PRAGMA user_version (store/schema.ts). A
    // pre-0.36.0 database throws; close it rather than leak the handle.
    try { migrateSchema(this.db); } catch (e) { this.db.close(); throw e; }
    cleanRetiredData(this.db);
    const domain = { db: this.db, teamDir, config };
    this.threads = new ThreadStore(domain, {
      sourceFor: (def) => this.sources.forWorkDef(def),
    });
    this.queue = new QueueStore(domain, {
      sourceFor: (def) => this.sources.forWorkDef(def),
      // A triage-mode mirror's title/directory are the daemon's (external-triage.ts);
      // otherwise the source's own hook, if any.
      resolveItem: (def) => {
        if (this.isTriageModeMirror(def)) return this.externalTriage.resolveItem(def);
        const src = this.sources.forWorkDef(def);
        return src?.source.resolveItem?.(def, src.ctx);
      },
      isTeamReady: () => this.isTeamReady(),
      getMembers: () => this.getMembers(),
      releaseAssignment: (workDefId) => this.releaseTask(workDefId),
      addComment: (ref, from, body) => this.addCommentForRef(ref, from, body),
    });
    this.members = new MemberStore(domain, {
      setWorkItemStateRow: (id, state) => this.setWorkItemStateRow(id, state),
      forgetLiveState: (id) => { this.transcripts.forget(id); this.pairing.forget(id); },
      saveConfig: () => this.saveConfig(),
    });
    this.board = new BoardStore(domain, {
      policy: this.storySource,
      abandonActiveWorkItem: (taskId) => this.queue.abandonActiveWorkItem(taskId),
      reconcileSources: () => this.sources.reconcileAll(),
    });
    this.personas = new PersonaStore(domain, {
      getWorkflows: () => this.board.getWorkflows(),
      saveWorkflow: (name, wf) => this.board.saveWorkflow(name, wf),
      getTask: (id) => this.board.getTask(id),
      getStory: (id) => this.board.getStory(id),
      resolveTriagePersona: () => this.triage.resolveTriagePersona(),
      isTriageModeMirror: (def) => this.triage.isTriageModeMirror(def),
      getSourceEntry: (id) => this.sources.get(id),
      listSourceEntries: () => this.sources.all(),
      forceSync: (entry) => void this.syncRunner.run(entry, { force: true }),
      getPluginStatuses: () => this.pluginStatuses,
      saveConfig: () => this.saveConfig(),
      commitToGit: (message) => this.commitToGit(message),
    });
    this.triage = new TriageStore(domain, {
      notes: this.thoughtSource,
      threads: this.threads,
      board: this.board,
      createWorkDef: (input, enqueue) => this.createWorkDef(input, enqueue),
      resolvePersona: (ref, opts, where) => this.personas.resolvePersona(ref, opts, where),
    });
    this.notes = new ThoughtStore(domain, {
      getActiveWorkItem: (id) => this.queue.getActiveWorkItem(id),
      setWorkItemStateRow: (id, state) => this.queue.setWorkItemStateRow(id, state),
    });
    // Session persona titles come from the persona library (the persona domain).
    this.chat = new AssistantChat(this.db, teamDir, (id) => this.getPersona(id)?.title ?? null);
    // Usage: the `usage/*.jsonl` files are the source of truth; rebuild the
    // SQLite cache from them.
    syncUsageLedger(this.db, teamDir);
    this.resetConnectionsForBoot();
    this.board.reloadWorkflows();
    // The built-in kinds. Thought is always on — it declares no toggle — so
    // it's always registered; the toggleable ones are too (a toggle gates
    // routes, not the queue: docs/DESIGN.md "Feature Toggles").
    this.sources.register(taskSource);
    this.sources.register(this.storySource);
    this.sources.register(scheduleSource);
    this.sources.register(this.thoughtSource);
  }

  // --- Work Sources (docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins") ---

  /**
   * The daemon-side capabilities a source gets. `enqueue` is the single
   * `enqueueFor`, so every source inherits "pending never enqueues" and the
   * directory normalization for free.
   */
  private makeSourceContext(sourceId: string, options: () => Readonly<Record<string, unknown>> = () => EMPTY_SOURCE_OPTIONS): SourceContext {
    const hasActiveItem = (defId: string) => this.getActiveWorkItem(defId) !== null;
    // An external source switched off is disconnected (docs/DESIGN.md "Feature
    // Toggles"): whatever path it takes — a webhook, a write-back hook — it
    // mirrors and enqueues nothing until it's switched back on.
    const disconnected = () => {
      const entry = this.sources.get(sourceId);
      return !!entry?.source.sync && isSourceSwitchedOff(this.config, entry.toggle);
    };
    const enqueue = (defId: string) => disconnected() ? null : this.enqueueFor(defId);
    const kv = fileSourceKv(this.teamDir, sourceId);
    const defaultCursor = kvRevisionCursor(kv);
    return {
      sourceId,
      teamDir: this.teamDir,
      config: () => this.config,
      options: () => options(),
      log: (message) => console.warn(`[source:${sourceId}] ${message}`),
      listWorkDefs: () => listWorkDefs(this.teamDir),
      hasActiveItem,
      enqueue,
      enqueueRevision: (defId, revision, opts) => enqueueRevision({ hasActiveItem, enqueue }, defaultCursor, defId, revision, opts),
      upsertDef: (def) => disconnected() ? null : upsertMirror(this.teamDir, sourceId, kv, def, this.sourceMode(sourceId))?.def ?? null,
      kv,
      readiness: { canEnqueueNow: () => this.canScheduleNow() },
    };
  }

  /** A registered source's declared `mode` (undefined = "work"). */
  private sourceMode(sourceId: string): WorkSourceMode | undefined {
    return this.sources.get(sourceId)?.source.mode;
  }

  /**
   * Register a Work Source (and run its `init`). Built-ins register in the
   * constructor; this is the seam for in-repo fixture sources in tests and
   * for plugin sources, whose package entry's `config` is `opts.options`
   * (`ctx.options()`). Throws on a duplicate id or unsupported apiVersion.
   */
  registerWorkSource(source: WorkSource, opts: RegisterSourceOptions = {}): void {
    this.sources.register(source, opts);
  }

  /**
   * Remove a registered Work Source (a test seam: swap a built-in for a fixture).
   * Its kind then falls back to the Store's inline defaults. False if none was registered.
   */
  unregisterWorkSource(id: string): boolean {
    return this.sources.unregister(id);
  }

  /** The registered source that owns a WorkDef (by `parent.kind`; none = "task"), if any. */
  getWorkSourceFor(def: Pick<WorkDef, "parent">): SourceEntry | undefined {
    return this.sources.forWorkDef(def);
  }

  /** Every registered Work Source with its context, in registration order (daemon/features.ts reads the toggles). */
  listWorkSources(): SourceEntry[] {
    return this.sources.all();
  }

  /** Run every source's periodic `tick` now (the 30s timer calls this). */
  tickWorkSources(now: Date = new Date()): void {
    this.sources.tickAll(now);
  }

  /**
   * How each plugin package fared at startup (daemon/plugins/loader.ts records
   * it once, after loading; `GET /api/sources` and `mpt doctor` read it).
   */
  private pluginStatuses: PluginLoadStatus[] = [];

  /** Record the plugin packages' load status (the loader calls this once at startup). */
  setPluginStatuses(statuses: PluginLoadStatus[]): void {
    this.pluginStatuses = statuses;
  }

  /** Each plugin package's load status, in config order (empty when the team declares none). */
  getPluginStatuses(): PluginLoadStatus[] {
    return this.pluginStatuses;
  }

  /**
   * Replace one source's load-time settings warnings (`source "<id>": …`) in
   * its package's status — after a settings Save re-checked them, so a fixed
   * setting stops being reported.
   */
  replaceSourceConfigWarnings(sourceId: string, warnings: string[]): void {
    const prefix = `source "${sourceId}": `;
    this.pluginStatuses = this.pluginStatuses.map((status) => {
      if (!status.sources.includes(sourceId)) return status;
      const kept = (status.warnings ?? []).filter((w) => !w.startsWith(prefix));
      const next = [...kept, ...warnings.map((w) => prefix + w)];
      const { warnings: _old, ...rest } = status;
      return next.length ? { ...rest, warnings: next } : rest;
    });
  }

  /** The external (pull-only) sources — those with a `sync` — in registration order. */
  listExternalSources(): SourceEntry[] {
    return this.sources.external();
  }

  /**
   * Run one external source's sync now (its timer calls this; so do tests).
   * Never rejects: a failure is logged and backs the source off (`force`
   * ignores the backoff). See daemon/sources/sync.ts.
   */
  syncWorkSource(id: string, opts: { now?: number; force?: boolean } = {}): Promise<SyncOutcome> {
    const entry = this.sources.get(id);
    if (!entry?.source.sync) {
      return Promise.resolve({ ok: false, error: `No external source "${id}"`, mirrored: [], enqueued: [], archived: [], held: [] });
    }
    return this.syncRunner.run(entry, opts);
  }

  /** Consecutive sync failures of an external source (0 when healthy). */
  syncFailures(id: string): number {
    return this.syncRunner.failures(id);
  }

  /** An external source's sync health: the last sync's result and any backoff (daemon/sources/sync.ts `SyncStatus`). */
  getSyncStatus(id: string): SyncStatus {
    return this.syncRunner.status(id);
  }

  /**
   * Re-initialize a registered source with new settings, without a restart
   * (a Config page Save; `PUT /api/sources/:id/config`): swap its
   * `ctx.options()`, call `init` again (awaited, bounded by its
   * `syncTimeoutMs`), and forget its sync failures/backoff. Then, if it's an
   * external source that's switched on, sync it now — fire-and-forget, so the
   * caller isn't held by a slow external system. A failed `init` is returned
   * (and kept as the entry's `initError`), never thrown; the new settings stay.
   * Timers aren't re-armed: a changed `syncEveryMs` applies after a restart.
   */
  async reinitWorkSource(id: string, options: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = this.sources.get(id);
    if (!entry) return { ok: false, error: `No work source "${id}"` };
    const timeoutMs = entry.source.syncTimeoutMs && entry.source.syncTimeoutMs > 0 ? entry.source.syncTimeoutMs : DEFAULT_SYNC_TIMEOUT_MS;
    const result = await this.sources.reinit(id, options, timeoutMs);
    this.syncRunner.reset(id);
    if (result.ok && entry.source.sync && !isSourceSwitchedOff(this.config, entry.toggle)) {
      void this.syncRunner.run(entry, { force: true });
    }
    return result;
  }

  /**
   * A mirrored def's runtime state, from its source's kv (`sources/<id>.json`) —
   * read straight from disk, so it answers even if the source isn't registered
   * any more: the revision last mirrored, and whether sync archived it for vanishing.
   */
  getMirrorState(def: WorkDef): { revision?: string; vanished: boolean; mode: WorkSourceMode; personaOverride?: string } {
    if (def.parent?.kind !== "external") return { vanished: false, mode: "work" };
    const kv = fileSourceKv(this.teamDir, sourceIdForWorkDef(def));
    const personaOverride = kv.get(mirrorPersonaKey(def.id));
    return {
      revision: kv.get(mirrorRevisionKey(def.id)),
      vanished: kv.get(vanishedKey(def.id)) !== undefined,
      mode: mirrorMode(kv, def.id),
      ...(personaOverride ? { personaOverride } : {}),
    };
  }

  /** The newest WorkItem's state for a WorkDef (CANCELED included), or null if it never had one. */
  getLatestWorkItemState(defId: string): WorkItemState | null { return this.queue.getLatestWorkItemState(defId); }

  /**
   * Apply one good sync result (docs/DESIGN.md "Work Sources" — external sources):
   *   1. mirror every reported item (read-only; a no-op for an unchanged revision);
   *   2. enqueue one WorkItem per new revision via `enqueueRevision` (in flight →
   *      wait for the next sync; the daemon not ready → held, and since nothing
   *      was stamped, the next sync after it recovers enqueues it). A mirror a
   *      person archived is left alone;
   *   3. archive — never delete — the mirrors of items no longer reported (their
   *      thread is history), withdrawing a still-READY item. One reported again
   *      comes back (daemon/sources/mirror.ts).
   */
  private ingestExternalDefs(entry: SourceEntry, defs: ExternalDef[]): SyncOutcome {
    const { source, ctx } = entry;
    const out: SyncOutcome = { ok: true, mirrored: [], enqueued: [], archived: [], held: [], commented: [], needsPersona: [] };
    const seen = new Set<string>();
    for (const ext of defs) {
      // The item's mode (its own, else the source's) is recorded with the mirror;
      // a triage-mode item is enqueued exactly the same way — once per revision.
      const res = upsertMirror(this.teamDir, source.id, ctx.kv, ext, source.mode);
      if (!res) {
        ctx.log(`skipped an invalid item from sync: ${JSON.stringify(ext)?.slice(0, 200)}`);
        continue;
      }
      const { def, changed } = res;
      seen.add(def.id);
      if (changed) out.mirrored.push(def.id);
      // The thread is merged separately from the content: a new comment is not
      // a revision, so it never enqueues (docs/DESIGN.md "A mirrored thread").
      // A person-archived mirror still gets its thread kept current.
      if (ext.comments !== undefined && this.ingestExternalComments(entry, def.id, ext.comments) > 0) out.commented!.push(def.id);
      if (def.status === "archived") continue;
      const handedOver = kvRevisionCursor(ctx.kv).get(def.id) === ext.revision;
      if (handedOver || ctx.hasActiveItem(def.id)) continue;
      // A triage item with no triage persona is mirrored but not enqueued —
      // nothing stamped, so it runs on the first sync after one is set.
      if (mirrorMode(ctx.kv, def.id) === "triage" && !this.personas.mirrorHasTriagePersona(def)) {
        out.needsPersona!.push(def.id);
        continue;
      }
      // Readiness gating, as a Schedule holds its firing (docs/DESIGN.md "Readiness Gating").
      if (!ctx.readiness.canEnqueueNow()) {
        out.held.push(def.id);
        continue;
      }
      const item = ctx.enqueueRevision(def.id, ext.revision);
      if (item) out.enqueued.push(item.id);
    }
    for (const def of listWorkDefs(this.teamDir)) {
      if (sourceIdForWorkDef(def) !== source.id || def.parent?.kind !== "external") continue;
      if (def.status === "archived" || seen.has(def.id)) continue;
      const active = this.getActiveWorkItem(def.id);
      if (active?.state === "READY") this.cancelWorkItem(active.id);
      updateWorkDef(this.teamDir, def.id, { status: "archived" });
      ctx.kv.set(vanishedKey(def.id), new Date().toISOString());
      out.archived.push(def.id);
    }
    this.personas.setPersonaHeld(source.id, out.needsPersona!);
    return out;
  }

  /**
   * Merge a source's reported comments into a mirror's thread (docs/DESIGN.md
   * "External sources" — "A mirrored thread"): append the ones it hasn't seen
   * (by the source's comment id, or recorded as written back by MPT), marked
   * `external`. Appended directly, not through `addCommentForRef`, so
   * `onComment` never fires for them — nothing is echoed back. While a
   * write-back for this def is still in flight, new comments wait for the next
   * sync: the post may already be in the list, before its id is recorded.
   * Returns how many were appended.
   */
  private ingestExternalComments(entry: SourceEntry, defId: string, reported: unknown[]): number {
    const { source, ctx } = entry;
    const ref = { workDefId: defId };
    const { added, invalid } = mergeExternalComments(source.id, defId, this.getThreadEntries(ref), ctx.kv, reported);
    for (const why of invalid) ctx.log(`skipped a comment on ${defId}: ${why}`);
    if (added.length === 0) return 0;
    if (this.threads.writeBackInFlight(defId)) return 0;
    for (const c of added) this.appendThreadEntry(ref, c);
    return added.length;
  }

  /**
   * Archive — never delete — every non-archived mirror of an external source,
   * for a **disconnect** (daemon/features.ts `disconnectSource`, which switches
   * the source's feature off first so no sync in flight can bring them back).
   * A still-READY WorkItem is canceled (write-back sees CANCELED, as for a
   * vanished item); an IN_PROGRESS/MORIBUND one is left to finish — the agent
   * protocol is never gated. Each archived mirror is marked
   * (`disconnected:<defId>` in the source's kv), so switching the source back
   * on restores it when sync reports the item again. Returns the archived ids.
   */
  archiveExternalMirrors(sourceId: string): string[] {
    const kv = fileSourceKv(this.teamDir, sourceId);
    const archived: string[] = [];
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind !== "external" || sourceIdForWorkDef(def) !== sourceId || def.status === "archived") continue;
      const active = this.getActiveWorkItem(def.id);
      if (active?.state === "READY") this.cancelWorkItem(active.id);
      updateWorkDef(this.teamDir, def.id, { status: "archived" });
      kv.set(disconnectedKey(def.id), new Date().toISOString());
      archived.push(def.id);
    }
    return archived;
  }

  /**
   * Clear ephemeral connection state on daemon boot. Members and assignments
   * are connection state, not durable records (see the file header) — but they
   * live in SQLite, so without this a freshly-started daemon (which holds zero
   * live agent connections) would keep listing the previous run's agents as
   * "offline" forever. Agents re-register when they reconnect.
   *
   * Any WorkItem left IN_PROGRESS lost its holder across the restart, so it's
   * moved to MORIBUND — honest about the lost connection and recoverable by a
   * human (force-fail / re-enqueue) or by the same agent reconnecting and
   * completing it (setWorkItemState accepts MORIBUND). Its `member_id` is kept
   * so that path still authorizes.
   */
  private resetConnectionsForBoot(): void {
    this.queue.markInFlightMoribundForBoot();
    this.db.exec("DELETE FROM assignments");
    this.db.exec("DELETE FROM members");
  }

  // --- The board: stories, tasks, workflows, archive (daemon/store/board.ts) ---

  /** Every loaded workflow, by name. */
  getWorkflows(): Record<string, WorkflowConfig> { return this.board.getWorkflows(); }

  /** Reload workflows from disk (called after config changes). */
  reloadWorkflows(): void { this.board.reloadWorkflows(); }

  /** Save a workflow to its directory. */
  saveWorkflow(name: string, wf: WorkflowConfig): void { this.board.saveWorkflow(name, wf); }

  /** The stories naming a workflow explicitly, open vs done; see `BoardStore.getWorkflowUsage`. */
  getWorkflowUsage(name: string): WorkflowUsage { return this.board.getWorkflowUsage(name); }

  /** Delete a workflow (its folder moves to `workflows/.deleted/`); returns the backup path. Throws `WorkflowDeleteError` when refused; see `BoardStore.deleteWorkflow`. */
  deleteWorkflow(name: string): string { return this.board.deleteWorkflow(name); }

  /** The effective workflow for a story (its override → `defaultWorkflow`). */
  getWorkflowForStory(storyId: string): WorkflowConfig { return this.board.getWorkflowForStory(storyId); }

  /** The effective workflow for a task (via its story). */
  getWorkflowForTask(taskId: string): WorkflowConfig { return this.board.getWorkflowForTask(taskId); }

  /** Rebuild the stories/tasks cache from disk, then let every source reconcile; see `BoardStore.loadFromDisk`. */
  loadFromDisk(): void { this.board.loadFromDisk(); }

  /** Every active story, by id. */
  getStories(): (Story & { dirPath: string })[] { return this.board.getStories(); }

  /** True when the id is an active story. */
  hasStory(id: string): boolean { return this.board.hasStory(id); }

  /** True when the id is taken by an active or an archived story (check before creating one). */
  isStoryIdTaken(id: string): boolean { return this.board.isStoryIdTaken(id); }

  /** Create a story and its tasks, then run admission; see `BoardStore.createStory`. */
  createStory(...args: Parameters<BoardStore["createStory"]>): { story: Story; tasks: TaskWithMeta[] } { return this.board.createStory(...args); }

  /** Append a board task in `todo` (optionally pending), then run admission. */
  addTask(storyId: string, input: { title: string; description: string; pending?: boolean }): TaskWithMeta | null { return this.board.addTask(storyId, input); }

  /** One active story, or null. */
  getStory(id: string): (Story & { dirPath: string }) | null { return this.board.getStory(id); }

  /** Not done, and every dependency done (or no longer active). */
  isStoryReady(storyId: string): boolean { return this.board.isStoryReady(storyId); }

  /** Edit a story's fields, then re-run admission (and unblock dependents on done); throws `StoryUpdateError` on a refused workflow change. See `BoardStore.updateStoryDetails`. */
  updateStoryDetails(storyId: string, updates: Parameters<BoardStore["updateStoryDetails"]>[1]): boolean { return this.board.updateStoryDetails(storyId, updates); }

  /** Move a story active ⇄ pending (docs/DESIGN.md "Pending: Write, Review, Activate"); false when missing. */
  setStoryPending(storyId: string, pending: boolean): boolean { return this.board.setStoryPending(storyId, pending); }

  /** Set a story open/done; done unblocks its dependents. */
  updateStoryStatus(storyId: string, status: "open" | "done"): void { this.board.updateStoryStatus(storyId, status); }

  /** A story's tasks in the story-owned order. */
  getTasksForStory(storyId: string): TaskWithMeta[] { return this.board.getTasksForStory(storyId); }

  /** One board task, or null. */
  getTask(taskId: string): TaskWithMeta | null { return this.board.getTask(taskId); }

  /** Set a task's status (compatibility wrapper; judgment moves use `moveTask`). */
  updateTaskStatus(taskId: string, status: string): void { this.board.updateTaskStatus(taskId, status); }

  /** Judgment move (human or leader) to any workflow position; see daemon/sources/story.ts. */
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string } { return this.board.moveTask(taskId, newStatus); }

  /** Delete a board task (its WorkItem, cache rows, WorkDef dir), then run admission. */
  deleteTask(taskId: string): boolean { return this.board.deleteTask(taskId); }

  /** Reorder a story's tasks (`orderedIds` must be a permutation of its task ids). */
  reorderTasks(storyId: string, orderedIds: string[]): boolean { return this.board.reorderTasks(storyId, orderedIds); }

  /** CONWIP admission (WIP = 1 per story); `excludeTaskId` keeps a just-shelved task out. */
  runAdmission(storyId: string, excludeTaskId?: string): void { this.board.runAdmission(storyId, excludeTaskId); }

  /** Release a WorkDef's assignment row (a no-op for anything but a board task). */
  releaseTask(taskId: string): void { this.board.releaseTask(taskId); }

  /** A board task's assignment, or null. */
  getAssignment(taskId: string): Assignment | null { return this.board.getAssignment(taskId); }

  /** A member's assignment with its task, or null. */
  getAssignmentForMember(memberId: string): (Assignment & { task: TaskWithMeta }) | null { return this.board.getAssignmentForMember(memberId); }

  /** Delete a story, its task WorkDefs and its file (throws while a task is assigned). */
  deleteStory(storyId: string): boolean { return this.board.deleteStory(storyId); }

  /** True when the story has tasks and every one is done. */
  isStoryArchivable(storyId: string): boolean { return this.board.isStoryArchivable(storyId); }

  /** Archive a finished story in place (`archivedAt` + synopsis); throws unless archivable. */
  archiveStory(storyId: string): void { this.board.archiveStory(storyId); }

  /** True when `storyId` names an archived story. */
  isStoryArchived(storyId: string): boolean { return this.board.isStoryArchived(storyId); }

  /** Every archived story (id, title, synopsis). */
  getArchivedStories(): Array<{ id: string; title: string; synopsis: string }> { return this.board.getArchivedStories(); }

  /** An archived story's file plus its tasks' WorkDefs and comments, or null. */
  getArchivedStoryContext(storyId: string): ReturnType<BoardStore["getArchivedStoryContext"]> { return this.board.getArchivedStoryContext(storyId); }

  // --- WorkItem queue (daemon/store/queue.ts) ---
  //
  // A WorkItem is the unit of agent execution: a dumb, terminal-only attempt
  // pointing at a story task or a WorkDef. See docs/DESIGN.md "The WorkItem".

  /** Record a WorkItem's claim-time persona snapshot; see `QueueStore.recordWorkItemPersona`. */
  recordWorkItemPersona(id: string, persona: PersonaRef | null): void { this.queue.recordWorkItemPersona(id, persona); }

  /** One WorkItem by id, or null. */
  getWorkItem(id: string): WorkItem | null { return this.queue.getWorkItem(id); }

  /** List WorkItems, optionally filtered by state(s)/read, newest-first, paginated. */
  getWorkItems(opts?: { states?: WorkItemState[]; read?: boolean; workDefId?: string; limit?: number; offset?: number }): { items: WorkItem[]; total: number } {
    return this.queue.getWorkItems(opts);
  }

  /** Count WorkItems matching state(s)/read without loading any rows (the toolbar badges). */
  countWorkItems(opts?: { states?: WorkItemState[]; read?: boolean }): number { return this.queue.countWorkItems(opts); }

  /** The active (READY/IN_PROGRESS/MORIBUND) WorkItem for a WorkDef, if any. */
  getActiveWorkItem(workDefId: string): WorkItem | null { return this.queue.getActiveWorkItem(workDefId); }

  /** Per-WorkDef run count and last run, CANCELED excluded; see `QueueStore.getExecutionStats`. */
  getExecutionStats(): Map<string, WorkDefExecutionStats> { return this.queue.getExecutionStats(); }

  /** Execution stats for one WorkDef (zero runs → `{ executionCount: 0, lastRunAt: null }`). */
  getExecutionStatsFor(workDefId: string): WorkDefExecutionStats { return this.queue.getExecutionStatsFor(workDefId); }

  /** The single WorkItem creator (refuses pending WorkDefs); see `QueueStore.enqueueFor`. */
  private enqueueFor(workDefId: string, retry?: { attempt: number; retryAt: number }): WorkItem | null { return this.queue.enqueueFor(workDefId, retry); }

  /** The queue's bare row transition (no assignment release, no source hook). */
  private setWorkItemStateRow(id: string, state: WorkItemState, memberId?: string | null): void { this.queue.setWorkItemStateRow(id, state, memberId); }

  /** Cancel a task's active WorkItem (internal override on position changes). */
  private abandonActiveWorkItem(taskId: string): void { this.queue.abandonActiveWorkItem(taskId); }

  /** The next READY WorkItem for a polling agent (directory affinity, leases, retry backoff); see `QueueStore.getNextWorkItem`. */
  getNextWorkItem(agent: { id?: string; directory?: string }, now: number = Date.now()): WorkItem | null { return this.queue.getNextWorkItem(agent, now); }

  /** Lease a READY WorkItem to a member (→ IN_PROGRESS); see `QueueStore.claimWorkItem`. */
  claimWorkItem(id: string, memberId: string, persona?: PersonaRef | null): boolean { return this.queue.claimWorkItem(id, memberId, persona); }

  /** The active WorkItem whose directory lease blocks `item`, or null; see `QueueStore.getDirectoryBlocker`. */
  getDirectoryBlocker(item: WorkItem): WorkItem | null { return this.queue.getDirectoryBlocker(item); }

  /** Agent-facing terminal transition (COMPLETE/FAILED); see `QueueStore.setWorkItemState`. */
  setWorkItemState(id: string, state: "COMPLETE" | "FAILED"): { ok: boolean; error?: string; newStatus?: string; completed?: boolean } {
    return this.queue.setWorkItemState(id, state);
  }

  /**
   * The agent ends its run with wait (docs/DESIGN.md "Polling States"): only a
   * board task in a poll state may; anywhere else — a once state, a manual or
   * bucket position, a Solitary/Scheduled WorkDef — it is refused and the item
   * is left as it was. The item goes WAITED (`QueueStore.waitWorkItem`) and the
   * task's poll record notes the check (`StorySource.recordWait`); the task
   * neither advances nor fails. The daemon posts no comment — the agent's
   * `[wait]` comment is its record, as for done and fail.
   */
  waitWorkItem(id: string, reason: string): { ok: boolean; error?: string; poll?: TaskPollRecord } {
    const item = this.getWorkItem(id);
    if (!item) return { ok: false, error: "WorkItem not found" };
    if (item.state !== "IN_PROGRESS" && item.state !== "MORIBUND") {
      return { ok: false, error: `WorkItem is ${item.state}, not in flight` };
    }
    const task = this.getTask(item.ref.workDefId);
    if (!task || !this.storySource.pollSettingsFor(task.id)) {
      const where = task ? `its state "${task.status}" completes once` : "it isn't a board task in a poll state";
      return { ok: false, error: `Can't wait: ${where}. Finish with done (end with a summary) or fail.` };
    }
    const res = this.queue.waitWorkItem(id);
    if (!res.ok) return res;
    const poll = this.storySource.recordWait(task.id, reason) ?? undefined;
    return { ok: true, poll };
  }

  /**
   * How the work a WorkItem runs finishes: `poll` for a board task in a poll
   * state (the run may end with wait), else `once`. Reported on claim, so a
   * harness offers its wait tool only where wait is accepted.
   */
  completionFor(workDefId: string): WorkflowStateCompletion {
    return this.storySource.pollSettingsFor(workDefId) ? "poll" : "once";
  }

  /** Tell the item's source it reached a terminal state (hook: onItemTerminal). */
  private notifyItemTerminal(itemId: string): ItemTerminalOutcome { return this.queue.notifyItemTerminal(itemId); }

  /** An errored agent session: `[retry]` + a backoff-held retry, or `[failed]`; see `QueueStore.failWorkItemForSessionError`. */
  failWorkItemForSessionError(id: string, sessionError: string, now: number = Date.now()): {
    ok: boolean; error?: string; retry?: { workItemId: string; attempt: number; maxAttempts: number; retryAt: string };
  } {
    return this.queue.failWorkItemForSessionError(id, sessionError, now);
  }

  /** Cancel a READY WorkItem (human). */
  cancelWorkItem(id: string): boolean { return this.queue.cancelWorkItem(id); }

  /** Force a MORIBUND item to FAILED (human decided the agent is truly gone). */
  forceFailWorkItem(id: string, reEnqueue = false): { ok: boolean; error?: string; newItem?: WorkItem | null } { return this.queue.forceFailWorkItem(id, reEnqueue); }

  /** Create a fresh READY WorkItem for a ref that has no active one. */
  reEnqueueRef(ref: WorkItemRef): WorkItem | null { return this.queue.reEnqueueRef(ref); }

  /** Mark a WorkItem read/unread (Inbox). */
  markWorkItemRead(id: string, read = true): boolean { return this.queue.markWorkItemRead(id, read); }

  // --- Token Usage ---

  /** Record a run's usage against a ref (a no-op for an unknown WorkDef); see `ThreadStore.addTokenUsage`. */
  addTokenUsage(
    ref: WorkItemRef, inputTokens: number, outputTokens: number, model: string, costUsd: number,
    extra: Omit<Partial<UsageEntry>, "refId" | "inputTokens" | "outputTokens" | "model" | "costUsd" | "title"> = {},
  ): void {
    this.threads.addTokenUsage(ref, inputTokens, outputTokens, model, costUsd, extra);
  }

  /** Record a run's usage that isn't for any ref (the leader's chat, a teammate between items). */
  recordRunUsage(entry: UsageEntry): void {
    recordUsage(this.db, entry, this.teamDir);
  }

  /** Usage per local day since `sinceMs` (the Usage dashboard's grid). */
  getDailyUsage(opts: { sinceMs: number; tzOffsetMin: number }): UsageDay[] {
    return dailyUsage(this.db, opts);
  }

  /** Every run on one local day, most expensive first. */
  getUsageRunsOnDay(opts: { date: string; tzOffsetMin: number }): UsageRun[] {
    return runsOnDay(this.db, opts);
  }

  /** A ref's runs' usage rows, oldest first. */
  getTokenUsage(taskId: string): Array<{ inputTokens: number; outputTokens: number; model: string; costUsd: number; at: string }> {
    return this.threads.getTokenUsage(taskId);
  }

  /** A ref's total cost and tokens across its runs, or null when it has none. */
  getTokenUsageSummary(ref: WorkItemRef): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null {
    return this.threads.getTokenUsageSummary(ref);
  }

  // --- Members, dismissals, the reaper (daemon/store/members.ts) ---

  /** Register (or re-register) an agent; see `MemberStore.registerMember`. */
  registerMember(
    id: string,
    name: string,
    directory?: string,
    metadata: Record<string, unknown> = {},
    handshake?: { protocolVersion?: number; harness?: string; harnessVersion?: string; instanceId?: string },
  ): void {
    this.members.registerMember(id, name, directory, metadata, handshake);
  }

  /** The live leader a leader registration would collide with, or null; see `MemberStore.leaderRegistrationConflict`. */
  leaderRegistrationConflict(id: string, name: string, instanceId?: string): Member | null {
    return this.members.leaderRegistrationConflict(id, name, instanceId);
  }

  /** Set a member's status (and refresh its heartbeat time). */
  updateMemberStatus(id: string, status: string): void { this.members.updateMemberStatus(id, status); }

  /** Record a heartbeat; a reaped agent coming back restores its MORIBUND items (docs/DESIGN.md "Reaping"). */
  heartbeat(id: string, status: string): void { this.members.heartbeat(id, status); }

  /** Every registered member, by name. */
  getMembers(): Member[] { return this.members.getMembers(); }

  /** One member, or null when the id isn't registered. */
  getMember(id: string): Member | null { return this.members.getMember(id); }

  /** Remove a member; its in-flight WorkItems go to MORIBUND first (docs/DESIGN.md "Reaping"). */
  removeMember(id: string): void { this.members.removeMember(id); }

  /** Record an agent's session stats (context fill, session cost); stamps `at`. */
  setMemberSessionStats(id: string, stats: Omit<MemberSessionStats, "at">): void { this.members.setMemberSessionStats(id, stats); }

  /** An agent's last-reported session stats, if it has reported any this session. */
  getMemberSessionStats(id: string): MemberSessionStats | undefined { return this.members.getMemberSessionStats(id); }

  /** Dismiss a member: remove it and leave a tombstone so its next heartbeat is told `dismissed`. */
  dismissMember(id: string): void { this.members.dismissMember(id); }

  /** A dismissed agent's heartbeat was just answered `dismissed`; it is now exiting. */
  noteDismissedHeartbeat(id: string): void { this.members.noteDismissedHeartbeat(id); }

  /** A dismissed agent deregistered (its clean-shutdown DELETE): it has exited. */
  noteDismissedDeregistered(id: string): void { this.members.noteDismissedDeregistered(id); }

  /** Has a dismissed agent gone (deregistered, or told `dismissed` at least `exitGraceMs` ago)? */
  dismissedAgentExited(id: string, exitGraceMs = DISMISS_EXIT_GRACE_MS): boolean { return this.members.dismissedAgentExited(id, exitGraceMs); }

  /** True when `id` was explicitly dismissed (tombstoned) and not since re-registered. */
  isDismissed(id: string): boolean { return this.members.isDismissed(id); }

  /** Mark timed-out agents offline (their in-flight items → MORIBUND); returns their ids. */
  reapOfflineAgents(): string[] { return this.members.reapOfflineAgents(); }

  // --- Autosave timers ---

  startTimers(): void {
    if (this.config.autosave.autoCommit) {
      // Checkpoint the team dir every `flushIntervalMinutes`. Every file it
      // commits (stories, WorkDefs, notes, usage) is written as it changes, so
      // there is nothing to flush first.
      const autosaveMs = this.config.autosave.flushIntervalMinutes * 60 * 1000;
      this.autosaveTimer = setInterval(() => this.commitToGit(), autosaveMs);
      // Also run a commit on a longer interval as a safety net
      const commitMs = this.config.autosave.commitIntervalHours * 60 * 60 * 1000;
      this.commitTimer = setInterval(() => this.commitToGit(), commitMs);
    }

    // Check for offline agents every 30 seconds, then top the teammate pool back
    // up to `minTeammates` (reaping first means a lost teammate is replaced on
    // the same tick it goes offline).
    this.heartbeatCheckTimer = setInterval(() => {
      this.reapOfflineAgents();
      // Keep the active chat's markdown snapshot fresh so a crash loses minutes,
      // not the whole conversation (docs/DESIGN.md "Assistant Chat Model").
      this.refreshAssistantSnapshot();
      this.reconcileTeammatePool();
    }, 30_000);

    // Work Source ticks, one timer per ticking source at the interval it asks
    // for (`tickEveryMs`, default 30s): the Schedule source enqueues due
    // Scheduled WorkDefs every 30s (minute-granular, deduped per minute; see
    // cron.ts and daemon/sources/schedule.ts); the Thought source sweeps the
    // notes every triage `intervalMinutes`, and has no timer when triage is off
    // (TODO.md "Auto Triage"; daemon/sources/thought.ts).
    for (const { id, everyMs } of this.sources.tickSchedule(30_000)) {
      this.sourceTimers.push(setInterval(() => this.sources.tick(id, new Date()), everyMs));
    }

    // External sources' sync, one timer each at `syncEveryMs` (default 60s), plus
    // a prompt first run so a restarted daemon catches up without waiting a full
    // interval. SyncRunner isolates them: a slow or failing source never blocks
    // the timer, the daemon, or another source (daemon/sources/sync.ts).
    for (const entry of this.sources.external()) {
      const everyMs = entry.source.syncEveryMs ? entry.source.syncEveryMs(entry.ctx) : DEFAULT_SYNC_EVERY_MS;
      if (everyMs === null || everyMs <= 0) continue;
      const run = () => void this.syncRunner.run(entry);
      this.syncTimers.push(setTimeout(run, 1_000));
      this.syncTimers.push(setInterval(run, everyMs));
    }
  }

  stopTimers(): void {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
    for (const t of this.sourceTimers) clearInterval(t);
    this.sourceTimers = [];
    // clearInterval also clears the first-run timeouts (one timer id space).
    for (const t of this.syncTimers) clearInterval(t);
    this.syncTimers = [];
  }

  /** The team's config, as resolved at startup. */
  getConfig(): TeamConfig {
    return this.config;
  }

  /**
   * Whether this daemon process can reach tmux — probed once at startup
   * (daemon/start.ts) and combined with the live config by `getSpawnCapability`.
   *
   * Reported via /health so `mpt doctor` and the Team tab can say why nothing
   * spawns; a spawn the daemon can't realize is failed with the same reason
   * (daemon/store/members.ts createLeaderDirective).
   */
  setTmuxCapability(capability: SpawnCapability): void {
    this.members.setTmuxCapability(capability);
  }

  /** Can this daemon realize a spawn of `harness` (default: the team's)? See MemberStore.getSpawnCapability. */
  getSpawnCapability(harness?: string): SpawnCapability {
    return this.members.getSpawnCapability(harness);
  }

  /** Can this daemon process drive the configured terminal (tmux's startup probe, or herdr's)? See MemberStore.getTerminalCapability. */
  getTerminalCapability(): SpawnCapability {
    return this.members.getTerminalCapability();
  }

  /** Replace the non-tmux terminal probe (tests). See MemberStore.setTerminalProbe. */
  setTerminalProbe(probe: (config: TeamConfig) => SpawnCapability): void {
    this.members.setTerminalProbe(probe);
  }

  /** Can this daemon process reach tmux at all (the startup probe)? See MemberStore.getTmuxCapability. */
  getTmuxCapability(): SpawnCapability {
    return this.members.getTmuxCapability();
  }

  /** Can the assistant be started from the web UI? See MemberStore.getAssistantStartability. */
  getAssistantStartability(): AssistantStartability {
    return this.members.getAssistantStartability();
  }

  /**
   * The daemon's own URL, for a leader template's `{url}` (`POST /api/assistant/start`).
   * Set at startup once the port is known (daemon/start.ts); a store nobody set
   * (tests, tools) assumes the default port.
   */
  private daemonUrl = DEFAULT_DAEMON_URL;

  /** Record the URL agents reach this daemon at (startup). */
  setDaemonUrl(url: string): void {
    this.daemonUrl = url;
  }

  /** The URL agents reach this daemon at. */
  getDaemonUrl(): string {
    return this.daemonUrl;
  }

  /** The tmux server socket the daemon talks to (daemon/terminal/tmux.ts tmuxSocketPath), or null when unknown. */
  private tmuxSocket: string | null = null;

  /** Record the tmux server socket path (found once at startup). */
  setTmuxSocket(socket: string | null): void {
    this.tmuxSocket = socket;
  }

  /** The tmux server socket the daemon talks to, for /health and `mpt doctor`'s same-server check. */
  getTmuxSocket(): string | null {
    return this.tmuxSocket;
  }

  /** tmux's `TerminalStatus`, taken once at startup (daemon/start.ts) like its capability; null when unknown. */
  private tmuxStatus: TerminalStatus | null = null;
  /** The configured non-tmux terminal's status (herdr), cached for a few seconds; replaceable for tests. */
  private terminalStatusProbe: (config: TeamConfig) => TerminalStatus | null = cachedTerminalStatus();

  /** Record tmux's status (found once at startup). */
  setTmuxStatus(status: TerminalStatus | null): void {
    this.tmuxStatus = status;
  }

  /** Replace the non-tmux status probe (tests: a fake herdr's answer, or none). */
  setTerminalStatusProbe(probe: (config: TeamConfig) => TerminalStatus | null): void {
    this.terminalStatusProbe = probe;
  }

  /**
   * The *configured* terminal's status (daemon/terminal/backend.ts `TerminalStatus`):
   * backend, availability, version, server running, which server. On `/health`, so
   * `mpt doctor` can report the daemon's side and compare servers. Null when unknown
   * (tmux in a store nobody probed).
   */
  getTerminalStatus(): TerminalStatus | null {
    return resolveTerminal(this.config) === "tmux" ? this.tmuxStatus : this.terminalStatusProbe(this.config);
  }

  // --- Unmanaged windows (daemon/unmanaged-windows.ts) ---

  /**
   * Builds the configured terminal's backend for the unmanaged-window scan. Null
   * until the daemon enables it at startup (daemon/start.ts), so a Store in tests or
   * tools never reads the host's real tmux or herdr; tests inject a fake.
   */
  private windowBackend: ((config: TeamConfig) => TerminalBackend) | null = null;

  /** The scan's cache and the close action (reads the live members, config and directives). */
  private unmanagedWindows = new UnmanagedWindowTracker({
    backend: () => {
      if (!this.windowBackend || !this.getTerminalCapability().canSpawn) return null;
      try {
        return this.windowBackend(this.config);
      } catch {
        return null; // an unknown `terminal` value, say
      }
    },
    members: () => this.getMembers(),
    config: () => this.config,
    reserved: () => this.members.getReservedWindows(),
  });

  /** Enable the unmanaged-window scan with a backend factory (startup; tests pass a fake). */
  setWindowBackend(make: ((config: TeamConfig) => TerminalBackend) | null): void {
    this.windowBackend = make;
    this.unmanagedWindows.invalidate();
  }

  /**
   * Windows in the team's terminal container that MPT doesn't account for (no online
   * member, not the leader's, not a starting spawn). Cached for a few seconds
   * (UNMANAGED_SCAN_TTL_MS), so `GET /api/teammate-pool` polling never scans per request.
   */
  getUnmanagedWindows(): UnmanagedWindow[] {
    return this.unmanagedWindows.list();
  }

  /** Close one unmanaged window a human picked; refused unless a fresh scan still lists it. */
  closeUnmanagedWindow(window: string): CloseUnmanagedResult {
    return this.unmanagedWindows.close(window);
  }

  // --- Team readiness (see TeamReadiness) ---

  /** Record the team's readiness (the daemon's probe, or a harness's report). */
  setTeamReadiness(ready: boolean, reason?: string): void {
    this.teamReadiness = { ready, reason: ready ? undefined : reason, at: Date.now() };
  }

  /** The last-reported readiness, or undefined if nothing has reported yet. */
  getTeamReadiness(): TeamReadiness | undefined {
    return this.teamReadiness;
  }

  /** With no report yet, the team is treated as ready. */
  private isTeamReady(): boolean {
    return this.teamReadiness ? this.teamReadiness.ready : true;
  }

  /**
   * Should the cron scheduler enqueue right now?
   *
   * Gating exists so a machine that is connected but *unable* (e.g. expired
   * credentials) doesn't turn an overnight cron into a pile of FAILED runs. Two
   * conditions, both deliberate:
   *
   *   - **No agents online → allow.** That is not a readiness problem; the queue
   *     has always simply waited for an agent to connect. Readiness gating is
   *     about connected-but-unable, not absent.
   *   - **Otherwise → the team's last report**, defaulting to ready.
   *
   * This used to roll directory-affinity tiers up to the set of *hosts* that could
   * run an item and hold only when every one of them was not-ready. With one host
   * (P1c) readiness is a single team-level fact, so the rollup is gone — the
   * observable behaviour is unchanged, because the rollup always resolved to the
   * one host anyway.
   */
  private canScheduleNow(): boolean {
    const anyOnline = this.getMembers().some((m) => m.status !== "offline");
    if (!anyOnline) return true;
    return this.isTeamReady();
  }

  /**
   * Run the Schedule source's cron firing now (readiness hold/catch-up and
   * pending handling included). The logic lives in daemon/sources/schedule.ts;
   * this is the synchronous seam tests (and callers wanting "fire now") use.
   */
  runScheduler(now: Date = new Date()): void {
    const entry = this.sources.get(SCHEDULE_SOURCE_ID);
    entry?.source.tick?.(entry.ctx, now);
  }

  // --- Auto triage (daemon/store/triage.ts; TODO.md "Auto Triage") ---

  /** One triage pass over the notes; returns the items enqueued. */
  runTriageSweep(now: number = Date.now()): WorkItem[] { return this.triage.runTriageSweep(now); }

  /** **Triage now** for one note (skips the quiet period and "unchanged" rule). */
  triageNow(thoughtId: string): { ok: true; workItem: WorkItem } | { ok: false; error: string } { return this.triage.triageNow(thoughtId); }

  /** Why the sweep would skip this note right now (null = it's due). */
  triageStatusFor(thoughtId: string, now: number = Date.now()): TriageSkipReason | null { return this.triage.triageStatusFor(thoughtId, now); }

  /** A note's triage WorkDef, created on first use. */
  ensureTriageWorkDef(thoughtId: string): WorkDef | null { return this.triage.ensureTriageWorkDef(thoughtId); }

  /** The note-triage persona's body, or undefined when the team selected none. */
  getTriageInstructions(): string | undefined { return this.triage.getTriageInstructions(); }

  /** What a WorkDef is the triage subject of (a note's container or a triage-mode mirror), or null. */
  triageSubjectOf(workDefId: string): { kind: "thought"; thoughtId: string } | { kind: "mirror" } | null { return this.triage.triageSubjectOf(workDefId); }

  /** Is this a mirrored WorkDef in triage mode (from its source's kv on disk)? */
  isTriageModeMirror(def: Pick<WorkDef, "id" | "parent">): boolean { return this.triage.isTriageModeMirror(def); }

  /** Post one analysis on a note's triage thread (validated). */
  addTriageAnalysis(thoughtId: string, from: string, body: string, outcome: TriageOutcome, proposals?: TriageProposal[]): { ok: true } | { ok: false; error: string } {
    return this.triage.addTriageAnalysis(thoughtId, from, body, outcome, proposals);
  }

  /** Post one analysis on any triage subject's thread (the `propose_work` route). */
  addTriageAnalysisForWorkDef(workDefId: string, from: string, body: string, outcome: TriageOutcome, proposals?: TriageProposal[]): { ok: true } | { ok: false; error: string } {
    return this.triage.addTriageAnalysisForWorkDef(workDefId, from, body, outcome, proposals);
  }

  /** A triage subject's whole triage state (thread, proposals, badge). */
  getTriageThread(workDefId: string): TriageThread { return this.triage.getTriageThread(workDefId); }

  /** The badge for every note that has one, keyed by note id. */
  getTriageBadges(): Record<string, TriageBadge> { return this.triage.getTriageBadges(); }

  /** Accept a proposal: create the work it describes (never start it) and append the decision. */
  acceptProposal(workDefId: string, proposalId: string, opts: AcceptProposalOptions = {}, where = workDefId): ProposalResult {
    return this.triage.acceptProposal(workDefId, proposalId, opts, where);
  }

  /** Reject a proposal: one appended decision line. */
  rejectProposal(workDefId: string, proposalId: string, from = "you", where = workDefId): ProposalResult {
    return this.triage.rejectProposal(workDefId, proposalId, from, where);
  }

  /** Earlier proposals and what the author decided, for the next run's prompt. */
  triageDecisionSummary(workDefId: string): string[] { return this.triage.triageDecisionSummary(workDefId); }

  /** The team's triage persona: `triage.persona`, else `builtin:triage`. */
  resolveTriagePersona(): ResolvedPersona { return this.triage.resolveTriagePersona(); }

  commitToGit(message?: string): void {
    commitTeamDir(this.teamDir, this.config.autosave, message);
  }

  // --- Personas (daemon/store/personas.ts; docs/DESIGN.md "Personas: One Library, Selected by Reference") ---

  /** Personas shipped by plugin packages (fed by daemon/plugins/loader.ts at startup). */
  get packagePersonas(): PackagePersonas { return this.personas.packagePersonas; }

  /** Register a plugin package's personas, read-only, as `<name>/<id>` (the loader's seam). */
  registerPackagePersonas(pkg: { name: string; identity: string }, files: PackagePersonaFile[]): PackagePersonaResult {
    return this.personas.registerPackagePersonas(pkg, files);
  }

  /** The whole library: team personas, then built-ins, then package personas. */
  listPersonas(): Persona[] { return this.personas.listPersonas(); }

  /** One persona by id, whatever its origin, or null. */
  getPersona(id: string): Persona | null { return this.personas.getPersona(id); }

  /** Resolve a persona reference (a missing one logged once per id, then `opts.fallback`). */
  resolvePersona(ref: string | undefined | null, opts: { via: PersonaVia; fallback: BuiltinPersonaId | null }, where: string = opts.via): ResolvedPersona | null {
    return this.personas.resolvePersona(ref, opts, where);
  }

  /** Everything that references persona `id` (the "Used by" list). */
  getPersonaUsage(id: string): PersonaUsage[] { return this.personas.getPersonaUsage(id); }

  /** Create a team persona (`input.id`, else derived from the title). */
  createPersona(input: TeamPersonaInput & { id?: string }): { ok: true; persona: Persona } | { ok: false; status: 400 | 409; error: string } {
    return this.personas.createPersona(input);
  }

  /** Update a team persona in place; null when it doesn't exist. */
  updatePersona(id: string, updates: Partial<TeamPersonaInput>): Persona | null { return this.personas.updatePersona(id, updates); }

  /** Delete a team persona file (the route refuses one in use first). */
  deletePersona(id: string): boolean { return this.personas.deletePersona(id); }

  /** Copy any persona into the team library (`duplicatedFrom` records the source). */
  duplicatePersona(id: string, overrides: { id?: string; title?: string } = {}): { ok: true; persona: Persona } | { ok: false; status: 400 | 404 | 409; error: string } {
    return this.personas.duplicatePersona(id, overrides);
  }

  /** The persona body for a teammate state, or undefined when it names none. */
  getStatePersona(workflowName: string | undefined, state: string): string | undefined { return this.personas.getStatePersona(workflowName, state); }

  /** The resolved persona for a teammate state, or null when it names none. */
  resolveStatePersona(workflowName: string | undefined, state: string): ResolvedPersona | null { return this.personas.resolveStatePersona(workflowName, state); }

  /** Point a workflow teammate state at a persona (`null` clears it). */
  setStatePersona(workflowName: string, state: string, persona: string | null): { ok: true; workflow: WorkflowConfig } | { ok: false; status: 400 | 404; error: string } {
    return this.personas.setStatePersona(workflowName, state, persona);
  }

  /** The persona a run of `def` works with, resolved at claim; see `PersonaStore.resolveWorkPersona`. */
  resolveWorkPersona(def: WorkDef): ResolvedPersona | null { return this.personas.resolveWorkPersona(def); }

  /** A mirrored WorkDef's persona, by the Work Source chain. */
  resolveMirrorPersona(def: WorkDef): ResolvedPersona | null { return this.personas.resolveMirrorPersona(def); }

  /** Why this source is refused a sync (a triage-mode source without a triage persona), or null. */
  sourcePersonaProblem(sourceId: string): string | null { return this.personas.sourcePersonaProblem(sourceId); }

  /** A source's persona problem for its status (`GET /api/sources` `initError`), or null. */
  sourcePersonaStatus(sourceId: string): string | null { return this.personas.sourcePersonaStatus(sourceId); }

  /** Set a source's persona settings (`PUT /api/sources/:id/persona`). */
  setSourcePersona(sourceId: string, update: { persona?: string | null; triagePersona?: string | null }):
    { ok: true; setting: SourcePersonaSetting } | { ok: false; status: 400 | 404; error: string } {
    return this.personas.setSourcePersona(sourceId, update);
  }

  /** A person's persona override for a mirror, if any. */
  getMirrorPersonaOverride(def: Pick<WorkDef, "id" | "parent">): string | undefined { return this.personas.getMirrorPersonaOverride(def); }

  /** Set (or, with null, clear) a person's persona override on a mirror (`PUT /api/work-defs/:id/persona`). */
  setMirrorPersona(defId: string, persona: string | null): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string } {
    return this.personas.setMirrorPersona(defId, persona);
  }

  /** Startup: seed `sourcePersonas.<id>.triagePersona` for triage-mode plugin sources declaring none; returns the ids. */
  seedSourceTriagePersonas(): string[] { return this.personas.seedSourceTriagePersonas(); }

  /** Startup: warn (in their package's load status) about declared source personas that don't resolve. */
  checkDeclaredSourcePersonas(): void { this.pluginStatuses = this.personas.checkDeclaredSourcePersonas(this.pluginStatuses); }

  /** The assistant's selected persona id, or null for `builtin:assistant`. */
  getAssistantPersonaId(): string | null { return this.personas.getAssistantPersonaId(); }

  /** Select (or clear) the assistant's persona, persisted to config.json. */
  setAssistantPersonaId(id: string | null): void { this.personas.setAssistantPersonaId(id); }

  /** The assistant's resolved persona: its selection, or `builtin:assistant`. */
  resolveAssistantPersona(): ResolvedPersona { return this.personas.resolveAssistantPersona(); }

  // --- Assistant conversation (daemon/store/assistant-chat.ts) ---
  //
  // The daemon mirrors the agent's Pi session: user messages are queued for the
  // extension to hand to Pi, and the agent's own prose is mirrored back as
  // bubbles. There are no response turns and the composer never locks. See
  // docs/DESIGN.md "Assistant Chat Model". Messages are tagged with the
  // assistant's current persona (`getAssistantPersonaId`).

  /** Subscribe to chat events for the SSE stream. Returns an unsubscribe fn. */
  subscribeAssistantEvents(fn: (event: AssistantEvent) => void): () => void { return this.chat.subscribe(fn); }

  /** Messages for one session (defaults to the active session), oldest first. */
  getAssistantMessages(sessionId?: string): AssistantMessage[] { return this.chat.getMessages(sessionId); }

  /** When the user first wrote to the assistant (ISO), or null — the onboarding checklist. */
  getFirstUserMessageAt(): string | null { return this.chat.firstUserMessageAt(); }

  /** One chat message, or null. */
  getAssistantMessage(id: string): AssistantMessage | null { return this.chat.getMessage(id); }

  /** Append a user message (always succeeds; creates the active session on demand). */
  appendUserMessage(
    content: string,
    opts: { replyTo?: string | null; origin?: AssistantOrigin; mode?: AssistantSendMode | null } = {},
  ): AssistantMessage {
    return this.chat.appendUserMessage(content, {
      personaId: this.getAssistantPersonaId(),
      replyTo: opts.replyTo ?? null,
      origin: opts.origin,
      mode: opts.mode ?? null,
    });
  }

  /** Mirror one bubble of the agent's reply into the chat. */
  appendAssistantMessage(content: string, failed = false): AssistantMessage {
    return this.chat.appendAssistantBubble(content, { personaId: this.getAssistantPersonaId(), failed });
  }

  /** Delete one chat message; false when it doesn't exist. */
  deleteAssistantMessage(id: string): boolean { return this.chat.deleteMessage(id); }

  /** User messages not yet handed to Pi, oldest first (agent-facing). */
  getAssistantInbox(): InboxMessage[] { return this.chat.getInbox(); }

  /** Advance delivery receipts (queued -> delivered -> read). */
  ackAssistantInbox(ids: string[], state: AssistantDelivery): number { return this.chat.ackInbox(ids, state); }

  /** Mark everything already handed to Pi as read (a run just started). */
  markAssistantDeliveredAsRead(): number { return this.chat.markDeliveredAsRead(); }

  /** Set the ephemeral "thinking" flag (the reasoning peek buffer). */
  setAssistantThinking(active: boolean): void { this.chat.setThinking(active); }

  /** Append a reasoning chunk to the ephemeral peek buffer. */
  appendAssistantThought(chunk: string): void { this.chat.appendThought(chunk); }

  /** Clear the reasoning peek buffer. */
  clearAssistantThoughts(): void { this.chat.clearThoughts(); }

  /** The reasoning peek buffer and whether the assistant is thinking. */
  getAssistantThoughts(): { chunks: string[]; updatedAt: string | null; thinking: boolean } { return this.chat.getThoughts(); }

  /** Is the assistant thinking right now? */
  isAssistantThinking(): boolean { return this.chat.isThinking(); }

  /** The active chat session, or null. */
  getActiveAssistantSession(): AssistantSession | null { return this.chat.getActiveSession(); }

  /** One chat session, or null. */
  getAssistantSession(id: string): AssistantSession | null { return this.chat.getSession(id); }

  /** Every chat session. */
  listAssistantSessions(): AssistantSession[] { return this.chat.listSessions(); }

  /** A session's markdown transcript, or null. */
  getAssistantSessionSnapshot(id: string): string | null { return this.chat.getSnapshot(id); }

  /** Record the Pi session file backing the active chat (enables resume). */
  reportAssistantPiSession(piSessionPath: string): AssistantSession {
    return this.chat.reportPiSession(piSessionPath, this.getAssistantPersonaId());
  }

  /**
   * Start a fresh chat: snapshot + end the active session, open a new one, and
   * ask the assistant to roll its Pi session so in-agent context matches.
   */
  newAssistantSession(notice?: string): AssistantSession {
    const session = this.chat.newSession(this.getAssistantPersonaId(), notice);
    this.directAssistantSession("new-session", {});
    return session;
  }

  /**
   * Resume an earlier session: snapshot + end the active one, reopen the target,
   * and ask the assistant to switch its Pi session to the recorded file.
   */
  resumeAssistantSession(id: string): AssistantSession | null {
    const target = this.chat.getSession(id);
    if (!target) return null;
    const session = this.chat.resumeSession(id);
    this.directAssistantSession("resume-session", { piSessionPath: target.piSessionPath, sessionId: id });
    return session;
  }

  /** Refresh the active session's snapshot when stale (periodic safety net). */
  refreshAssistantSnapshot(force = false): void { this.chat.refreshActiveSnapshot(force); }

  /**
   * Ask any online assistant to act on its Pi session. The daemon expresses
   * intent (`new-session`, `resume-session`) and never the mechanism — the
   * extension realizes it with `ctx.newSession()` / `ctx.switchSession()`
   * (docs/DESIGN.md "Assistant Chat Model"). A teammate's reset takes the same
   * path (`resetMemberSession`).
   */
  private directAssistantSession(action: string, params: Record<string, unknown>): void {
    const agent = this.getLeader();
    if (agent) this.createLeaderDirectiveForMember(agent.id, action, params);
  }

  // --- Settings (simple daemon-wide key/value) ---

  /** A daemon-wide setting's value, or null. */
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Set (or, with null, delete) a daemon-wide setting. */
  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // --- The leader, leader directives, the teammate pool (daemon/store/members.ts) ---

  /** The online leader, which is the agent that answers the chat. */
  getLeader(): Member | null { return this.members.getLeader(); }

  /** True when `agentId` is the leader — only it may drain the chat inbox. */
  isLeader(agentId: string): boolean { return this.members.isLeader(agentId); }

  /** Create a leader directive (a `spawn` gets a generated `params.name` unless one was supplied). */
  createLeaderDirective(action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): LeaderDirective {
    return this.members.createLeaderDirective(action, opts);
  }

  /** Create a directive targeting an existing member. Null if the member is unknown. */
  createLeaderDirectiveForMember(memberId: string, action: string, params?: Record<string, unknown>): LeaderDirective | null {
    return this.members.createLeaderDirectiveForMember(memberId, action, params);
  }

  /** Ask an agent for a fresh session (Team-tab Reset); goes to the agent itself when it can take it. Null if unknown. */
  resetMemberSession(memberId: string): LeaderDirective | null { return this.members.resetMemberSession(memberId); }

  /** Pending directives for the leader, oldest first (self-handled actions excluded). */
  getLeaderDirectives(): LeaderDirective[] { return this.members.getLeaderDirectives(); }

  /** Pending directives an agent must realize itself, oldest first. */
  getMemberDirectives(memberId: string): LeaderDirective[] { return this.members.getMemberDirectives(memberId); }

  /** All pending `spawn` directives, oldest first. */
  getPendingSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; createdAt: string }> {
    return this.members.getPendingSpawnRequests();
  }

  /** One directive by id, or null. */
  getLeaderDirective(id: string): LeaderDirective | null { return this.members.getLeaderDirective(id); }

  /** Update a directive's status (e.g. 'done'). Returns false if not found. */
  updateLeaderDirective(id: string, status: string, error?: string): boolean { return this.members.updateLeaderDirective(id, status, error); }

  /** Spawn directives that failed, newest first, with the reason. */
  getFailedSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; error: string | null; at: string }> {
    return this.members.getFailedSpawnRequests();
  }

  /** The pool's live state: what's declared, what's online, what's inbound. */
  getTeammatePool(): TeammatePoolState { return this.members.getTeammatePool(); }

  /** Declare the pool's minimum size (persisted, then reconciled); null for an invalid `n`. */
  setMinTeammates(n: number | null): number | null { return this.members.setMinTeammates(n); }

  /** Top the teammate pool back up to `minTeammates`; returns how many spawns were queued. */
  reconcileTeammatePool(): number { return this.members.reconcileTeammatePool(); }

  /**
   * Persist the in-memory config to `config.json` (`saveTeamConfig`, which writes
   * every key but the derived ones). The daemon's single writer, so no caller can
   * accidentally drop a field it didn't know about.
   */
  saveConfig(): void {
    saveTeamConfig(this.teamDir, this.config);
  }

  // --- Directory suggestions (docs/DESIGN.md "Favorite Directories") ---

  /** The favorite directories, in the user's order (normalized; see TeamConfig). */
  getFavoriteDirectories(): string[] {
    return [...(this.config.favoriteDirectories ?? [])];
  }

  /**
   * Replace the favorites list. Each entry is normalized the same way stored
   * directories are (`normalizeDirectory`), so a favorite matches the paths
   * agents register with; empties and duplicates (after normalization) are
   * dropped, first occurrence wins. Persists and returns the stored list.
   */
  setFavoriteDirectories(dirs: string[]): string[] {
    const out: string[] = [];
    for (const raw of dirs) {
      const dir = normalizeDirectory(raw.trim());
      if (dir && !out.includes(dir)) out.push(dir);
    }
    if (out.length > 0) this.config.favoriteDirectories = out;
    else delete this.config.favoriteDirectories;
    this.saveConfig();
    return out;
  }

  /** Append one favorite (no-op if already present). Returns the stored list. */
  addFavoriteDirectory(dir: string): string[] {
    return this.setFavoriteDirectories([...this.getFavoriteDirectories(), dir]);
  }

  /**
   * Remove one favorite. The argument is normalized first, so `~/repo` removes
   * the stored `/home/u/repo`. Returns false if it wasn't a favorite.
   */
  removeFavoriteDirectory(dir: string): boolean {
    const target = normalizeDirectory(dir.trim());
    const current = this.getFavoriteDirectories();
    if (!current.includes(target)) return false;
    this.setFavoriteDirectories(current.filter((d) => d !== target));
    return true;
  }

  /**
   * Recently used working directories, most recent first: where teammates are
   * homed right now, then the directories of recently enqueued WorkItems, then
   * story directories. Derived from existing state rather than tracked
   * separately, so it can never drift. Normalized, deduped, favorites excluded
   * (pickers list those first anyway), capped at `limit`.
   */
  getRecentDirectories(limit = 20): string[] {
    const favorites = new Set(this.getFavoriteDirectories());
    const out: string[] = [];
    const add = (d: string | null | undefined) => {
      if (!d || out.length >= limit) return;
      const n = normalizeDirectory(d);
      if (n && !favorites.has(n) && !out.includes(n)) out.push(n);
    };
    for (const m of this.getMembers()) if (m.status !== "offline") add(m.directory);
    const rows = this.db.prepare(
      `SELECT directory, MAX(enqueued_at) AS last FROM work_items
       WHERE directory IS NOT NULL AND directory != ''
       GROUP BY directory ORDER BY last DESC LIMIT ?`,
    ).all(limit) as Array<{ directory: string }>;
    for (const r of rows) add(r.directory);
    for (const s of this.getStories()) add(s.directory);
    return out;
  }

  // --- WorkDefs + Schedules (see store/workdefs.ts, store/schedules.ts) ---

  getWorkDefs(status?: string): WorkDef[] {
    let all = listWorkDefs(this.teamDir);
    if (status === "active" || status === "archived") all = all.filter((d) => (d.status || "active") === status);
    return all;
  }

  getWorkDef(id: string): WorkDef | null {
    return getWorkDef(this.teamDir, id);
  }

  /** Is there a WorkDef matching `pred`? Stops at the first match (store/workdefs.ts `someWorkDef`). */
  hasWorkDef(pred: (def: WorkDef) => boolean): boolean {
    return someWorkDef(this.teamDir, pred);
  }

  /**
   * Create a WorkDef; when `enqueue` (default), also enqueue a READY WorkItem.
   * A `pending` one is never enqueued, whatever `enqueue` says.
   */
  createWorkDef(input: {
    title: string; parent?: WorkDefParent; goal: string; acceptanceCriteria: string;
    additionalContext?: string; directory?: string; origin?: WorkDefOrigin;
    pending?: boolean; persona?: string;
  }, enqueue = true): WorkDef {
    const def = saveWorkDef(this.teamDir, {
      ...input,
      directory: input.directory ? normalizeDirectory(input.directory) : undefined,
    });
    if (enqueue && !def.pending) this.enqueueWorkDef(def.id);
    return def;
  }

  /** True when the WorkDef exists and is still pending (editable, never dispatched). */
  isPending(id: string): boolean {
    return getWorkDef(this.teamDir, id)?.pending === true;
  }

  /**
   * Activate a pending WorkDef: clear the flag (locking the definition) and hand it
   * to its parent's normal enqueue rule (docs/DESIGN.md "Pending: Write, Review, Activate"):
   *   - Board: if the task already sits in a teammate state it gets its WorkItem now;
   *     otherwise admission runs, so a pending task that was holding the story's next
   *     slot is admitted.
   *   - Solitary: enqueued, as creating it would have done, unless `enqueue` is false.
   *   - Scheduled: nothing now; its next cron firing enqueues it.
   * Returns null for an unknown id; `error` when it isn't pending.
   */
  activateWorkDef(id: string, opts: { enqueue?: boolean } = {}): { def: WorkDef; workItem: WorkItem | null } | { error: string } | null {
    const existing = getWorkDef(this.teamDir, id);
    if (!existing) return null;
    if (!existing.pending) return { error: `WorkDef "${id}" is already active` };
    const def = updateWorkDef(this.teamDir, id, { pending: false })!;
    // Its source decides (hook: onActivate; a board task enqueues or runs
    // admission, Solitary enqueues, Scheduled waits for its cron). No hook = nothing now.
    const src = this.sources.forWorkDef(def);
    const workItem = src?.source.onActivate?.(def, opts, src.ctx) ?? null;
    return { def, workItem };
  }

  /**
   * The claim prompt for a WorkDef, given the daemon's kind-free `base`: its
   * source's `buildPrompt` contribution (Story: persona + story; Thought: the
   * triage prompt), or `base` without one. A triage-mode mirror gets the triage
   * prompt instead of its source's (docs/DESIGN.md "External sources" — "Triage mode"),
   * with `persona` — the claim's resolved persona — as its instructions.
   */
  buildPromptFor(def: WorkDef, base: string, persona?: ResolvedPersona | null): string {
    // A triage-mode mirror's prompt carries its triage persona (the one the claim resolved and recorded).
    if (this.isTriageModeMirror(def)) return this.externalTriage.buildPrompt(def, (persona ?? this.resolveMirrorPersona(def))?.body);
    const src = this.sources.forWorkDef(def);
    return src?.source.buildPrompt ? src.source.buildPrompt(def, base, src.ctx) : base;
  }

  /**
   * **Run** a WorkDef (`POST /api/work-defs/:id/enqueue`): its source's `run`
   * rule (Triage: Triage now; a triage-mode mirror: Triage now), or the Solitary rule — refuse a pending or
   * in-flight def, else enqueue — for a kind without one.
   */
  runWorkDef(id: string): RunResult {
    const def = this.getWorkDef(id);
    if (!def) return { ok: false, error: "Unknown WorkDef, or one is already in flight" };
    const src = this.sources.forWorkDef(def);
    // A triage-mode mirror: Run = Triage now (force the current revision).
    if (this.isTriageModeMirror(def)) {
      // No triage persona, no triage run (docs/DESIGN.md "Work Source personas").
      if (!this.personas.mirrorHasTriagePersona(def)) {
        return { ok: false, conflict: true, error: this.sourcePersonaProblem(sourceIdForWorkDef(def)) ?? heldTriageItemsMessage(sourceIdForWorkDef(def), 1) };
      }
      return this.externalTriage.run(def, src?.ctx ?? this.makeSourceContext(sourceIdForWorkDef(def)));
    }
    if (src?.source.run) return src.source.run(def, src.ctx);
    return runSolitary(def, src?.ctx ?? this.makeSourceContext(sourceIdForWorkDef(def)));
  }

  updateWorkDefDetails(id: string, updates: {
    title?: string; parent?: WorkDefParent | null; goal?: string; acceptanceCriteria?: string;
    additionalContext?: string | null; directory?: string | null; persona?: string | null;
  }): WorkDef | null {
    const def = updateWorkDef(this.teamDir, id, {
      ...updates,
      directory: updates.directory !== undefined ? (updates.directory ? normalizeDirectory(updates.directory) : null) : undefined,
    });
    // A board task is a WorkDef whose fields are cached in the `tasks` table
    // (what /api/stories reads). Keep that cache in sync so an edit through the
    // WorkDef path is reflected on the board without waiting for a reload.
    if (def) this.board.refreshTaskCache(def);
    return def;
  }

  deleteWorkDef(id: string): boolean {
    // Cancel any active WorkItem for this def, then remove it from disk.
    const active = this.getActiveWorkItem(id);
    if (active) {
      this.setWorkItemStateRow(active.id, "CANCELED");
      this.notifyItemTerminal(active.id);
    }
    return deleteWorkDef(this.teamDir, id);
  }

  /** Archive a WorkDef (mark it archived so it no longer appears in active lists). */
  archiveWorkDef(id: string): WorkDef | null {
    return updateWorkDef(this.teamDir, id, { status: "archived" });
  }

  /** Restore an archived WorkDef back to active status. */
  restoreWorkDef(id: string): WorkDef | null {
    return updateWorkDef(this.teamDir, id, { status: "active" });
  }

  /** Enqueue a READY WorkItem for a WorkDef (unless one is already active). */
  enqueueWorkDef(id: string): WorkItem | null {
    if (this.getActiveWorkItem(id)) return null;
    return this.enqueueFor(id);
  }

  // Schedules (cron parents that own WorkDefs via parent = {kind:schedule,id}).
  getSchedules(): Schedule[] { return listSchedules(this.teamDir); }
  getSchedule(id: string): Schedule | null { return getSchedule(this.teamDir, id); }
  createSchedule(input: { id?: string; title?: string; cron: string; pending?: boolean }): Schedule { return saveSchedule(this.teamDir, input); }
  /** Edit a Schedule's title/cron and/or toggle its reversible `pending` (see store/schedules.ts updateSchedule). */
  updateScheduleDetails(id: string, updates: { title?: string | null; cron?: string; pending?: boolean }): Schedule | null { return updateSchedule(this.teamDir, id, updates); }
  /**
   * Make a Schedule pending (it stops firing) or active again (it resumes at its
   * next cron occurrence, with no catch-up). Returns the updated Schedule, or
   * null if it doesn't exist. See docs/DESIGN.md "Pending schedules: reversible,
   * no catch-up". `now` is the activation time recorded as `resumedAt` (tests pin it).
   */
  setSchedulePending(id: string, pending: boolean, now: Date = new Date()): Schedule | null { return updateSchedule(this.teamDir, id, { pending }, now); }
  deleteSchedule(id: string): boolean {
    // Orphan its children (drop their parent) so they don't dangle a ref.
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind === "schedule" && def.parent.id === id) updateWorkDef(this.teamDir, def.id, { parent: null });
    }
    return deleteSchedule(this.teamDir, id);
  }

  // ─── Task Templates (molds for Solitary tasks; see store/templates.ts) ──
  //
  // A Template is a parent-less, runtime-less WorkDef used only to pre-fill a
  // new Solitary task. It never enqueues and is stored separately from work so
  // it never enters the WorkItem queue. Files are the source of truth
  // (templates/<id>/template.md), like Schedules — no SQLite index.

  getTemplates(): Template[] { return listTemplates(this.teamDir); }
  getTemplate(id: string): Template | null { return getTemplate(this.teamDir, id); }
  createTemplate(input: {
    title: string; goal: string; acceptanceCriteria: string;
    additionalContext?: string; directory?: string;
  }): Template {
    return saveTemplate(this.teamDir, {
      ...input,
      directory: input.directory ? normalizeDirectory(input.directory) : undefined,
    });
  }
  updateTemplateDetails(id: string, updates: {
    title?: string; goal?: string; acceptanceCriteria?: string;
    additionalContext?: string | null; directory?: string | null;
  }): Template | null {
    return updateTemplate(this.teamDir, id, {
      ...updates,
      directory: updates.directory !== undefined ? (updates.directory ? normalizeDirectory(updates.directory) : null) : undefined,
    });
  }
  deleteTemplate(id: string): boolean { return deleteTemplate(this.teamDir, id); }

  // --- Thoughts (markdown sticky notes; daemon/store/thoughts.ts `ThoughtStore`) ---
  //
  // Files are the source of truth (thoughts/<id>.md + groups.json) — no SQLite
  // index. See docs/ARCHITECTURE.md "Thoughts".

  /** All thoughts, optionally filtered by status; sorted by zIndex then id. */
  getThoughts(status?: string): Thought[] { return this.notes.getThoughts(status); }

  /** One note, or null. */
  getThought(id: string): Thought | null { return this.notes.getThought(id); }

  /** Every group. */
  getThoughtGroups(): ThoughtGroup[] { return this.notes.getThoughtGroups(); }

  /** One group, or null. */
  getThoughtGroup(id: string): ThoughtGroup | null { return this.notes.getThoughtGroup(id); }

  /** Create a note (auto-placed when no x/y). */
  createThought(input: Parameters<ThoughtStore["createThought"]>[0]): Thought { return this.notes.createThought(input); }

  /** Partial update; only a content change bumps `updatedAt`. */
  updateThought(id: string, updates: Parameters<ThoughtStore["updateThought"]>[1]): Thought | null { return this.notes.updateThought(id, updates); }

  /** Batch position/size update (one drag gesture). */
  updateThoughtPositions(moves: Parameters<ThoughtStore["updateThoughtPositions"]>[0]): Thought[] { return this.notes.updateThoughtPositions(moves); }

  /** Archive a note; its triage WorkDef follows, and a queued run is canceled. */
  archiveThought(id: string): Thought | null { return this.notes.archiveThought(id); }

  /** Restore a note; its triage WorkDef comes back with it. */
  restoreThought(id: string): Thought | null { return this.notes.restoreThought(id); }

  /** Hard delete, taking the note's triage WorkDef (thread included) with it. */
  deleteThought(id: string): boolean { return this.notes.deleteThought(id); }

  /** Create a group (stamping membership on `memberIds`). */
  createThoughtGroup(input: Parameters<ThoughtStore["createThoughtGroup"]>[0]): ThoughtGroup { return this.notes.createThoughtGroup(input); }

  /** Partial update of a group. */
  updateThoughtGroup(id: string, updates: Parameters<ThoughtStore["updateThoughtGroup"]>[1]): ThoughtGroup | null { return this.notes.updateThoughtGroup(id, updates); }

  /** Ungroup: remove the group and clear its members' groupId. */
  deleteThoughtGroup(id: string): boolean { return this.notes.deleteThoughtGroup(id); }

  // --- Ref-based comments/attachments (daemon/store/threads.ts) ---
  //
  // Comments live on the *ref* — i.e. the WorkDef directory (`tasks/<id>/`),
  // uniformly for board tasks and standalone work. Agents post via a WorkItem
  // id, resolved to its ref. See docs/DESIGN.md "WorkDefs & Parents".

  /** A ref's comments (triage decision lines filtered out); see `ThreadStore.getCommentsForRef`. */
  getCommentsForRef(ref: WorkItemRef): Comment[] { return this.threads.getCommentsForRef(ref); }

  /** Every line of a ref's thread, comments and triage decisions alike, in order. */
  getThreadEntries(ref: WorkItemRef): ThreadEntry[] { return this.threads.getThreadEntries(ref); }

  /** Append one raw line to a ref's thread (no onComment hook). */
  private appendThreadEntry(ref: WorkItemRef, entry: ThreadEntry): boolean { return this.threads.appendThreadEntry(ref, entry); }

  /** Append a comment to a ref's thread and tell its source (hook: onComment). */
  addCommentForRef(ref: WorkItemRef, from: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): void {
    this.threads.addCommentForRef(ref, from, body, attachments);
  }

  /** Store an upload under a ref's `attachments/`; returns its stored name, or null for an unknown ref. */
  saveAttachmentForRef(ref: WorkItemRef, filename: string, data: Uint8Array | string): string | null {
    return this.threads.saveAttachmentForRef(ref, filename, data);
  }

  /** List a ref's attachments, newest first (works for any WorkDef). */
  getAttachmentsForRef(ref: WorkItemRef): AttachmentInfo[] { return this.threads.getAttachmentsForRef(ref); }

  /** Resolve a ref attachment's file path (or null if missing / out of bounds). */
  getAttachmentPathForRef(ref: WorkItemRef, filename: string): string | null { return this.threads.getAttachmentPathForRef(ref, filename); }

  /** Delete a ref attachment. Returns false if it doesn't exist. */
  deleteAttachmentForRef(ref: WorkItemRef, storedName: string): boolean { return this.threads.deleteAttachmentForRef(ref, storedName); }

  // --- Notices (one-line, dismissable; carried by /api/status) ---

  /**
   * The current notices, for `/api/status`. Today the only one is the line
   * 0.34–0.36's persona migration left in the settings table when it archived a
   * context library (`CONTEXT_NOTICE_KEY`); it stays until dismissed.
   */
  getNotices(): Array<{ id: string; message: string }> {
    const message = this.getSetting(CONTEXT_NOTICE_KEY);
    return message ? [{ id: "context-library-removed", message }] : [];
  }

  /** Dismiss a notice. False when there is no such notice. */
  dismissNotice(id: string): boolean {
    if (id !== "context-library-removed" || this.getSetting(CONTEXT_NOTICE_KEY) === null) return false;
    this.setSetting(CONTEXT_NOTICE_KEY, null);
    return true;
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    // A sync still in flight must not write to a closed DB when it resolves.
    this.syncRunner.stop();
    // Snapshot the live chat on the way out so the transcript is on disk.
    this.refreshAssistantSnapshot(true);
    if (this.config.autosave.autoCommit) {
      this.commitToGit("pi-pizza-team: shutdown checkpoint");
    }
    this.db.close();
  }
}

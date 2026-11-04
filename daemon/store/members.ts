/**
 * daemon/store/members.ts — Members, dismissals, leader directives, and the
 * teammate pool.
 *
 * The connected agents' side of the Store (docs/DESIGN.md "Reaping", "Team
 * Size", "One Agent to Talk To"):
 *   - members: register, heartbeat (a reaped agent coming back restores its
 *     MORIBUND items), list, remove, and the in-memory session stats;
 *   - dismissals: the in-memory tombstones that make a dismissed agent's next
 *     heartbeat answer `dismissed`, and the "it has gone" signals the spawner
 *     waits on before closing its tmux window;
 *   - the reaper (`reapOfflineAgents`);
 *   - leader directives (the daemon spawner's queue — despite the name, no
 *     leader realizes them any more), with daemon-assigned spawn names, and
 *     whether this daemon can realize spawns at all (a spawn it can't is failed
 *     on creation);
 *   - agent self-directives (`new-session`, `resume-session`), including a
 *     teammate reset (`resetMemberSession`), which the target agent realizes;
 *   - the teammate pool (`minTeammates`) and its reconciler.
 *
 * The Store delegates its member methods here one line each. What this needs
 * from the queue and the rest of the Store comes in as `MemberStoreDeps`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  generateTeammateName,
  resolveMinTeammates,
  type Member,
  type MemberSessionStats,
  type TeamConfig,
  type WorkItemState,
} from "../../shared/types.ts";
import { normalizeDirectory } from "../../shared/directory.ts";
import { capabilityError, harnessCapability, type SpawnCapability } from "../spawner.ts";
import { assistantStartability, type AssistantStartability } from "../leader-start.ts";
import type { StoreDomainContext } from "./domain.ts";

/** How long after hearing `dismissed` an agent is assumed to have exited. */
export const DISMISS_EXIT_GRACE_MS = 3_000;

/**
 * Directive actions an agent realizes itself rather than via its host leader.
 * These need in-process Pi APIs (session replacement), which tmux keystrokes
 * cannot express. See docs/DESIGN.md "Assistant Chat Model".
 */
export const SELF_HANDLED_ACTIONS = new Set(["new-session", "resume-session"]);

/**
 * Reserved singleton identity for the leader: the agent that realizes directives
 * (spawning windows, resetting sessions) *and* answers the chat. Matched by name
 * so a leader is never mistaken for a pool teammate.
 *
 * There is no separate "assistant" agent: the leader's session holds no human work
 * (nobody types in it) and chat v2's mirror is role-agnostic, so the leader is the
 * chat participant. See DESIGN.md "One Agent to Talk To". This replaced a second
 * constant, CHAT_ROLE_NAME, that held the same value for the same reason.
 */
export const LEADER_MEMBER_NAME = "leader";

/**
 * Is this member part of the generalist teammate **pool** (the thing
 * `minTeammates` sizes)? Roles are a name convention: the leader is a singleton
 * with a reserved name; everything else is a teammate.
 */
export function isPoolTeammate(name: string): boolean {
  const n = name.toLowerCase();
  return !n.includes(LEADER_MEMBER_NAME);
}

/** A leader directive, resolved with its target member's metadata. */
export interface LeaderDirective {
  id: string;
  action: string;
  memberId?: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  createdAt: string;
}

/** The pool's live state (`GET /api/teammate-pool`). */
export interface TeammatePoolState {
  minTeammates: number;
  isDefault: boolean;
  maxTeammates: number;
  online: number;
  pending: number;
  leaderPresent: boolean;
  /**
   * Why the daemon can't spawn the pool's teammates (tmux unreachable, or the
   * default harness isn't spawnable), or null when it can. While set, the
   * reconciler queues nothing — a spawn nobody can realize would only pile up.
   */
  spawnBlocked: { reason: string; fix: string } | null;
  /**
   * Can the assistant (the leader) be started from the web UI
   * (`POST /api/assistant/start`)? `{ ok: true }`, or why not and the fix — tmux
   * unreachable, or no usable leader template for the default harness.
   */
  assistantStartable: AssistantStartability;
}

/** What the member domain needs from the rest of the Store. */
export interface MemberStoreDeps {
  /** Move a WorkItem row to `state` — the queue's bare transition (no source hooks). */
  setWorkItemStateRow(id: string, state: WorkItemState): void;
  /** Drop a removed member's in-memory live state (watch transcripts, pairing). */
  forgetLiveState(memberId: string): void;
  /** Persist the live config to config.json (the Store's single writer). */
  saveConfig(): void;
}

export class MemberStore {
  private db: DatabaseSync;
  private config: TeamConfig;
  private deps: MemberStoreDeps;
  /**
   * Each live agent's session stats (context fill, session cost), as last
   * reported. In memory only, like readiness: it describes a running process,
   * and a restarted daemon hears again after the agent's next turn.
   */
  private sessionStats = new Map<string, MemberSessionStats>();
  /**
   * Ids explicitly dismissed by a human (tombstones). A dismissed id's next
   * heartbeat is told to shut down; an unknown-but-not-dismissed id is told to
   * re-register. In-memory only — a daemon restart clears it (and also wipes
   * members), so after a restart every agent simply re-registers.
   */
  private dismissedIds: Set<string> = new Set();
  /**
   * When each tombstoned agent was dismissed, was told so by a heartbeat, and
   * deregistered — the signals the spawner waits on before closing its tmux window
   * (daemon/spawner.ts realizeDismiss). In-memory for the same reason as
   * `dismissedIds`; after a restart the dismiss directive's grace deadline still
   * closes the window.
   */
  private dismissals = new Map<string, { toldAt: number | null; exited: boolean }>();
  /**
   * Can this daemon process reach tmux (daemon/spawner.ts probeTmuxCapability)?
   * Probed once at startup, before the server listens (daemon/start.ts); a store
   * nobody probed (tests, tools) assumes it can.
   */
  private tmuxCapability: SpawnCapability = { canSpawn: true };

  constructor(ctx: StoreDomainContext, deps: MemberStoreDeps) {
    this.db = ctx.db;
    this.config = ctx.config;
    this.deps = deps;
  }

  // --- Members ---

  /**
   * Register (or re-register) an agent. Clears any dismiss tombstone and session
   * stats for the id; a leader arriving reconciles the teammate pool.
   */
  registerMember(
    id: string,
    name: string,
    directory?: string,
    metadata: Record<string, unknown> = {},
    handshake?: { protocolVersion?: number; harness?: string; harnessVersion?: string },
  ): void {
    // (Re)registering clears any dismiss tombstone for this id.
    this.dismissedIds.delete(id);
    this.dismissals.delete(id);
    // …and any session stats: a registration is a fresh harness session.
    this.sessionStats.delete(id);
    this.db.prepare(
      `INSERT OR REPLACE INTO members (id, name, directory, metadata, protocol_version, harness, harness_version, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?)`
    ).run(
      id,
      name,
      directory ? normalizeDirectory(directory) : null,
      JSON.stringify(metadata || {}),
      handshake?.protocolVersion ?? null,
      handshake?.harness || null,
      handshake?.harnessVersion || null,
      Date.now(),
    );

    // A leader arriving (daemon start, host reconnect) is the first moment a
    // pool spawn can actually be realized — fill the pool now instead of waiting
    // for the next heartbeat tick.
    if (name.toLowerCase().includes(LEADER_MEMBER_NAME)) this.reconcileTeammatePool();
  }

  /** Set a member's status (and refresh its heartbeat time). */
  updateMemberStatus(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  /**
   * Record a heartbeat. A previously-reaped agent coming back restores its
   * MORIBUND WorkItems to IN_PROGRESS — it was alive after all (see
   * docs/DESIGN.md "Reaping").
   */
  heartbeat(id: string, status: string): void {
    const prev = this.getMember(id);
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
    if (prev && prev.status === "offline" && status !== "offline") {
      const rows = this.db.prepare("SELECT id FROM work_items WHERE member_id = ? AND state = 'MORIBUND'").all(id) as Array<Record<string, unknown>>;
      for (const row of rows) this.deps.setWorkItemStateRow(row.id as string, "IN_PROGRESS");
    }
  }

  private rowToMember(row: Record<string, unknown>): Member {
    return {
      id: row.id as string,
      name: row.name as string,
      directory: (row.directory as string) || undefined,
      metadata: row.metadata && (row.metadata as string) !== "{}" ? JSON.parse(row.metadata as string) : {},
      protocolVersion: (row.protocol_version as number) ?? undefined,
      harness: (row.harness as string) || undefined,
      harnessVersion: (row.harness_version as string) || undefined,
      status: row.status as Member["status"],
      lastHeartbeat: row.last_heartbeat as number,
    };
  }

  /** Every registered member, by name. */
  getMembers(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY name").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMember(row));
  }

  /** One member, or null when the id isn't registered. */
  getMember(id: string): Member | null {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMember(row);
  }

  /**
   * Remove a member (a self-deregister, or via `dismissMember`). Its in-flight
   * WorkItems go to MORIBUND first — the reaper's transition (`markInFlightMoribund`)
   * — since the reaper only walks members and would never see them once the
   * member is gone (docs/DESIGN.md "Reaping"). A human then force-fails them.
   */
  removeMember(id: string): void {
    this.markInFlightMoribund(id);
    this.db.prepare("DELETE FROM assignments WHERE member_id = ?").run(id);
    this.db.prepare("UPDATE work_items SET member_id = NULL WHERE member_id = ?").run(id);
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
    this.deps.forgetLiveState(id);
    this.sessionStats.delete(id);
  }

  /** Record an agent's session stats (context fill, session cost); stamps `at`. */
  setMemberSessionStats(id: string, stats: Omit<MemberSessionStats, "at">): void {
    this.sessionStats.set(id, { ...stats, at: Date.now() });
  }

  /** An agent's last-reported session stats, if it has reported any this session. */
  getMemberSessionStats(id: string): MemberSessionStats | undefined {
    return this.sessionStats.get(id);
  }

  // --- Dismissals (tombstones) ---

  /**
   * Explicitly dismiss a member (a human clicked "dismiss"): remove it AND leave
   * an in-memory tombstone so its next heartbeat is told `dismissed` (shut down),
   * not `reregister`. This is the ONLY path that makes an agent exit — a mere
   * unknown member (e.g. after a daemon restart wiped the members table) gets
   * `reregister` instead, so restarts/upgrades don't kill running teammates.
   */
  dismissMember(id: string): void {
    // An agent already offline (crashed, wedged) will never heartbeat again, so
    // there is nothing to wait for before closing its window.
    const offline = this.getMember(id)?.status === "offline";
    this.dismissedIds.add(id);
    this.dismissals.set(id, { toldAt: null, exited: offline });
    this.removeMember(id);
  }

  /** A dismissed agent's heartbeat was just answered `dismissed`; it is now exiting. */
  noteDismissedHeartbeat(id: string): void {
    const d = this.dismissals.get(id);
    if (d && d.toldAt === null) d.toldAt = Date.now();
  }

  /** A dismissed agent deregistered (its clean-shutdown DELETE): it has exited. */
  noteDismissedDeregistered(id: string): void {
    const d = this.dismissals.get(id);
    if (d) d.exited = true;
  }

  /**
   * Has a dismissed agent gone — deregistered, or been told `dismissed` at least
   * `exitGraceMs` ago (a Pi teammate exits ~0.5s after hearing it, without
   * deregistering)? Unknown ids count as not gone: the dismiss directive's own
   * deadline covers them.
   */
  dismissedAgentExited(id: string, exitGraceMs = DISMISS_EXIT_GRACE_MS): boolean {
    const d = this.dismissals.get(id);
    if (!d) return false;
    return d.exited || (d.toldAt !== null && Date.now() - d.toldAt >= exitGraceMs);
  }

  /** True when `id` was explicitly dismissed (tombstoned) and not since re-registered. */
  isDismissed(id: string): boolean {
    return this.dismissedIds.has(id);
  }

  // --- The reaper ---

  /**
   * Check all registered agents for heartbeat timeout.
   * If an agent's last heartbeat is older than agentTimeoutSeconds:
   * - Move its in-flight WorkItems to MORIBUND (the lease is kept — see
   *   docs/DESIGN.md "Reaping")
   * - Mark it offline
   * - Log a warning
   *
   * Returns the list of agent IDs that were marked offline.
   */
  reapOfflineAgents(): string[] {
    const timeoutMs = (this.config.agentTimeoutSeconds ?? 90) * 1000;
    const cutoff = Date.now() - timeoutMs;
    const reaped: string[] = [];

    const rows = this.db.prepare(
      "SELECT * FROM members WHERE status != 'offline' AND last_heartbeat < ?"
    ).all(cutoff) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const id = row.id as string;
      const name = row.name as string;
      const lastHb = row.last_heartbeat as number;
      const agoSec = Math.round((Date.now() - lastHb) / 1000);

      // Move any in-flight WorkItem to MORIBUND (the agent went quiet, but we
      // don't declare failure or hand its work to someone else — see
      // docs/DESIGN.md "Reaping"). The lease is kept; a human force-fails
      // it, or the agent reconnects and its item is restored to IN_PROGRESS.
      const moved = this.markInFlightMoribund(id);
      if (moved > 0) {
        console.warn(
          `⚠️  Agent "${name}" (${id}) timed out (no heartbeat for ${agoSec}s). ` +
          `${moved} work item(s) marked MORIBUND.`
        );
      } else {
        console.warn(
          `⚠️  Agent "${name}" (${id}) timed out (no heartbeat for ${agoSec}s). Marked offline.`
        );
      }

      // Mark offline
      this.db.prepare("UPDATE members SET status = 'offline' WHERE id = ?").run(id);
      reaped.push(id);
    }

    return reaped;
  }

  /**
   * Move a member's IN_PROGRESS WorkItems to MORIBUND (the lease is kept; not
   * terminal, so no `onItemTerminal` and no retry). Shared by the reaper and
   * `removeMember`. Returns how many items moved.
   */
  private markInFlightMoribund(memberId: string): number {
    const inflight = this.db.prepare(
      "SELECT id FROM work_items WHERE member_id = ? AND state = 'IN_PROGRESS'"
    ).all(memberId) as Array<Record<string, unknown>>;
    for (const wi of inflight) this.deps.setWorkItemStateRow(wi.id as string, "MORIBUND");
    return inflight.length;
  }

  // --- The leader ---

  /**
   * The online leader, which is the agent that answers the chat.
   *
   * This used to *designate* one leader as the chat agent and keep that choice
   * sticky, because a multi-host team ran several leaders and they would otherwise
   * all pull the same message and answer it in parallel. With one leader (P1c)
   * there is nothing to designate — which is DESIGN.md's "One Agent to Talk To"
   * becoming literally true rather than arranged.
   */
  getLeader(): Member | null {
    return this.getMembers().find((m) => m.status !== "offline" && m.name.includes(LEADER_MEMBER_NAME)) ?? null;
  }

  /** True when `agentId` is the leader — only it may drain the chat inbox. */
  isLeader(agentId: string): boolean {
    return this.getLeader()?.id === agentId;
  }

  // --- Leader Directives (things asked of the leader; it realizes them) ---
  //
  // A single queue of directives per host: "leader, do X about an agent" — e.g.
  // spawn a new agent, or reset an existing one's session. The daemon expresses
  // the action + params (intent) and never knows the mechanism (tmux, etc.).
  // The leader polls its host's directives, acts, and marks them done.

  private rowToDirective(row: Record<string, unknown>): LeaderDirective {
    const memberId = (row.member_id as string) || undefined;
    // For actions on an existing member, include its opaque metadata so the
    // leader can deliver (e.g. the tmux window it supplied at registration).
    const member = memberId ? this.getMember(memberId) : null;
    return {
      id: row.id as string,
      action: row.action as string,
      memberId,
      params: row.params && (row.params as string) !== "{}" ? JSON.parse(row.params as string) : {},
      metadata: member?.metadata || {},
      status: row.status as string,
      createdAt: new Date(row.created_at as number).toISOString(),
    };
  }

  /**
   * Create a leader directive for a host. For the `spawn` action a unique
   * generated adjective-noun name is assigned into params (unless one was
   * supplied).
   *
   * Identity is daemon-owned state (DESIGN.md "the daemon coordinates; harnesses
   * execute"), so the daemon names spawns rather than letting the harness invent
   * one. Every spawn is a teammate: the chat is answered by the leader, so there
   * is no reserved singleton name and no coalescing.
   */
  createLeaderDirective(action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): LeaderDirective {
    const id = `dir-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const params: Record<string, unknown> = { ...(opts?.params || {}) };
    if (action === "spawn" && !params.name) params.name = this.generateSpawnName();
    // The daemon is the only thing that realizes a spawn (daemon/spawner.ts), so one
    // it can't realize fails now, with the reason and fix, instead of sitting
    // pending for a realizer that will never come.
    const error = action === "spawn"
      ? capabilityError(this.getSpawnCapability(typeof params.harness === "string" ? params.harness : undefined))
      : null;
    this.db.prepare(
      "INSERT INTO leader_directives (id, action, member_id, params, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, action, opts?.memberId || null, JSON.stringify(params), error ? "failed" : "pending", error, now, now);
    return this.rowToDirective(this.db.prepare("SELECT * FROM leader_directives WHERE id = ?").get(id) as Record<string, unknown>);
  }

  /** Record whether this process can reach tmux (the startup probe). */
  setTmuxCapability(capability: SpawnCapability): void {
    this.tmuxCapability = capability;
  }

  /**
   * Can this daemon realize a spawn of `harness` (default: the team's default
   * harness)? tmux reachability first, then the live config's harness checks —
   * re-evaluated on every call, since the Config page changes the harness live.
   */
  getSpawnCapability(harness?: string): SpawnCapability {
    if (!this.tmuxCapability.canSpawn) return this.tmuxCapability;
    return harnessCapability(harness ? { ...this.config, defaultHarness: harness } : this.config);
  }

  /**
   * The tmux reachability probed at startup, alone (no harness checks) — what
   * starting the leader needs (daemon/leader-start.ts), which has its own template
   * checks.
   */
  getTmuxCapability(): SpawnCapability {
    return this.tmuxCapability;
  }

  /**
   * Can the assistant be started from here (daemon/leader-start.ts
   * `assistantStartability`)? Re-evaluated on every call against the live config,
   * like `getSpawnCapability`.
   */
  getAssistantStartability(): AssistantStartability {
    return assistantStartability(this.config, this.tmuxCapability);
  }

  /** Create a directive targeting an existing member. Null if the member is unknown. */
  createLeaderDirectiveForMember(memberId: string, action: string, params?: Record<string, unknown>): LeaderDirective | null {
    const member = this.getMember(memberId);
    if (!member) return null;
    return this.createLeaderDirective(action, { memberId, params });
  }

  /**
   * Ask an agent for a fresh session (the Team tab's Reset, the skew banner's
   * Restart). Null if the member is unknown.
   *
   * The ask goes to the agent itself as a `new-session` self-directive, which it
   * realizes in-process (Pi: `ctx.newSession()`; `mpt agent`: a fresh ACP
   * session) — the daemon says *what*, never which keys to press (docs/DESIGN.md
   * "Leader Directives"). Every agent the daemon serves polls for it: the floor,
   * MIN_PROTOCOL_VERSION 6, is the version that made teammates do so. (Until the
   * leader stopped touching tmux, an older teammate got a `reset-session` the
   * leader realized by typing `/new` into its window; nothing realizes that now.)
   */
  resetMemberSession(memberId: string): LeaderDirective | null {
    const member = this.getMember(memberId);
    if (!member) return null;
    return this.createLeaderDirective("new-session", { memberId });
  }

  /**
   * Pending directives in the leader-directive queue, oldest first, each resolved
   * with target metadata — the daemon spawner's work list (`spawn`, `dismiss`).
   * Self-handled actions are excluded: a `new-session`/`resume-session` ask has
   * to be executed *inside* the target agent (`ctx.newSession()` /
   * `ctx.switchSession()`), so the agent polls those itself via
   * `getMemberDirectives`. See docs/DESIGN.md "Assistant Chat Model".
   */
  getLeaderDirectives(): LeaderDirective[] {
    const rows = this.db.prepare("SELECT * FROM leader_directives WHERE status = 'pending' ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDirective(r)).filter((d) => !SELF_HANDLED_ACTIONS.has(d.action));
  }

  /** Pending directives an agent must realize itself, oldest first. */
  getMemberDirectives(memberId: string): LeaderDirective[] {
    const rows = this.db.prepare(
      "SELECT * FROM leader_directives WHERE member_id = ? AND status = 'pending' ORDER BY created_at ASC",
    ).all(memberId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDirective(r)).filter((d) => SELF_HANDLED_ACTIONS.has(d.action));
  }

  /**
   * All pending `spawn` directives across every host, oldest first.
   *
   * Surfaced in the UI so a stuck spawn request (e.g. one whose leader never
   * acked completion) is visible and can be cancelled, rather than silently
   * driving the leader to retry forever.
   */
  getPendingSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT id, params, created_at FROM leader_directives WHERE action = 'spawn' AND status = 'pending' ORDER BY created_at ASC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse((row.params as string) || "{}"); } catch { /* ignore */ }
      return {
        id: row.id as string,
        name: typeof params.name === "string" ? params.name : null,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        createdAt: new Date(row.created_at as number).toISOString(),
      };
    });
  }

  /** One directive by id, resolved with its target's metadata, or null. */
  getLeaderDirective(id: string): LeaderDirective | null {
    const row = this.db.prepare("SELECT * FROM leader_directives WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDirective(row) : null;
  }

  /** Update a directive's status (e.g. 'done'). Returns false if not found. */
  updateLeaderDirective(id: string, status: string, error?: string): boolean {
    const row = this.db.prepare("SELECT id FROM leader_directives WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("UPDATE leader_directives SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, Date.now(), id);
    return true;
  }

  /**
   * Spawn directives that failed, newest first, with the reason.
   *
   * Surfaced in the UI beside pending spawns. Before the daemon realized spawns, a
   * failure was the leader's to report; now it is the daemon's, and an unreported
   * failure would look exactly like a team that simply never grew.
   */
  getFailedSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; error: string | null; at: string }> {
    const rows = this.db.prepare(
      "SELECT id, params, error, updated_at FROM leader_directives WHERE action = 'spawn' AND status = 'failed' ORDER BY updated_at DESC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const params = row.params && (row.params as string) !== "{}" ? JSON.parse(row.params as string) : {};
      return {
        id: row.id as string,
        name: (params.name as string) ?? null,
        cwd: (params.cwd as string) ?? null,
        error: (row.error as string) ?? null,
        at: new Date(row.updated_at as number).toISOString(),
      };
    });
  }

  /** Generate a unique teammate name (avoids current members + pending spawn directives). */
  private generateSpawnName(): string {
    const existingNames = new Set<string>();
    for (const m of this.getMembers()) existingNames.add(m.name);
    const pending = this.db.prepare("SELECT params FROM leader_directives WHERE action = 'spawn' AND status = 'pending'").all() as Array<Record<string, unknown>>;
    for (const row of pending) {
      try {
        const p = JSON.parse((row.params as string) || "{}");
        if (p.name) existingNames.add(p.name);
      } catch { /* ignore */ }
    }
    return generateTeammateName(existingNames, this.config.teammates);
  }

  // --- Teammate pool (declared size, not clicked-into-existence) ---
  //
  // `minTeammates` is the team's *declared* size: the daemon keeps at least that
  // many generalist teammates online and reconciles the shortfall itself by
  // queueing `spawn` directives. A teammate that is dismissed, crashes, or is
  // reaped offline is therefore replaced automatically. Nothing scales the pool
  // *down*: the daemon never dismisses a teammate (that stays a human act), so
  // lowering the number just stops replacements.

  /** Pending `spawn` directives for pool teammates. */
  private countPendingTeammateSpawns(): number {
    // Every pending spawn is a teammate: retired assistant spawns are cancelled at
    // boot (store/schema.ts cleanRetiredData).
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM leader_directives WHERE action = 'spawn' AND status = 'pending'").get() as { n: number };
    return row.n;
  }

  /**
   * Is a leader connected? The pool reconciler waits for one (see
   * reconcileTeammatePool for why — it is no longer because only a leader can
   * realize a spawn).
   *
   * This was `pickPoolSpawnHost()`, returning the host a spawn should land on —
   * but it only ever found *the* leader and returned its host, which is why P1c
   * could drop multi-host without changing behaviour (docs/DESIGN.md "One Host, One Leader").
   */
  private isLeaderOnline(): boolean {
    return this.getMembers().some((m) =>
      m.status !== "offline" && m.name.toLowerCase().includes(LEADER_MEMBER_NAME)
    );
  }

  /** The pool's live state: what's declared, what's online, what's inbound. */
  getTeammatePool(): TeammatePoolState {
    const online = this.getMembers().filter((m) => m.status !== "offline" && isPoolTeammate(m.name)).length;
    return {
      minTeammates: resolveMinTeammates(this.config),
      // True while no size has been declared (the value tracks maxTeammates / 2).
      isDefault: this.config.minTeammates === undefined,
      maxTeammates: this.config.maxTeammates ?? 0,
      online,
      pending: this.countPendingTeammateSpawns(),
      leaderPresent: this.isLeaderOnline(),
      spawnBlocked: blocked(this.getSpawnCapability()),
      assistantStartable: this.getAssistantStartability(),
    };
  }

  /**
   * Declare the pool's minimum size: persists it to config.json (so it survives
   * a restart and is applied at startup) and reconciles immediately. Returns the
   * clamped value actually stored, or null if `n` isn't a non-negative integer.
   * Passing `null` clears the declaration, reverting to the default (half of
   * maxTeammates) and returning that effective value.
   */
  setMinTeammates(n: number | null): number | null {
    if (n === null) {
      delete this.config.minTeammates;
    } else {
      if (!Number.isInteger(n) || n < 0) return null;
      const max = this.config.maxTeammates ?? 0;
      this.config.minTeammates = max > 0 ? Math.min(n, max) : n;
    }
    this.deps.saveConfig();
    this.reconcileTeammatePool();
    return resolveMinTeammates(this.config);
  }

  /**
   * Top the teammate pool back up to `minTeammates`. Counts online teammates
   * plus not-yet-realized spawn requests (so a slow leader doesn't get a second
   * batch), caps the target at `maxTeammates`, and waits for an online leader.
   * Returns how many spawn directives were queued.
   *
   * **The team starts when its leader does**, even when the daemon could realize
   * the spawns itself. The daemon often runs as a login service, so without this
   * every login would open `minTeammates` agent windows before anyone ran
   * `mpt lead` — agents nobody can chat with, reset (the leader types `/new`), or
   * see coming. `mpt lead` is the "start the team" step. An explicit one-off spawn
   * (the Spawn dialog) is a human asking now, and isn't held.
   *
   * When the daemon can't spawn (`getSpawnCapability`), it queues nothing: the
   * spawns would only fail (or, before, pile up pending), one batch per tick. The
   * reason is on the pool's `spawnBlocked` instead, which the Team tab flags.
   *
   * Called on the heartbeat timer (right after offline agents are reaped, so a
   * lost teammate is replaced within one tick) and whenever the number changes.
   */
  reconcileTeammatePool(): number {
    const target = resolveMinTeammates(this.config);
    if (target <= 0) return 0;

    const { online, pending } = this.getTeammatePool();
    const deficit = target - (online + pending);
    if (deficit <= 0) return 0;

    // Waits for the leader even when the daemon can spawn (see above).
    if (!this.isLeaderOnline()) return 0;
    if (!this.getSpawnCapability().canSpawn) return 0;

    for (let i = 0; i < deficit; i++) {
      this.createLeaderDirective("spawn", { params: { reason: "teammate" } });
    }
    return deficit;
  }
}

/** A capability as the pool reports it: null when spawning works, else its reason and fix. */
function blocked(capability: SpawnCapability): TeammatePoolState["spawnBlocked"] {
  return capability.canSpawn ? null : { reason: capability.reason, fix: capability.fix };
}

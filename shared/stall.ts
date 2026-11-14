/**
 * shared/stall.ts — The stall rule: when a live teammate counts as **stalled**
 * (docs/DESIGN.md "Stalled Teammates"), and how one is worded.
 *
 * The incident it exists for: a teammate ran `node --test … | grep …`, a test
 * never settled, and the process slept at 0% CPU for 13 hours while the agent's
 * heartbeat stayed fresh and its status said "working". Liveness (heartbeats,
 * `agentTimeoutSeconds`) can't see that; progress can. The harness reports what
 * it is doing and when it last made progress with every heartbeat
 * (agent-protocol.ts `AgentActivityReport`), and a teammate working on a claimed
 * item with no progress for longer than `stallMinutes` is stalled.
 *
 * Stalled is a *flag*, computed on read — not a member status and not a work
 * item state. Nothing is failed or killed (a long build is legitimate; a human
 * decides), and the flag clears by itself when progress resumes.
 *
 * Pure: the daemon (daemon/store.ts `getMemberStall`) feeds it the member, its
 * claimed item and its reports, and the CLI words it (`stallLine`), both with
 * an explicit `now`, so it's tested on a fake clock (tests/stall.test.ts).
 */

import { cleanActivityPreview, formatStallDuration, type AgentActivity, type AgentActivityReport } from "./agent-protocol.ts";

/** A stall's length for people (agent-protocol.ts, shared with the harness's interrupt nudge). */
export { formatStallDuration };
import type { AgentStall } from "./protocol.ts";
import type { Member, TeamConfig } from "./types.ts";

/** The team's `stallMinutes` when config.json sets none. */
export const DEFAULT_STALL_MINUTES = 30;

/** The longest tool name a heartbeat may report (longer is cut). */
const MAX_TOOL_NAME = 100;

/**
 * The threshold, in minutes, for a run: its workflow state's `stallMinutes`
 * when it sets one, else the team's, else `DEFAULT_STALL_MINUTES`. 0 = off.
 * A team value that isn't a number of minutes (0 or more) reads as the default.
 */
export function resolveStallMinutes(config: Pick<TeamConfig, "stallMinutes">, stateMinutes: number | null = null): number {
  if (stateMinutes !== null) return stateMinutes;
  const team = config.stallMinutes;
  return typeof team === "number" && Number.isFinite(team) && team >= 0 ? team : DEFAULT_STALL_MINUTES;
}

/** What `stallOf` needs to know about one agent. */
export interface StallInput {
  /** Now (epoch ms). */
  now: number;
  /** The threshold for its run (`resolveStallMinutes`); 0 = off. */
  stallMinutes: number;
  /** Its member status: only `working` can be stalled (not idle, pairing or offline). */
  status: Member["status"];
  /** The claimed (IN_PROGRESS) work item it holds, or null. */
  workItemId: string | null;
  /** When it claimed that item (epoch ms), or null when unknown. */
  claimedAt: number | null;
  /** Its harness's last activity report, or null for a harness that doesn't send one. */
  report: AgentActivityReport | null;
  /** When its session stats were last reported (epoch ms), or null — the older-harness fallback. */
  sessionStatsAt: number | null;
}

/**
 * The agent's stall, or null when it isn't stalled. Stalled = live (status
 * `working`: the reaper turns a silent agent `offline`, and its item MORIBUND),
 * holding a claimed item, not idle by its own report, and no progress for more
 * than `stallMinutes`.
 *
 * Progress is the harness's `lastProgressAt`; an older harness that reports no
 * activity falls back to its session stats' `at` (reported after every turn),
 * and one that reports neither is never flagged (there is nothing to tell
 * progress by). Either way the claim counts as a start, so last session's
 * progress can't make a fresh claim look stalled.
 */
export function stallOf(input: StallInput): AgentStall | null {
  const { now, stallMinutes, status, workItemId, claimedAt, report, sessionStatsAt } = input;
  if (!(stallMinutes > 0) || status !== "working" || !workItemId) return null;
  // The harness says no run is in flight: it is waiting on something else
  // (a human, the daemon), not stuck in a tool or a model call.
  if (report?.activity.state === "idle") return null;
  const progress = report ? report.lastProgressAt : sessionStatsAt;
  // Neither: a harness that reports nothing to measure progress by (e.g. an
  // `mpt agent` teammate) — unknown, so never flagged rather than guessed at.
  if (progress === null || !Number.isFinite(progress)) return null;
  const since = Math.max(progress, claimedAt ?? -Infinity);
  if (now - since <= stallMinutes * 60_000) return null;
  return { since, activity: report?.activity ?? null, stallMinutes, workItemId };
}

/**
 * The activity report in a heartbeat body, cleaned (`cleanActivityPreview` on
 * the preview, the tool name cut to length), or null when there is none or it
 * is malformed — the agent then counts as an older harness.
 */
export function readActivityReport(body: { activity?: unknown; lastProgressAt?: unknown }): AgentActivityReport | null {
  const a = body.activity;
  if (!a || typeof a !== "object") return null;
  const raw = a as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (raw.state !== "idle" && raw.state !== "model" && raw.state !== "tool") return null;
  if (!finite(raw.since) || !finite(body.lastProgressAt)) return null;
  const activity: AgentActivity = { state: raw.state, since: raw.since };
  if (raw.state === "tool") {
    if (typeof raw.tool === "string" && raw.tool.trim()) activity.tool = raw.tool.trim().slice(0, MAX_TOOL_NAME);
    if (typeof raw.preview === "string") {
      const preview = cleanActivityPreview(raw.preview);
      if (preview) activity.preview = preview;
    }
  }
  return { activity, lastProgressAt: body.lastProgressAt };
}

/** What a stalled agent is doing, in a few words: ``bash `node --test …` ``, `waiting on the model`. */
export function activityText(activity: AgentActivity | null): string {
  if (!activity) return "no activity reported";
  if (activity.state === "tool") {
    const tool = activity.tool || "a tool";
    return activity.preview ? `${tool} \`${activity.preview}\`` : tool;
  }
  return activity.state === "model" ? "waiting on the model" : "idle";
}

/** `mpt status`'s line for a stalled agent: ``bright-muad-dib stalled 13h: bash `node --test …` ``. */
export function stallLine(stall: AgentStall & { name: string }, now: number): string {
  return `${stall.name} stalled ${formatStallDuration(now - stall.since)}: ${activityText(stall.activity)}`;
}

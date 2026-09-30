/**
 * lib/team.ts — Types and small helpers shared by the Team tab's pieces
 * (hooks/useTeamData, components/team/*): who's on the team, and how an agent
 * is classified and linked, what its status means, and how its context fill and
 * session cost read. (The work queue's types are lib/queue.ts.)
 */

export type Role = "leader" | "teammate";

export interface Teammate {
  id: string;
  name: string;
  directory?: string | null;
  status: string;
  /** taskId of the WorkItem this agent currently holds, if any. */
  currentWork?: string | null;
  lastHeartbeat: number;
  /** Agent-protocol version reported at registration; absent = pre-handshake. */
  protocolVersion?: number;
  /** Which harness the agent runs under (e.g. "pi"). */
  harness?: string;
  /** The harness integration's build version. */
  harnessVersion?: string;
  /** Model, context fill + session cost, when the harness reports them (null otherwise). */
  session?: TeammateSession | null;
}

/** Mirrors shared/types.ts MemberSessionStats (hand-mirrored wire type). */
export interface TeammateSession {
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  costUsd: number;
  model: { id: string; name: string; provider: string } | null;
  at: number;
}

/**
 * Is this agent's harness out of step with the daemon?
 *
 * Deliberately only about *build* version, and only for agents that are online:
 * the protocol version is already enforced at registration (an unservable one is
 * refused), so what's left to surface is the silent case — an agent still running
 * an older extension, which keeps working while streaming no transcript and
 * recording no usage (docs/DESIGN.md "One Protocol, One Version").
 *
 * An agent that reported no version at all is also skewed: it predates the
 * handshake entirely.
 */
export function harnessSkew(
  t: Teammate,
  daemonVersion: string | undefined,
): { skewed: boolean; reason: string } | null {
  if (t.status === "offline" || !daemonVersion) return null;
  if (t.protocolVersion === undefined) {
    return { skewed: true, reason: `${t.name} runs an extension from before version reporting — restart it.` };
  }
  if (t.harnessVersion && t.harnessVersion !== daemonVersion) {
    return {
      skewed: true,
      reason: `${t.name} runs extension ${t.harnessVersion}; the daemon is ${daemonVersion} — restart it.`,
    };
  }
  return null;
}

/** A pending spawn request the leader hasn't realized/acked yet. */
export interface SpawnRequest {
  id: string;
  name: string | null;
  cwd: string | null;
  createdAt: string;
}

/**
 * A spawn the daemon tried and could not complete.
 *
 * Failures used to be the leader's to report. Since the daemon realizes spawns
 * (P3-1) they are its own, and an unreported one looks exactly like a team that
 * never grew — so they get a row of their own with the reason.
 */
export interface FailedSpawn {
  id: string;
  name: string | null;
  cwd: string | null;
  error: string | null;
  at: string;
}

/**
 * What a status means, in words — the status icon's tooltip and label.
 * Status is shown by the icon's *shape*, never by color (docs/DESIGN.md
 * "Teammate Status: Shape, not Color").
 */
export function statusLabel(status: string): string {
  switch (status) {
    case "pairing": return "Pairing with you";
    case "working": return "Working";
    case "idle": return "Waiting for work";
    default: return "Lost contact";
  }
}

/** Compact token count: 950, 12.3k, 84k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * How full the context window is, as a short label plus a precise tooltip.
 * The percentage when known (it's what decides "time for a fresh session"),
 * else the raw tokens; `null` when there's nothing to show. Just after a
 * compaction Pi doesn't know yet — that reads "?" rather than a fake 0%.
 */
export function formatContext(s: TeammateSession | null | undefined): { label: string; title: string } | null {
  if (!s) return null;
  const tokens = s.contextTokens, window = s.contextWindow;
  const of = window ? ` of ${window.toLocaleString("en-US")}` : "";
  if (s.contextPercent !== null) {
    const pct = s.contextPercent < 1 && s.contextPercent > 0 ? "<1" : String(Math.round(s.contextPercent));
    const detail = tokens !== null ? `${tokens.toLocaleString("en-US")}${of} tokens` : `${pct}%${of}`;
    return { label: `${pct}%`, title: `Context: ${detail} (${pct}%)` };
  }
  if (tokens !== null) return { label: formatTokens(tokens), title: `Context: ${tokens.toLocaleString("en-US")}${of} tokens` };
  if (window) return { label: "?", title: `Context: unknown until the next reply (window ${window.toLocaleString("en-US")} tokens)` };
  return null;
}

/** A model's tooltip: `provider/id` (just the id without a provider). */
export function modelTitle(m: { id: string; provider: string }): string {
  return `Model: ${m.provider ? `${m.provider}/` : ""}${m.id}`;
}

/** Session cost: $0.00, <$0.01, $1.25, $12.40. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * Classify an agent by name convention. There is no "assistant" role any more:
 * the leader is the agent you chat with (see DESIGN.md "One agent to talk to").
 */
export function roleOf(t: Pick<Teammate, "name">): Role {
  return t.name.toLowerCase().includes("leader") ? "leader" : "teammate";
}

/** Teammates (not the leader) open their live view in the center. */
export function viewPath(t: Teammate): string | null {
  return roleOf(t) === "teammate" ? `/teammates/${encodeURIComponent(t.id)}` : null;
}

/** Last path segment, for compact directory badges. */
export function dirName(dir: string | null | undefined): string | null {
  return dir ? dir.split("/").filter(Boolean).pop() ?? null : null;
}

/**
 * lib/team.ts — Types and small helpers shared by the Team tab's pieces
 * (hooks/useTeamData, components/team/*): who's on the team, and how an agent
 * is classified and linked. (The work queue's types are lib/queue.ts.)
 */

export type Role = "leader" | "teammate";

export interface Teammate {
  id: string;
  name: string;
  directory?: string | null;
  hostId?: string;
  status: string;
  /** taskId of the WorkItem this agent currently holds, if any. */
  currentWork?: string | null;
  lastHeartbeat: number;
}

/** A pending spawn request the leader hasn't realized/acked yet. */
export interface SpawnRequest {
  id: string;
  hostId: string;
  name: string | null;
  cwd: string | null;
  createdAt: string;
}

/** Status dot colors. */
export const STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/50",
  working: "bg-green-500",
  pairing: "bg-blue-500",
  offline: "bg-red-500",
};

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

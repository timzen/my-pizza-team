// Shared types for pi-pizza-team

export interface TeamConfig {
  port: number;
  tmuxSession: string;
  workflow: WorkflowConfig;
  autosave: AutosaveConfig;
  leaderUrl: string;
  maxTeammates?: number;
}

export interface WorkflowConfig {
  states: string[];
  transitions: Record<string, Record<string, TransitionPermission>>;
}

export type TransitionPermission = "any" | "teammate" | "lead";

export interface AutosaveConfig {
  flushIntervalMinutes: number;
  commitIntervalHours: number;
  commitMessage: string;
  autoCommit: boolean;
}

export interface Story {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  dir?: string;
  archivedAt?: string; // ISO timestamp
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number; // estimated
  at: string; // ISO timestamp
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  result: string | null;
  tokenUsage?: TokenUsage[];
}

export interface TaskWithMeta extends Task {
  storyId: string;
  seq: number;
  slug: string;
  dirPath: string;
}

export interface Message {
  from: string;
  body: string;
  at: string; // ISO timestamp
}

export interface Member {
  id: string;
  name: string;
  cwd: string;
  tmuxWindow: string;
  status: "idle" | "working" | "pairing" | "offline";
  lastHeartbeat: number;
}

export interface Assignment {
  taskId: string;
  memberId: string;
  claimedAt: number;
}

export const DEFAULT_CONFIG: TeamConfig = {
  port: 7437,
  tmuxSession: "pi-pizza-team",
  workflow: {
    states: ["todo", "in_progress", "needs_input", "review", "done"],
    transitions: {
      todo: { in_progress: "any" },
      in_progress: { needs_input: "teammate", review: "teammate" },
      needs_input: { in_progress: "lead" },
      review: { done: "lead", in_progress: "lead" },
    },
  },
  autosave: {
    flushIntervalMinutes: 30,
    commitIntervalHours: 24,
    commitMessage: "pi-pizza-team: checkpoint {timestamp}",
    autoCommit: true,
  },
  leaderUrl: "http://localhost:7437",
  maxTeammates: 4,
};

export interface TransitionInstructions {
  onEnter?: string; // markdown content
  onExit?: string;  // markdown content
}

export const TEAM_DIR = ".pi-pizza-team";
export const CONFIG_FILE = "config.json";
export const STATE_DB = "state.db";
export const STORIES_DIR = "stories";
export const ARCHIVED_DIR = "archived";

/** Generate a URL-safe slug from a title (max 40 chars) */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

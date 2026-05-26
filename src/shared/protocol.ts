// API request/response shapes for the HTTP protocol

// GET /api/status
export interface StatusResponse {
  running: boolean;
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  inbox: number; // unread messages needing lead attention
}

// GET /api/stories
export interface StoriesResponse {
  stories: StoryView[];
}

export interface StoryView {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  dependsOn: string[];
  ready: boolean; // all dependencies met?
  dir?: string;
  tasks: TaskView[];
}

export interface TaskView {
  id: string;
  seq: number;
  title: string;
  status: string;
  assignee: string | null;
  hasMessages: boolean;
}

// GET /api/next-task?memberId=X
export interface NextTaskResponse {
  task: {
    id: string;
    storyId: string;
    title: string;
    description: string;
    context?: string; // previous task results for continuity
  } | null;
}

// POST /api/tasks/:taskId/claim
export interface ClaimRequest {
  memberId: string;
}

export interface ClaimResponse {
  success: boolean;
  error?: string;
  instructions?: string;
}

// POST /api/tasks/:taskId/status
export interface StatusUpdateRequest {
  status: string;
  result?: string;
  actor: "lead" | "teammate";
  memberId?: string;
}

export interface StatusUpdateResponse {
  success: boolean;
  error?: string;
  instructions?: string;
}

// POST /api/tasks/:taskId/message
export interface PostMessageRequest {
  from: string;
  body: string;
}

export interface PostMessageResponse {
  success: boolean;
}

// GET /api/tasks/:taskId/messages
export interface MessagesResponse {
  messages: Array<{
    from: string;
    body: string;
    at: string;
  }>;
}

// POST /api/team/join
export interface JoinRequest {
  id: string;
  name: string;
  cwd: string;
  tmuxWindow: string;
}

export interface JoinResponse {
  success: boolean;
  config: {
    workflow: import("./types.js").WorkflowConfig;
  };
}

// POST /api/team/heartbeat
export interface HeartbeatRequest {
  id: string;
  status: "idle" | "working" | "pairing";
  currentTask?: string;
}

// POST /api/stories
export interface CreateStoryRequest {
  id: string;
  title: string;
  description: string;
  status?: "open" | "done";
  dependsOn?: string[];
  dir?: string;
  tasks?: Array<{
    title: string;
    description: string;
  }>;
}

export interface CreateStoryResponse {
  success: boolean;
  story?: StoryView;
  error?: string;
}

// GET /api/team
export interface TeamResponse {
  members: Array<{
    id: string;
    name: string;
    status: string;
    currentTask: string | null;
    tmuxWindow: string;
    lastHeartbeat: number;
  }>;
}

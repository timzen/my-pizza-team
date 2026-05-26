// HTTP client for teammate → leader communication
//
// Wraps all API calls a teammate makes to the team lead's HTTP server.
// Each method corresponds to one API endpoint. All methods are async
// and return typed response objects from shared/protocol.ts.
//
// The client is initialized with the leader's base URL and the teammate's
// member ID (used for authentication/identification in requests).
import type {
  StatusResponse,
  NextTaskResponse,
  ClaimResponse,
  StatusUpdateResponse,
  PostMessageResponse,
  MessagesResponse,
  JoinResponse,
} from "../shared/protocol.js";
import type { WorkflowConfig } from "../shared/types.js";

export class TeamClient {
  private baseUrl: string;
  private memberId: string;

  constructor(baseUrl: string, memberId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.memberId = memberId;
  }

  async join(name: string, cwd: string, tmuxWindow: string): Promise<JoinResponse> {
    const res = await fetch(`${this.baseUrl}/api/team/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.memberId, name, cwd, tmuxWindow }),
    });
    return res.json() as Promise<JoinResponse>;
  }

  async heartbeat(status: "idle" | "working" | "pairing", currentTask?: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/team/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.memberId, status, currentTask }),
    });
  }

  async getNextTask(): Promise<NextTaskResponse> {
    const res = await fetch(`${this.baseUrl}/api/next-task?memberId=${this.memberId}`);
    return res.json() as Promise<NextTaskResponse>;
  }

  async claimTask(taskId: string): Promise<ClaimResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: this.memberId }),
    });
    return res.json() as Promise<ClaimResponse>;
  }

  async updateStatus(taskId: string, status: string, result?: string): Promise<StatusUpdateResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, result, actor: "teammate", memberId: this.memberId }),
    });
    return res.json() as Promise<StatusUpdateResponse>;
  }

  async postMessage(taskId: string, body: string): Promise<PostMessageResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.memberId, body }),
    });
    return res.json() as Promise<PostMessageResponse>;
  }

  async getMessages(taskId: string): Promise<MessagesResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/messages`);
    return res.json() as Promise<MessagesResponse>;
  }

  async checkServer(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/status`);
      const data = (await res.json()) as StatusResponse;
      return data.running === true;
    } catch {
      return false;
    }
  }
}

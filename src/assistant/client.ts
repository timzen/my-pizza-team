// HTTP client for assistant → leader communication
//
// Wraps API calls the assistant makes to the leader's HTTP server.
// Handles queue polling, claiming items, and reporting completion.
// Also provides methods for saving notes.
import type {
  AssistantNextResponse,
  AssistantClaimResponse,
  AssistantCompleteResponse,
  AssistantSaveNoteResponse,
} from "../shared/protocol.js";

export class AssistantClient {
  private baseUrl: string;
  private memberId: string;

  constructor(baseUrl: string, memberId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.memberId = memberId;
  }

  async checkServer(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/status`);
      const data = await res.json() as any;
      return data.running === true;
    } catch {
      return false;
    }
  }

  async join(cwd: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/team/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.memberId, name: "assistant", cwd, tmuxWindow: "assistant" }),
    });
  }

  async heartbeat(status: "idle" | "working"): Promise<void> {
    await fetch(`${this.baseUrl}/api/team/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.memberId, status }),
    }).catch(() => {});
  }

  async getNextItem(): Promise<AssistantNextResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/next`);
    return res.json() as Promise<AssistantNextResponse>;
  }

  async claimItem(id: string): Promise<AssistantClaimResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/queue/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return res.json() as Promise<AssistantClaimResponse>;
  }

  async completeItem(id: string, result?: string, failed = false): Promise<AssistantCompleteResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/queue/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, status: failed ? "failed" : "done" }),
    });
    return res.json() as Promise<AssistantCompleteResponse>;
  }

  async saveNote(title: string, content: string, categories?: string[]): Promise<AssistantSaveNoteResponse> {
    const res = await fetch(`${this.baseUrl}/api/assistant/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, categories }),
    });
    return res.json() as Promise<AssistantSaveNoteResponse>;
  }
}

/**
 * daemon/routes/agents.ts — Agent protocol routes (WorkItem-centric) and
 * spawn requests.
 *
 * The streamlined agent-facing interface: register → poll → claim → set state.
 * A WorkItem is the single unit of agent execution; its polymorphic ref points
 * at a story task or a WorkDef. The daemon owns the prompt and reacts to a
 * terminal WorkItem state (COMPLETE advances a task; FAILED leaves it stuck).
 * See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.
 *
 * Also includes leader directives + spawn request endpoints.
 */

import type { RouteContext } from "./types.ts";
import { buildWorkDefPrompt } from "../prompt.ts";
import { estimateTokenCost } from "../token-cost.ts";
import type { WorkItemRef } from "../../shared/types.ts";

export function registerAgentRoutes(ctx: RouteContext): void {
  const { app, store, config, isPaused } = ctx;

  // ─── Register / Heartbeat ──────────────────────────────────────────

  app.post("/api/agents/register", async (c) => {
    const body = await c.req.json() as {
      id?: string; name?: string; hostId?: string;
      directory?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.id || !body.name) {
      return c.json({ success: false, error: "Fields 'id' and 'name' are required" }, 400);
    }

    // The harness may attach opaque metadata (e.g. its tmux window) it later
    // uses to realize control intents. The daemon stores it verbatim.
    store.registerMember(body.id, body.name, body.directory, body.metadata || {}, body.hostId);

    const hostConfig = body.hostId ? config.hosts?.[body.hostId] : undefined;
    const tmuxSession = hostConfig?.tmuxSession || config.tmuxSession;

    return c.json({
      success: true,
      config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), tmuxSession },
    });
  });

  app.post("/api/agents/heartbeat", async (c) => {
    const body = await c.req.json() as { id?: string; status?: string };
    if (!body.id || !body.status) return c.json({ success: false, error: "Fields 'id' and 'status' are required" }, 400);
    const member = store.getMember(body.id);
    if (!member) {
      // Distinguish an explicit dismissal (shut down) from a merely-unknown
      // member (re-register). A daemon restart wipes the members table, so
      // treating unknown as "dismissed" would kill every running agent on
      // restart/upgrade; instead we tell them to re-register.
      if (store.isDismissed(body.id)) return c.json({ success: false, dismissed: true });
      return c.json({ success: false, reregister: true });
    }
    store.heartbeat(body.id, body.status);
    return c.json({ success: true });
  });

  // ─── Next Work ─────────────────────────────────────────────────────

  app.get("/api/agents/next-work", (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ workItem: null });
    if (isPaused()) return c.json({ workItem: null });

    const member = store.getMember(agentId);
    if (!member) return c.json({ workItem: null });

    const item = store.getNextWorkItem({ id: member.id, directory: member.directory });
    if (!item) return c.json({ workItem: null });

    return c.json({ workItem: { id: item.id, title: item.title } });
  });

  // ─── Claim ─────────────────────────────────────────────────────────

  app.post("/api/agents/claim/:workItemId", async (c) => {
    const workItemId = c.req.param("workItemId");
    const body = await c.req.json() as { agentId?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const item = store.getWorkItem(workItemId);
    if (!item) return c.json({ success: false, error: `WorkItem "${workItemId}" not found` }, 404);

    const ok = store.claimWorkItem(workItemId, body.agentId);
    if (!ok) return c.json({ success: false, error: "WorkItem not claimable (already claimed, or not ready)" }, 409);

    store.updateMemberStatus(body.agentId, "working");

    const prompt = buildClaimPrompt(store, item.ref);

    return c.json({ success: true, workItem: { id: item.id }, prompt });
  });

  // ─── Set WorkItem State (the single state-setter) ──────────────────
  //
  // The agent transitions its WorkItem to COMPLETE or FAILED. The daemon reacts
  // (COMPLETE advances a task ref; FAILED leaves it stuck). "Giving up" is the
  // agent composing a comment + FAILED — the daemon bundles nothing.

  app.post("/api/agents/work-items/:workItemId/state", async (c) => {
    const workItemId = c.req.param("workItemId");
    const body = await c.req.json() as { agentId?: string; state?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);
    if (body.state !== "COMPLETE" && body.state !== "FAILED") {
      return c.json({ success: false, error: "Field 'state' must be 'COMPLETE' or 'FAILED'" }, 400);
    }

    const item = store.getWorkItem(workItemId);
    if (!item) return c.json({ success: false, error: `WorkItem "${workItemId}" not found` }, 404);
    if (item.memberId && item.memberId !== body.agentId) {
      return c.json({ success: false, error: "WorkItem not held by this agent" }, 403);
    }

    const res = store.setWorkItemState(workItemId, body.state);
    store.updateMemberStatus(body.agentId, "idle");
    if (!res.ok) return c.json({ success: false, error: res.error }, 400);
    return c.json({ success: true, newStatus: res.newStatus, completed: res.completed });
  });

  // ─── Token usage (resolved to the backing task ref) ────────────────

  app.post("/api/agents/work-items/:workItemId/token-usage", async (c) => {
    const item = store.getWorkItem(c.req.param("workItemId"));
    if (!item) return c.json({ success: false, error: "WorkItem not found" }, 404);
    const body = await c.req.json() as { inputTokens?: number; outputTokens?: number; model?: string; costUsd?: number };
    if (typeof body.inputTokens !== "number" || typeof body.outputTokens !== "number" || !body.model) {
      return c.json({ success: false, error: "Fields inputTokens, outputTokens, model required" }, 400);
    }
    // Prefer the harness-reported cost (accurate + cache-aware); fall back to a
    // rough estimate only when the harness doesn't supply one. Recorded on the
    // ref, so it works for board tasks AND standalone (Solitary/Scheduled) work.
    const costUsd = typeof body.costUsd === "number" ? body.costUsd : estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
    store.addTokenUsageForRef(item.ref, body.inputTokens, body.outputTokens, body.model, costUsd);
    return c.json({ success: true });
  });

  // ─── Attachments (resolved to the backing ref) ─────────────────────

  app.post("/api/agents/work-items/:workItemId/attachments", async (c) => {
    const item = store.getWorkItem(c.req.param("workItemId"));
    if (!item) return c.json({ success: false, error: "WorkItem not found" }, 404);
    const body = await c.req.json() as { name?: string; content?: string; encoding?: string };
    if (!body.name || !body.content) return c.json({ success: false, error: "Fields 'name' and 'content' are required" }, 400);

    let data: string | Uint8Array = body.content;
    if (body.encoding === "base64") {
      const bin = atob(body.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      data = bytes;
    }
    const storedName = store.saveAttachmentForRef(item.ref, body.name, data);
    if (!storedName) return c.json({ success: false, error: "Failed to save attachment" }, 500);
    return c.json({ success: true, storedName });
  });

  // ─── WorkItem Comments (on the ref) ────────────────────────────────

  app.get("/api/agents/comments/:workItemId", (c) => {
    const item = store.getWorkItem(c.req.param("workItemId"));
    if (!item) return c.json({ comments: [] });
    return c.json({ comments: store.getCommentsForRef(item.ref) });
  });

  app.post("/api/agents/comments/:workItemId", async (c) => {
    const item = store.getWorkItem(c.req.param("workItemId"));
    const body = await c.req.json() as { agentId?: string; body?: string; attachments?: Array<{ name: string; size: number; type: string }> };
    if (!body.agentId || !body.body) return c.json({ success: false, error: "Fields 'agentId' and 'body' are required" }, 400);
    if (!item) return c.json({ success: false, error: "WorkItem not found" }, 404);
    store.addCommentForRef(item.ref, body.agentId, body.body, body.attachments);
    return c.json({ success: true });
  });

  // ─── Agent List / Delete ───────────────────────────────────────────

  app.get("/api/agents", (c) => {
    const members = store.getMembers();
    return c.json({
      agents: members.map(m => {
        const assignment = store.getAssignmentForMember(m.id);
        return { id: m.id, name: m.name, directory: m.directory, hostId: m.hostId, status: m.status, currentWork: assignment?.taskId || null, lastHeartbeat: m.lastHeartbeat };
      }),
    });
  });

  app.delete("/api/agents/:id", (c) => {
    const agentId = c.req.param("id");
    const member = store.getMember(agentId);
    if (!member) return c.json({ success: false, error: `Agent "${agentId}" not found` }, 404);
    // `?dismiss=true` (a human clicking "dismiss") tombstones the id so its next
    // heartbeat shuts the agent down. A plain DELETE (clean self-deregister on
    // shutdown) just removes it — no tombstone.
    if (c.req.query("dismiss") === "true") store.dismissMember(agentId);
    else store.removeMember(agentId);
    return c.json({ success: true });
  });

  // ─── Leader Directives (one queue of asks per host) ──────────────────

  app.post("/api/hosts/:hostId/leader/directives", async (c) => {
    const hostId = c.req.param("hostId");
    const body = await c.req.json().catch(() => ({})) as { action?: string; memberId?: string; params?: Record<string, unknown> };
    if (!body.action || typeof body.action !== "string") return c.json({ success: false, error: "Field 'action' is required" }, 400);
    const directive = store.createLeaderDirective(hostId, body.action, { memberId: body.memberId, params: body.params });
    return c.json({ success: true, directive }, 201);
  });

  app.get("/api/hosts/:hostId/leader/directives", (c) => {
    return c.json({ directives: store.getLeaderDirectives(c.req.param("hostId")) });
  });

  app.put("/api/hosts/:hostId/leader/directives/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { status?: string };
    if (!body.status || typeof body.status !== "string") return c.json({ success: false, error: "Field 'status' is required" }, 400);
    const ok = store.updateLeaderDirective(c.req.param("id"), body.status);
    if (!ok) return c.json({ success: false, error: "Directive not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Agent self-directives (realized in-process, not via tmux) ───────
  //
  // Session replacement (`new-session`, `resume-session`) has to run inside the
  // target agent via Pi's session APIs, so the agent polls its own queue rather
  // than the leader delivering keystrokes. See docs/ASSISTANT_CHAT_V2.md §5.5.

  app.get("/api/agents/:id/directives", (c) => {
    return c.json({ directives: store.getMemberDirectives(c.req.param("id")) });
  });

  app.put("/api/agents/:id/directives/:directiveId", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { status?: string };
    const ok = store.updateLeaderDirective(c.req.param("directiveId"), body.status || "done");
    if (!ok) return c.json({ success: false, error: "Directive not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Pending spawn requests (visibility + cancel) ────────────────────

  app.get("/api/spawn-requests", (c) => {
    return c.json({ requests: store.getPendingSpawnRequests() });
  });

  app.delete("/api/spawn-requests/:id", (c) => {
    const ok = store.updateLeaderDirective(c.req.param("id"), "cancelled");
    if (!ok) return c.json({ success: false, error: "Spawn request not found" }, 404);
    return c.json({ success: true });
  });
}

/** Assemble the canonical claim prompt for a WorkItem's ref. */
function buildClaimPrompt(store: RouteContext["store"], ref: WorkItemRef): string {
  const def = store.getWorkDef(ref.workDefId);
  if (!def) return "";

  // A board task carries workflow framing (its story + state persona); a
  // standalone WorkDef (Solitary/Scheduled) has none.
  const task = store.getTask(ref.workDefId);
  const story = task ? store.getStory(task.storyId) : null;
  const comments = store.getCommentsForRef(ref);

  return buildWorkDefPrompt({
    workDef: {
      title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria,
      additionalContext: def.additionalContext, directory: def.directory,
    },
    story: story ? { id: story.id, title: story.title, description: story.description, directory: story.directory } : undefined,
    state: task ? task.status : undefined,
    persona: task ? store.getStatePersona(story?.workflow, task.status) : undefined,
    comments: comments.length > 0 ? comments : undefined,
    contextEntries: store.resolveTaskContext(story?.context, def.contextRefs),
  });
}

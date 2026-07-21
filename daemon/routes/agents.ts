/**
 * daemon/routes/agents.ts — Agent protocol routes and spawn requests.
 *
 * The streamlined agent-facing interface for autonomous coding agents:
 * poll → claim → work → done (or return). Workers never move tasks — the
 * daemon advances completed work mechanically and admission pulls from the
 * todo bucket (see docs/WORK-MODEL.md).
 *
 * Also includes spawn request endpoints for the leader to request
 * new agent processes on host machines.
 */

import type { RouteContext } from "./types.ts";
import { buildTaskPrompt } from "../prompt.ts";
import { DEFAULT_WORK_MODE, type Capabilities, type WorkMode } from "../../shared/types.ts";

export function registerAgentRoutes(ctx: RouteContext): void {
  const { app, store, config, isPaused } = ctx;

  // ─── Register / Heartbeat ──────────────────────────────────────────

  app.post("/api/agents/register", async (c) => {
    const body = await c.req.json() as {
      id?: string; name?: string; hostId?: string;
      capabilities?: Record<string, string | null>;
      workMode?: WorkMode; assignedStoryId?: string;
      tmuxWindow?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.id || !body.name) {
      return c.json({ success: false, error: "Fields 'id' and 'name' are required" }, 400);
    }
    const capabilities: Capabilities = { ...(body.capabilities || {}) };

    const workMode: WorkMode = body.workMode || DEFAULT_WORK_MODE;
    if (workMode === "assigned-story" && !body.assignedStoryId) {
      return c.json({ success: false, error: "workMode 'assigned-story' requires 'assignedStoryId'" }, 400);
    }

    // The harness may attach opaque metadata (e.g. its tmux window) that it can
    // later use to realize control intents. The daemon stores it verbatim.
    const metadata = body.metadata || {};

    store.registerMember(body.id, body.name, capabilities, metadata, body.hostId, workMode, body.assignedStoryId);

    const hostConfig = body.hostId ? config.hosts?.[body.hostId] : undefined;
    const tmuxSession = hostConfig?.tmuxSession || config.tmuxSession;
    // Directory suggestions come from recently used `directory` capabilities.
    const directories = store.getRecentCapabilities()["directory"] || [];

    return c.json({
      success: true,
      config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), tmuxSession, directories },
    });
  });

  app.post("/api/agents/heartbeat", async (c) => {
    const body = await c.req.json() as { id?: string; status?: string };
    if (!body.id || !body.status) return c.json({ success: false, error: "Fields 'id' and 'status' are required" }, 400);
    const member = store.getMember(body.id);
    if (!member) return c.json({ success: false, dismissed: true });
    store.heartbeat(body.id, body.status);
    return c.json({ success: true });
  });

  // ─── Next Work ─────────────────────────────────────────────────────

  app.get("/api/agents/next-work", (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ task: null });
    if (isPaused()) return c.json({ task: null });

    const member = store.getMember(agentId);
    if (!member) return c.json({ task: null });

    const result = store.getNextWorkableTask({
      capabilities: member.capabilities,
      workMode: member.workMode,
      assignedStoryId: member.assignedStoryId,
    });

    if (!result) {
      // An assigned-story agent with no more work: if its story is finished,
      // archive it and tell the agent to dismiss itself.
      if (member.workMode === "assigned-story" && member.assignedStoryId) {
        const story = store.getStory(member.assignedStoryId);
        if (story && store.isStoryArchivable(member.assignedStoryId)) {
          store.archiveStory(member.assignedStoryId);
          return c.json({ task: null, dismiss: true });
        }
      }
      return c.json({ task: null });
    }

    return c.json({
      task: {
        id: result.id,
        title: result.title,
        storyId: result.storyId,
      },
    });
  });

  // ─── Claim ─────────────────────────────────────────────────────────

  app.post("/api/agents/claim/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    // Lease the task (verifies agent state + ready substatus).
    const success = store.claimTask(taskId, body.agentId);
    if (!success) return c.json({ success: false, error: "Task not claimable (already claimed, or not ready in an agent state)" }, 409);

    store.updateMemberStatus(body.agentId, "working");

    const story = store.getStory(task.storyId);
    const storyTasks = store.getTasksForStory(task.storyId);
    // "Previous tasks" = those ahead of this one in the story's (execution)
    // order, not creation order — storyTasks is already in taskOrder order.
    const currentIdx = storyTasks.findIndex(t => t.id === task.id);
    const previousResults = storyTasks
      .slice(0, currentIdx < 0 ? 0 : currentIdx)
      .filter(t => t.result)
      .map(t => `[${t.title}]: ${t.result}`)
      .join("\n\n");
    const comments = store.getComments(taskId);

    // The daemon assembles the full, canonical prompt — the state's persona
    // plus story/task context — so every harness delivers it verbatim.
    const prompt = buildTaskPrompt({
      story: story ? { id: story.id, title: story.title, description: story.description, directory: story.directory } : undefined,
      task: { id: task.id, storyId: task.storyId, title: task.title, description: task.description },
      state: task.status,
      persona: store.getStatePersona(story?.workflow, task.status),
      previousResults: previousResults || undefined,
      comments: comments.length > 0 ? comments : undefined,
      contextEntries: store.resolveTaskContext(story?.context, task.context),
    });

    return c.json({
      success: true,
      task: { id: task.id, storyId: task.storyId, status: task.status },
      prompt,
    });
  });

  // ─── Done (work complete → daemon advances) ────────────────────────
  //
  // Workers never move tasks: "done" is the completion signal, and the daemon
  // advances the task to the next state mechanically (see docs/WORK-MODEL.md).
  // `release` is kept as a deprecated alias for pre-work-model harnesses.

  const handleDone = async (c: { req: { param: (k: string) => string; json: () => Promise<unknown> }; json: (o: unknown, s?: number) => Response }) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; result?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const assignment = store.getAssignment(taskId);
    if (!assignment || assignment.memberId !== body.agentId) {
      return c.json({ success: false, error: "Task not claimed by this agent" }, 403);
    }

    const advance = store.completeTaskWork(taskId, body.result);
    store.updateMemberStatus(body.agentId, "idle");
    if (!advance) return c.json({ success: false, error: "Task is not in an agent state" }, 400);

    return c.json({ success: true, newStatus: advance.newStatus, completed: advance.completed });
  };

  app.post("/api/agents/done/:taskId", (c) => handleDone(c));
  app.post("/api/agents/release/:taskId", (c) => handleDone(c));

  // ─── Return (agent gives up → back to ready + comment) ─────────────

  app.post("/api/agents/return/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; comment?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const assignment = store.getAssignment(taskId);
    if (!assignment || assignment.memberId !== body.agentId) {
      return c.json({ success: false, error: "Task not claimed by this agent" }, 403);
    }

    if (body.comment) store.addComment(taskId, body.agentId, `[returned] ${body.comment}`);
    store.returnTaskToReady(taskId);
    store.updateMemberStatus(body.agentId, "idle");

    return c.json({ success: true });
  });

  // ─── Agent Comments ────────────────────────────────────────────────

  app.get("/api/agents/comments/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ comments: [] });
    return c.json({ comments: store.getComments(taskId) });
  });

  app.post("/api/agents/comments/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; body?: string; attachments?: Array<{ name: string; size: number; type: string }> };
    if (!body.agentId || !body.body) return c.json({ success: false, error: "Fields 'agentId' and 'body' are required" }, 400);
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
    store.addComment(taskId, body.agentId, body.body, body.attachments);
    return c.json({ success: true });
  });

  // ─── Agent List / Delete ───────────────────────────────────────────

  app.get("/api/agents", (c) => {
    const members = store.getMembers();
    return c.json({
      agents: members.map(m => {
        const assignment = store.getAssignmentForMember(m.id);
        return { id: m.id, name: m.name, capabilities: m.capabilities, workMode: m.workMode, assignedStoryId: m.assignedStoryId, hostId: m.hostId, status: m.status, currentTask: assignment?.taskId || null, lastHeartbeat: m.lastHeartbeat };
      }),
    });
  });

  app.delete("/api/agents/:id", (c) => {
    const agentId = c.req.param("id");
    const member = store.getMember(agentId);
    if (!member) return c.json({ success: false, error: `Agent "${agentId}" not found` }, 404);
    store.removeMember(agentId);
    return c.json({ success: true });
  });

  // ─── Leader Directives (one queue of asks per host) ──────────────────
  //
  // A directive is "leader, do X about an agent" — spawn a new one, reset an
  // existing one, etc. The daemon only expresses the action + params (intent);
  // the leader polls its host's directives, realizes them, and PUTs status
  // 'done'. This is the single daemon→leader channel.

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

  // ─── Pending spawn requests (visibility + cancel) ────────────────────
  //
  // A spawn directive whose leader never acked completion stays 'pending' and
  // the leader keeps retrying it. These routes let the UI surface such stuck
  // requests across all hosts and cancel them.

  app.get("/api/spawn-requests", (c) => {
    return c.json({ requests: store.getPendingSpawnRequests() });
  });

  app.delete("/api/spawn-requests/:id", (c) => {
    const ok = store.updateLeaderDirective(c.req.param("id"), "cancelled");
    if (!ok) return c.json({ success: false, error: "Spawn request not found" }, 404);
    return c.json({ success: true });
  });
}

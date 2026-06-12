/**
 * daemon/routes/agents.ts — Agent protocol routes and spawn requests.
 *
 * The streamlined agent-facing interface for autonomous coding agents.
 * Agents use a simple claim/release loop — the daemon handles all
 * workflow state transitions.
 *
 * Also includes spawn request endpoints for the leader to request
 * new agent processes on host machines.
 */

import type { RouteContext } from "./types.ts";
import { getDoneState } from "../../shared/types.ts";

export function registerAgentRoutes(ctx: RouteContext): void {
  const { app, store, config, isPaused, getInstructionsMarkdown } = ctx;

  // ─── Register / Heartbeat ──────────────────────────────────────────

  app.post("/api/agents/register", async (c) => {
    const body = await c.req.json() as { id?: string; name?: string; cwd?: string; hostId?: string; capabilities?: string[] };
    if (!body.id || !body.name || !body.cwd) {
      return c.json({ success: false, error: "Fields 'id', 'name', and 'cwd' are required" }, 400);
    }
    store.registerMember(body.id, body.name, body.cwd, body.id, body.hostId);

    const hostConfig = body.hostId ? config.hosts?.[body.hostId] : undefined;
    const tmuxSession = hostConfig?.tmuxSession || config.tmuxSession;
    const favoriteDirectories = hostConfig?.favoriteDirectories || config.teammates?.favoriteDirectories || [];

    return c.json({
      success: true,
      config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), tmuxSession, favoriteDirectories },
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
    const result = store.getNextWorkableTask(member?.cwd);
    if (!result) return c.json({ task: null });

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

    const wf = store.getWorkflowForTask(taskId);
    const transitions = wf.transitions[task.status] || {};
    let targetStatus: string | null = null;
    for (const [toState, perm] of Object.entries(transitions)) {
      if (perm === "teammate" || perm === "any") { targetStatus = toState; break; }
    }
    if (!targetStatus) {
      return c.json({ success: false, error: `No valid teammate transition from "${task.status}"` }, 400);
    }

    const success = store.claimTask(taskId, body.agentId);
    if (!success) return c.json({ success: false, error: "Task already claimed" }, 409);

    const fromStatus = task.status;
    store.updateTaskStatus(taskId, targetStatus);
    store.updateMemberStatus(body.agentId, "working");

    // Determine what state the task will exit to on release
    const exitTransitions = wf.transitions[targetStatus] || {};
    const exitStates = Object.entries(exitTransitions);
    let exitsTo: string | null = null;
    for (const [toState, perm] of exitStates) {
      if (perm === "teammate" || perm === "any") { exitsTo = toState; break; }
    }
    if (!exitsTo && exitStates.length > 0) exitsTo = exitStates[0]![0];

    const story = store.getStory(task.storyId);
    const storyTasks = store.getTasksForStory(task.storyId);
    const previousResults = storyTasks
      .filter(t => t.seq < task.seq && t.result)
      .map(t => `[${t.title}]: ${t.result}`)
      .join("\n\n");
    const comments = store.getComments(taskId);

    // Build state context to help the agent understand its role
    let guidance = `You are entering the '${targetStatus}' state.`;
    if (exitsTo) {
      guidance += ` When your work is complete, release the task and it will advance to '${exitsTo}'.`;
    } else {
      guidance += ` When your work is complete, release the task.`;
    }

    return c.json({
      success: true,
      story: story ? { id: story.id, title: story.title, description: story.description } : undefined,
      task: {
        id: task.id, storyId: task.storyId, title: task.title,
        description: task.description, status: targetStatus,
        context: previousResults || undefined,
        comments: comments.length > 0 ? comments : undefined,
      },
      stateContext: {
        entered: targetStatus,
        exitsTo: exitsTo || undefined,
        guidance,
        exitInstructions: exitsTo ? getInstructionsMarkdown(targetStatus, exitsTo, taskId) : undefined,
      },
      instructions: getInstructionsMarkdown(fromStatus, targetStatus, taskId),
    });
  });

  // ─── Release ───────────────────────────────────────────────────────

  app.post("/api/agents/release/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; result?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const assignment = store.getAssignment(taskId);
    if (!assignment || assignment.memberId !== body.agentId) {
      return c.json({ success: false, error: "Task not claimed by this agent" }, 403);
    }

    const wf = store.getWorkflowForTask(taskId);
    const fromStatus = task.status;

    const transitions = wf.transitions[task.status] || {};
    const nextStates = Object.entries(transitions);
    let targetStatus: string | null = null;
    for (const [toState, perm] of nextStates) {
      if (perm === "teammate" || perm === "any") { targetStatus = toState; break; }
    }
    if (!targetStatus && nextStates.length > 0) targetStatus = nextStates[0]![0];

    if (targetStatus) {
      store.updateTaskStatus(taskId, targetStatus, body.result);
    } else if (body.result) {
      store.updateTaskStatus(taskId, task.status, body.result);
    }

    store.releaseTask(taskId);
    store.updateMemberStatus(body.agentId, "idle");

    const doneState = getDoneState(wf);
    return c.json({
      success: true,
      newStatus: targetStatus || task.status,
      completed: (targetStatus || task.status) === doneState,
      instructions: targetStatus ? getInstructionsMarkdown(fromStatus, targetStatus, taskId) : undefined,
    });
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
        return { id: m.id, name: m.name, cwd: m.cwd, hostId: m.hostId, status: m.status, currentTask: assignment?.taskId || null, lastHeartbeat: m.lastHeartbeat };
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

  // ─── Spawn Requests ────────────────────────────────────────────────

  app.post("/api/spawn-requests", async (c) => {
    const body = await c.req.json() as { hostId?: string; cwd?: string; storyId?: string; reason?: string };
    if (!body.hostId || typeof body.hostId !== "string") return c.json({ success: false, error: "Field 'hostId' is required" }, 400);
    const request = store.createSpawnRequest(body.hostId, body.cwd, body.storyId, body.reason);
    return c.json({ success: true, request }, 201);
  });

  app.get("/api/spawn-requests", (c) => {
    const hostId = c.req.query("hostId");
    if (!hostId) return c.json({ requests: [] });
    return c.json({ requests: store.getSpawnRequests(hostId) });
  });

  app.post("/api/spawn-requests/:id/ack", (c) => {
    const id = c.req.param("id");
    const success = store.ackSpawnRequest(id);
    if (!success) return c.json({ success: false, error: "Request not found or already acknowledged" }, 404);
    return c.json({ success: true });
  });
}

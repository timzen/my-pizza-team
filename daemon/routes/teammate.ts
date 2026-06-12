/**
 * daemon/routes/teammate.ts — Old-style teammate routes (pi-pizza-team extension).
 *
 * Handles the legacy teammate protocol: next-task, claim, status update,
 * team join/heartbeat/list. These are used by the pi-pizza-team Pi extension's
 * teammate loop (as opposed to the newer /api/agents/* protocol).
 */

import type { RouteContext } from "./types.ts";
import { getDoneState } from "../../shared/types.ts";
import type {
  NextTaskResponse, ClaimRequest, ClaimResponse,
  StatusUpdateRequest, StatusUpdateResponse,
  JoinRequest, JoinResponse, HeartbeatRequest, TeamResponse,
} from "../../shared/protocol.ts";

export function registerTeammateRoutes(ctx: RouteContext): void {
  const { app, store, config, isPaused, getInstructionsMarkdown } = ctx;

  app.get("/api/next-task", (c) => {
    const memberId = c.req.query("memberId");
    if (!memberId || isPaused()) return c.json({ task: null } satisfies NextTaskResponse);

    const member = store.getMember(memberId);
    const task = store.getNextAvailableTask(member?.cwd);
    if (!task) return c.json({ task: null } satisfies NextTaskResponse);

    const storyTasks = store.getTasksForStory(task.storyId);
    const previousResults = storyTasks.filter(t => t.seq < task.seq && t.result).map(t => `[${t.title}]: ${t.result}`).join("\n\n");
    const wf = store.getWorkflowForStory(task.storyId);
    return c.json({ task: { id: task.id, storyId: task.storyId, title: task.title, description: task.description, context: previousResults || undefined, workflow: wf } } satisfies NextTaskResponse);
  });

  app.post("/api/tasks/:taskId/claim", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as ClaimRequest;
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: "Task not found" } satisfies ClaimResponse, 404);

    const workflow = store.getWorkflowForTask(taskId);
    const transitions = workflow.transitions[task.status] || {};
    let targetStatus: string | null = null;
    for (const [toState, perm] of Object.entries(transitions)) {
      if (perm === "teammate" || perm === "any") { targetStatus = toState; break; }
    }
    if (!targetStatus) {
      return c.json({ success: false, error: `No valid teammate transition from "${task.status}"` } satisfies ClaimResponse, 400);
    }

    const success = store.claimTask(taskId, body.memberId);
    if (success) {
      const fromStatus = task.status;
      store.updateTaskStatus(taskId, targetStatus);
      store.updateMemberStatus(body.memberId, "working");
      return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, targetStatus, taskId) } satisfies ClaimResponse);
    }
    return c.json({ success: false, error: "Task already claimed" } satisfies ClaimResponse);
  });

  app.post("/api/tasks/:taskId/status", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as StatusUpdateRequest;
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies StatusUpdateResponse, 404);
    const fromStatus = task.status;
    const check = store.canTransition(taskId, body.status, body.actor);
    if (!check.ok) return c.json({ success: false, error: check.error } satisfies StatusUpdateResponse, 403);

    store.updateTaskStatus(taskId, body.status, body.result);
    const wf = store.getWorkflowForTask(taskId);
    const doneState = getDoneState(wf);
    if (body.status === doneState && body.memberId) {
      store.releaseTask(taskId);
      store.updateMemberStatus(body.memberId, "idle");
    }
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies StatusUpdateResponse);
  });

  // ─── Team membership ───────────────────────────────────────────────

  app.post("/api/team/join", async (c) => {
    const body = (await c.req.json()) as JoinRequest;
    store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow, body.hostId);
    return c.json({ success: true, config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), workflow: store.getWorkflows()[config.defaultWorkflow] } } satisfies JoinResponse);
  });

  app.post("/api/team/heartbeat", async (c) => {
    const body = (await c.req.json()) as HeartbeatRequest;
    store.heartbeat(body.id, body.status);
    return c.json({ ok: true });
  });

  app.get("/api/team", (c) => {
    const members = store.getMembers();
    const response: TeamResponse = { members: members.map(m => { const a = store.getAssignmentForMember(m.id); return { id: m.id, name: m.name, status: m.status, currentTask: a?.taskId || null, tmuxWindow: m.tmuxWindow, lastHeartbeat: m.lastHeartbeat }; }) };
    return c.json(response);
  });
}

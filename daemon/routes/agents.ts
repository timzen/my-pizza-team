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
import { getClaimTarget, getReleaseTarget, getExitState } from "../workflow-engine.ts";
import { DEFAULT_WORK_MODE, type Capabilities, type WorkMode } from "../../shared/types.ts";

export function registerAgentRoutes(ctx: RouteContext): void {
  const { app, store, config, isPaused, getInstructionsMarkdown } = ctx;

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

    const wf = store.getWorkflowForTask(taskId);
    const claim = getClaimTarget(wf, task.status);
    if (!claim) {
      return c.json({ success: false, error: `No valid teammate transition from "${task.status}"` }, 400);
    }

    const success = store.claimTask(taskId, body.agentId);
    if (!success) return c.json({ success: false, error: "Task already claimed" }, 409);

    const { targetStatus } = claim;
    const fromStatus = task.status;
    if (claim.transitions) {
      store.updateTaskStatus(taskId, targetStatus);
    }
    store.updateMemberStatus(body.agentId, "working");

    // Determine what state the task will exit to on release
    const exitsTo = getExitState(wf, targetStatus);

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

    // Hint about available memory if the story has categories
    const storyCategories = story?.categories || [];
    const wfCategories = wf.categories || [];
    const allCategories = [...new Set([...storyCategories, ...wfCategories])];
    if (allCategories.length > 0) {
      guidance += ` There are knowledge base notes available in categories: ${allCategories.join(", ")}. Use search_memory if you need additional context.`;
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
    const release = getReleaseTarget(wf, task.status);

    if (release) {
      store.updateTaskStatus(taskId, release.targetStatus, body.result);
    } else if (body.result) {
      store.updateTaskStatus(taskId, task.status, body.result);
    }

    store.releaseTask(taskId);
    store.updateMemberStatus(body.agentId, "idle");

    const newStatus = release?.targetStatus || task.status;
    return c.json({
      success: true,
      newStatus,
      completed: release?.completed || false,
      instructions: release ? getInstructionsMarkdown(fromStatus, release.targetStatus, taskId) : undefined,
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
}

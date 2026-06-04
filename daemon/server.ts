/**
 * daemon/server.ts — HTTP API server for the team lead (Deno port).
 *
 * Serves the REST API for teammates and the lead. Built with Hono on Deno.serve().
 * Ported from pi-pizza-team/src/lead/server.ts, minus the web UI assets
 * (those will be added separately).
 *
 * Key behaviors:
 * - Enforces workflow permissions on status updates (403 if unauthorized)
 * - Task distribution can be paused/resumed via /api/control/* endpoints
 * - Transition instructions are returned on status changes
 */

import { Hono } from "hono";
import { Store } from "./store.ts";
import { getDoneState, getInitialState, slugify, type TeamConfig, type WorkflowConfig } from "../shared/types.ts";
import type {
  StatusResponse, StoriesResponse, NextTaskResponse, ClaimRequest, ClaimResponse,
  StatusUpdateRequest, StatusUpdateResponse, PostMessageRequest, PostMessageResponse,
  MessagesResponse, JoinRequest, JoinResponse, HeartbeatRequest, TeamResponse,
  CreateStoryRequest, CreateStoryResponse, CreateTaskRequest, CreateTaskResponse,
  UpdateTaskRequest, UpdateTaskResponse, UpdateStoryRequest, UpdateStoryResponse,
  DeleteTaskResponse, MoveTaskRequest, MoveTaskResponse, TokenUsageRequest,
  TokenUsageResponse, DeleteStoryResponse, ArchiveStoryResponse, ArchivedStoriesResponse,
} from "../shared/protocol.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";
import { resolveDistDir, staticMiddleware } from "./static.ts";

// Cost per 1M tokens (input, output) for common models
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "o3": { input: 10.0, output: 40.0 },
  "o3-mini": { input: 1.10, output: 4.40 },
};

function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  let costs = MODEL_COSTS[model];
  if (!costs) {
    const key = Object.keys(MODEL_COSTS).find(k => model.startsWith(k) || model.includes(k));
    costs = key ? MODEL_COSTS[key] : { input: 3.0, output: 15.0 };
  }
  const c = costs ?? { input: 3.0, output: 15.0 };
  return (inputTokens * c.input + outputTokens * c.output) / 1_000_000;
}

/** Validate that an ID is safe for use in filesystem paths */
function isSafeId(id: string): boolean {
  if (!id || id.length > 100) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  if (id.startsWith(".") || id.startsWith("-")) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

/** Build the Hono app with all API routes wired to the store */
export function buildApp(store: Store, config: TeamConfig, teamDir: string): Hono {
  const app = new Hono();
  let paused = false;

  // Serve static UI files if dist directory exists
  const distDir = resolveDistDir();
  if (distDir) {
    app.use("*", staticMiddleware(distDir));
  }

  /** Assemble transition instructions into markdown */
  function getInstructionsMarkdown(fromStatus: string, toStatus: string, taskId?: string): string | undefined {
    let workflowName: string | undefined;
    if (taskId) {
      const task = store.getTask(taskId);
      if (task) {
        const story = store.getStory(task.storyId);
        workflowName = story?.workflow || config.defaultWorkflow;
      }
    }
    const { exitInstructions, enterInstructions } = store.getTransitionInstructions(fromStatus, toStatus, workflowName);
    const parts: string[] = [];
    if (exitInstructions) parts.push(`## Transition: leaving "${fromStatus}"\n\n${exitInstructions}`);
    if (enterInstructions) parts.push(`## Transition: entering "${toStatus}"\n\n${enterInstructions}`);
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
  }

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", service: "my-pizza-team" }));

  // GET /api/status
  app.get("/api/status", (c) => {
    const stories = store.getStories();
    const allTasks: Record<string, number> = {};
    let totalTasks = 0;
    for (const story of stories) {
      for (const task of store.getTasksForStory(story.id)) {
        allTasks[task.status] = (allTasks[task.status] || 0) + 1;
        totalTasks++;
      }
    }
    const members = store.getMembers();
    const inbox = store.getInboxTasks();
    const response: StatusResponse = {
      running: true,
      stories: { total: stories.length, open: stories.filter(s => s.status === "open").length, done: stories.filter(s => s.status === "done").length },
      tasks: { total: totalTasks, byStatus: allTasks },
      members: { total: members.length, working: members.filter(m => m.status === "working").length, idle: members.filter(m => m.status === "idle").length },
      inbox: inbox.length,
      defaultWorkflow: config.defaultWorkflow,
      workflows: store.getWorkflows(),
      workflow: store.getWorkflows()[config.defaultWorkflow],
    };
    return c.json(response);
  });

  // GET /api/stories
  app.get("/api/stories", (c) => {
    const stories = store.getStories();
    const response: StoriesResponse = {
      stories: stories.map(story => {
        const tasks = store.getTasksForStory(story.id);
        return {
          id: story.id, title: story.title, description: story.description,
          status: story.status, dependsOn: story.dependsOn,
          ready: store.isStoryReady(story.id), dir: story.dir,
          workflow: story.workflow, categories: story.categories,
          tasks: tasks.map(task => {
            const assignment = store.getAssignment(task.id);
            const tokenSummary = store.getTokenUsageSummary(task.id);
            return { id: task.id, seq: task.seq, title: task.title, status: task.status, description: task.description, assignee: assignment?.memberId || null, hasMessages: store.hasUnreadMessages(task.id), tokenUsage: tokenSummary || undefined };
          }),
        };
      }),
    };
    return c.json(response);
  });

  // POST /api/stories
  app.post("/api/stories", async (c) => {
    const body = (await c.req.json()) as CreateStoryRequest;
    if (!body.id || typeof body.id !== "string") return c.json({ success: false, error: "Field 'id' is required" } satisfies CreateStoryResponse, 400);
    if (!isSafeId(body.id)) return c.json({ success: false, error: "Invalid story ID" } satisfies CreateStoryResponse, 400);
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateStoryResponse, 400);
    if (!body.description || typeof body.description !== "string") return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateStoryResponse, 400);
    if (store.hasStory(body.id)) return c.json({ success: false, error: `Story '${body.id}' already exists` } satisfies CreateStoryResponse, 409);

    const { story, tasks } = store.createStory(body.id, body.title, body.description, body.status || "open", body.dependsOn || [], body.tasks, body.dir, body.workflow, body.categories);
    return c.json({ success: true, story: { id: story.id, title: story.title, description: story.description, status: story.status, dependsOn: story.dependsOn, ready: store.isStoryReady(story.id), dir: story.dir, workflow: story.workflow, categories: story.categories, tasks: tasks.map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, assignee: null, hasMessages: false })) } } satisfies CreateStoryResponse, 201);
  });

  // PUT /api/stories/:id
  app.put("/api/stories/:id", async (c) => {
    const storyId = c.req.param("id");
    const body = (await c.req.json()) as UpdateStoryRequest;
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies UpdateStoryResponse, 404);
    store.updateStoryDetails(storyId, { title: body.title, description: body.description, status: body.status, dependsOn: body.dependsOn, dir: body.dir, workflow: body.workflow, categories: body.categories });
    return c.json({ success: true } satisfies UpdateStoryResponse);
  });

  // DELETE /api/stories/:id
  app.delete("/api/stories/:id", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies DeleteStoryResponse, 404);
    try { store.deleteStory(storyId); return c.json({ success: true } satisfies DeleteStoryResponse); }
    catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies DeleteStoryResponse, 400); }
  });

  // GET /api/next-task
  app.get("/api/next-task", (c) => {
    const memberId = c.req.query("memberId");
    if (!memberId || paused) return c.json({ task: null } satisfies NextTaskResponse);

    const member = store.getMember(memberId);
    const task = store.getNextAvailableTask(member?.cwd);
    if (!task) return c.json({ task: null } satisfies NextTaskResponse);

    const storyTasks = store.getTasksForStory(task.storyId);
    const previousResults = storyTasks.filter(t => t.seq < task.seq && t.result).map(t => `[${t.title}]: ${t.result}`).join("\n\n");
    const wf = store.getWorkflowForStory(task.storyId);
    return c.json({ task: { id: task.id, storyId: task.storyId, title: task.title, description: task.description, context: previousResults || undefined, workflow: wf } } satisfies NextTaskResponse);
  });

  // POST /api/tasks/:taskId/claim
  app.post("/api/tasks/:taskId/claim", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as ClaimRequest;
    const task = store.getTask(taskId);
    const success = store.claimTask(taskId, body.memberId);
    if (success) {
      const fromStatus = task?.status || "todo";
      store.updateTaskStatus(taskId, "in_progress");
      store.updateMemberStatus(body.memberId, "working");
      return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, "in_progress", taskId) } satisfies ClaimResponse);
    }
    return c.json({ success: false, error: "Task already claimed" } satisfies ClaimResponse);
  });

  // POST /api/tasks/:taskId/status
  app.post("/api/tasks/:taskId/status", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as StatusUpdateRequest;
    const task = store.getTask(taskId);
    const fromStatus = task?.status || "";
    const check = store.canTransition(taskId, body.status, body.actor);
    if (!check.ok) return c.json({ success: false, error: check.error } satisfies StatusUpdateResponse, 403);

    store.updateTaskStatus(taskId, body.status, body.result);
    const wf = task ? store.getWorkflowForTask(taskId) : null;
    const doneState = wf ? getDoneState(wf) : "done";
    if (body.status === doneState && body.memberId) {
      store.releaseTask(taskId);
      store.updateMemberStatus(body.memberId, "idle");
    }
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies StatusUpdateResponse);
  });

  // POST /api/tasks/:taskId/message
  app.post("/api/tasks/:taskId/message", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as PostMessageRequest;
    store.addMessage(taskId, body.from, body.body, body.attachments);
    return c.json({ success: true } satisfies PostMessageResponse);
  });

  // GET /api/tasks/:taskId/messages
  app.get("/api/tasks/:taskId/messages", (c) => {
    const taskId = c.req.param("taskId");
    return c.json({ messages: store.getMessages(taskId) } satisfies MessagesResponse);
  });

  // POST /api/tasks/:taskId/token-usage
  app.post("/api/tasks/:taskId/token-usage", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as TokenUsageRequest;
    if (typeof body.inputTokens !== "number" || typeof body.outputTokens !== "number" || !body.model) {
      return c.json({ success: false, error: "Fields inputTokens, outputTokens, model required" } satisfies TokenUsageResponse, 400);
    }
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies TokenUsageResponse, 404);
    const costUsd = estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
    store.addTokenUsage(taskId, body.inputTokens, body.outputTokens, body.model, costUsd);
    return c.json({ success: true, costUsd } satisfies TokenUsageResponse);
  });

  // POST /api/tasks/:taskId/mark-read
  app.post("/api/tasks/:taskId/mark-read", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
    store.markMessagesRead(taskId);
    return c.json({ success: true });
  });

  // POST /api/stories/:storyId/tasks
  app.post("/api/stories/:storyId/tasks", async (c) => {
    const storyId = c.req.param("storyId");
    const body = (await c.req.json()) as CreateTaskRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateTaskResponse, 400);
    if (!body.description) return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateTaskResponse, 400);
    const story = store.getStory(storyId);
    if (!story) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies CreateTaskResponse, 404);

    const existingTasks = store.getTasksForStory(storyId);
    const nextSeq = existingTasks.length > 0 ? Math.max(...existingTasks.map(t => t.seq)) + 1 : 1;
    const slug = slugify(body.title);
    const taskDirPath = path.join(story.dirPath, "tasks", `${String(nextSeq).padStart(2, "0")}-${slug}`);
    Deno.mkdirSync(taskDirPath, { recursive: true });

    const taskId = `${storyId}-${nextSeq}`;
    const wf = store.getWorkflowForStory(storyId);
    const initialStatus = getInitialState(wf);
    const taskData = { id: taskId, title: body.title, description: body.description, status: initialStatus, result: null };
    Deno.writeTextFileSync(path.join(taskDirPath, "task.json"), JSON.stringify(taskData, null, 2) + "\n");
    store.loadFromDisk();

    return c.json({ success: true, task: { id: taskId, seq: nextSeq, title: body.title, description: body.description, status: initialStatus } } satisfies CreateTaskResponse, 201);
  });

  // PUT /api/tasks/:taskId
  app.put("/api/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as UpdateTaskRequest;
    if (!body.title && !body.description) return c.json({ success: false, error: "At least one field required" } satisfies UpdateTaskResponse, 400);
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies UpdateTaskResponse, 404);
    store.updateTaskDetails(taskId, { title: body.title, description: body.description });
    return c.json({ success: true } satisfies UpdateTaskResponse);
  });

  // DELETE /api/tasks/:taskId
  app.delete("/api/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies DeleteTaskResponse, 404);
    store.deleteTask(taskId);
    return c.json({ success: true } satisfies DeleteTaskResponse);
  });

  // POST /api/tasks/:taskId/move
  app.post("/api/tasks/:taskId/move", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as MoveTaskRequest;
    if (!body.status) return c.json({ success: false, error: "Field 'status' is required" } satisfies MoveTaskResponse, 400);
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies MoveTaskResponse, 404);
    const check = store.canTransition(taskId, body.status, "lead");
    if (!check.ok) return c.json({ success: false, error: check.error } satisfies MoveTaskResponse, 403);
    const fromStatus = task.status;
    store.updateTaskStatus(taskId, body.status);
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies MoveTaskResponse);
  });

  // POST /api/team/join
  app.post("/api/team/join", async (c) => {
    const body = (await c.req.json()) as JoinRequest;
    store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow);
    return c.json({ success: true, config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), workflow: store.getWorkflows()[config.defaultWorkflow] } } satisfies JoinResponse);
  });

  // POST /api/team/heartbeat
  app.post("/api/team/heartbeat", async (c) => {
    const body = (await c.req.json()) as HeartbeatRequest;
    store.heartbeat(body.id, body.status);
    return c.json({ ok: true });
  });

  // GET /api/team
  app.get("/api/team", (c) => {
    const members = store.getMembers();
    const response: TeamResponse = { members: members.map(m => { const a = store.getAssignmentForMember(m.id); return { id: m.id, name: m.name, status: m.status, currentTask: a?.taskId || null, tmuxWindow: m.tmuxWindow, lastHeartbeat: m.lastHeartbeat }; }) };
    return c.json(response);
  });

  // POST /api/stories/:id/archive
  app.post("/api/stories/:id/archive", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies ArchiveStoryResponse, 404);
    if (!store.isStoryArchivable(storyId)) return c.json({ success: false, error: "Not all tasks are done" } satisfies ArchiveStoryResponse, 400);
    try { store.archiveStory(storyId); const archived = store.getArchivedStories().find(s => s.id === storyId); return c.json({ success: true, synopsis: archived?.synopsis || "" } satisfies ArchiveStoryResponse); }
    catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies ArchiveStoryResponse, 400); }
  });

  // GET /api/archived
  app.get("/api/archived", (c) => {
    const stories = store.getArchivedStories();
    const response: ArchivedStoriesResponse = { stories: stories.map(s => { const ctx = store.getArchivedStoryContext(s.id); return { id: s.id, title: s.title, archivedAt: (ctx?.story?.archivedAt as string) || "", synopsis: s.synopsis }; }) };
    return c.json(response);
  });

  // --- Assistant Queue ---
  app.get("/api/assistant/queue", (c) => {
    const items = store.getAssistantQueue();
    return c.json({ items: items.map(item => ({ id: item.id, prompt: item.prompt, status: item.status, result: item.result || undefined, createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(), startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : undefined, completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : undefined })) });
  });

  app.post("/api/assistant/queue", async (c) => {
    const body = await c.req.json();
    if (!body.prompt || typeof body.prompt !== "string") return c.json({ success: false, error: "Field 'prompt' is required" }, 400);
    const item = store.enqueueAssistantItem(body.prompt);
    return c.json({ success: true, item }, 201);
  });

  app.get("/api/assistant/next", (c) => c.json({ item: store.getNextAssistantItem() }));

  app.post("/api/assistant/queue/:id/claim", (c) => {
    const success = store.claimAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not available" }, 409);
    return c.json({ success: true });
  });

  app.post("/api/assistant/queue/:id/complete", async (c) => {
    const body = await c.req.json();
    const success = store.completeAssistantItem(c.req.param("id"), body.result, body.status === "failed");
    if (!success) return c.json({ success: false, error: "Item not in processing state" }, 400);
    return c.json({ success: true });
  });

  app.delete("/api/assistant/queue/:id", (c) => {
    const success = store.deleteAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not found" }, 404);
    return c.json({ success: true });
  });

  // --- Assistant Notes ---
  app.get("/api/assistant/notes", (c) => c.json({ notes: store.getAssistantNotes() }));

  app.post("/api/assistant/notes", async (c) => {
    const body = await c.req.json();
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" }, 400);
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const note = store.saveAssistantNote(body.title, body.content, Array.isArray(body.categories) ? body.categories : []);
    return c.json({ success: true, note }, 201);
  });

  app.delete("/api/assistant/notes/:id", (c) => {
    const success = store.deleteAssistantNote(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Note not found" }, 404);
    return c.json({ success: true });
  });

  // --- Backlog ---
  app.get("/api/backlog", (c) => c.json({ stories: store.getBacklogStories() }));

  app.post("/api/stories/:id/backlog", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` }, 404);
    try { const moved = store.moveToBacklog(storyId); return c.json({ success: true, moved }); }
    catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
  });

  app.post("/api/backlog/:id/restore", (c) => {
    try { store.moveFromBacklog(c.req.param("id")); return c.json({ success: true }); }
    catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
  });

  // --- Control ---
  app.post("/api/control/pause", (c) => { paused = true; return c.json({ paused: true }); });
  app.post("/api/control/resume", (c) => { paused = false; return c.json({ paused: false }); });

  // --- Config ---
  app.get("/api/config", (c) => c.json({ ...config, workflows: store.getWorkflows() }));

  return app;
}

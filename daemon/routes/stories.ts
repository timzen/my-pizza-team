/**
 * daemon/routes/stories.ts — Story CRUD, archive, and backlog routes.
 *
 * Used by the web UI and leader tools for managing the story lifecycle:
 * creating, editing, deleting, archiving, and backlogging stories.
 */

import type { RouteContext } from "./types.ts";
import { DONE_STATE } from "../../shared/types.ts";
import type {
  CreateStoryRequest, CreateStoryResponse, UpdateStoryRequest, UpdateStoryResponse,
  DeleteStoryResponse, ArchiveStoryResponse, ArchivedStoriesResponse,
} from "../../shared/protocol.ts";

/** Validate that an ID is safe for use in filesystem paths */
function isSafeId(id: string): boolean {
  if (!id || id.length > 100) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  if (id.startsWith(".") || id.startsWith("-")) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

export function registerStoryRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/stories", (c) => {
    const stories = store.getStories();
    return c.json({
      stories: stories.map(story => {
        const tasks = store.getTasksForStory(story.id);
        return {
          id: story.id, title: story.title, description: story.description,
          status: story.status, dependsOn: story.dependsOn,
          ready: store.isStoryReady(story.id), requirements: story.requirements,
          directory: story.directory,
          paused: story.paused, workflow: story.workflow, context: story.context,
          tasks: tasks.map(task => {
            const assignment = store.getAssignment(task.id);
            const tokenSummary = store.getTokenUsageSummary(task.id);
            return { id: task.id, seq: task.seq, title: task.title, status: task.status, substatus: task.substatus, description: task.description, context: task.context, assignee: assignment?.memberId || null, tokenUsage: tokenSummary || undefined };
          }),
        };
      }),
    });
  });

  app.post("/api/stories", async (c) => {
    const body = (await c.req.json()) as CreateStoryRequest;
    if (!body.id || typeof body.id !== "string") return c.json({ success: false, error: "Field 'id' is required" } satisfies CreateStoryResponse, 400);
    if (!isSafeId(body.id)) return c.json({ success: false, error: "Invalid story ID" } satisfies CreateStoryResponse, 400);
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateStoryResponse, 400);
    if (!body.description || typeof body.description !== "string") return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateStoryResponse, 400);
    if (!body.workflow || typeof body.workflow !== "string") return c.json({ success: false, error: "Field 'workflow' is required" } satisfies CreateStoryResponse, 400);
    if (!store.getWorkflows()[body.workflow]) return c.json({ success: false, error: `Workflow '${body.workflow}' not found` } satisfies CreateStoryResponse, 400);
    if (store.hasStory(body.id)) return c.json({ success: false, error: `Story '${body.id}' already exists` } satisfies CreateStoryResponse, 409);

    const requirements = body.requirements;

    const { story, tasks } = store.createStory(body.id, body.title, body.description, body.status || "open", body.dependsOn || [], body.tasks, requirements, body.workflow, body.context, body.paused, body.directory);
    return c.json({ success: true, story: { id: story.id, title: story.title, description: story.description, status: story.status, dependsOn: story.dependsOn, ready: store.isStoryReady(story.id), requirements: story.requirements, directory: story.directory, paused: story.paused, workflow: story.workflow, context: story.context, tasks: tasks.map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, assignee: null })) } } satisfies CreateStoryResponse, 201);
  });

  app.put("/api/stories/:id", async (c) => {
    const storyId = c.req.param("id");
    const body = (await c.req.json()) as UpdateStoryRequest;
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies UpdateStoryResponse, 404);
    store.updateStoryDetails(storyId, { title: body.title, description: body.description, status: body.status, dependsOn: body.dependsOn, requirements: body.requirements, paused: body.paused, workflow: body.workflow, context: body.context, directory: body.directory });
    return c.json({ success: true } satisfies UpdateStoryResponse);
  });

  app.delete("/api/stories/:id", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies DeleteStoryResponse, 404);
    try { store.deleteStory(storyId); return c.json({ success: true } satisfies DeleteStoryResponse); }
    catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies DeleteStoryResponse, 400); }
  });

  // ─── Archive ───────────────────────────────────────────────────────

  app.post("/api/stories/:id/archive", async (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies ArchiveStoryResponse, 404);
    const body = await c.req.json().catch(() => ({})) as { force?: boolean };
    if (!body.force && !store.isStoryArchivable(storyId)) return c.json({ success: false, error: "Not all tasks are done. Use force:true to archive anyway." } satisfies ArchiveStoryResponse, 400);
    try {
      if (body.force && !store.isStoryArchivable(storyId)) {
        const tasks = store.getTasksForStory(storyId);
        for (const task of tasks) {
          if (task.status !== DONE_STATE) store.updateTaskStatus(task.id, DONE_STATE);
        }
      }
      store.archiveStory(storyId);
      const archived = store.getArchivedStories().find(s => s.id === storyId);
      return c.json({ success: true, synopsis: archived?.synopsis || "" } satisfies ArchiveStoryResponse);
    } catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies ArchiveStoryResponse, 400); }
  });

  app.get("/api/archived", (c) => {
    const stories = store.getArchivedStories();
    const response: ArchivedStoriesResponse = { stories: stories.map(s => { const ctx2 = store.getArchivedStoryContext(s.id); return { id: s.id, title: s.title, archivedAt: (ctx2?.story?.archivedAt as string) || "", synopsis: s.synopsis }; }) };
    return c.json(response);
  });

  // ─── Backlog ───────────────────────────────────────────────────────

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
}

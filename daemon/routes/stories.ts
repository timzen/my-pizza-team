/**
 * daemon/routes/stories.ts — Story CRUD, pending/activate, and archive routes.
 *
 * Used by the web UI and leader tools for managing the story lifecycle
 * (pending ⇄ active → archived): creating, editing, deleting, making pending,
 * activating, and archiving stories. Pending replaced the old `paused` flag and
 * the backlog (docs/DESIGN.md "Pending: Write, Review, Activate"); `paused` is
 * still accepted in requests as a deprecated alias for one release.
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import { DONE_STATE } from "../../shared/types.ts";
import { requestsPending } from "./work-defs.ts";
import { contextFieldRefusal } from "./personas.ts";
import type {
  CreateStoryRequest, CreateStoryResponse, UpdateStoryRequest, UpdateStoryResponse,
  DeleteStoryResponse, ArchiveStoryResponse, ArchivedStoriesResponse, SetStoryPendingResponse, StoriesResponse,
} from "../../shared/protocol.ts";

/**
 * The story-level pending flag a create/update request asks for: `pending`, or
 * the deprecated `paused` alias (an older Pi extension still sends it). Returns
 * undefined when neither is present, so an update leaves the story's state alone.
 */
export function requestsStoryPending(body: { pending?: unknown; paused?: unknown }): boolean | undefined {
  if (typeof body.pending === "boolean") return body.pending;
  if (typeof body.paused === "boolean") return body.paused;
  return undefined;
}

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
          ready: store.isStoryReady(story.id),
          directory: story.directory,
          pending: story.pending, workflow: story.workflow,
          tasks: tasks.map(task => {
            const assignment = store.getAssignment(task.id);
            const tokenSummary = store.getTokenUsageSummary({ workDefId: task.id });
            const activeItem = store.getActiveWorkItem(task.id);
            return { id: task.id, seq: task.seq, title: task.title, status: task.status, pending: store.isPending(task.id), workItemState: activeItem?.state ?? null, description: task.description, assignee: assignment?.memberId || null, tokenUsage: tokenSummary || undefined };
          }),
        };
      }),
    } satisfies StoriesResponse);
  });

  app.post("/api/stories", async (c) => {
    const body = (await readBody(c)) as CreateStoryRequest;
    if (!body.id || typeof body.id !== "string") return fail(c, 400, "Field 'id' is required");
    if (!isSafeId(body.id)) return fail(c, 400, "Invalid story ID");
    if (!body.title || typeof body.title !== "string") return fail(c, 400, "Field 'title' is required");
    if (!body.description || typeof body.description !== "string") return fail(c, 400, "Field 'description' is required");
    if (!body.workflow || typeof body.workflow !== "string") return fail(c, 400, "Field 'workflow' is required");
    if (!store.getWorkflows()[body.workflow]) return fail(c, 400, `Workflow '${body.workflow}' not found`);
    if (store.hasStory(body.id)) return fail(c, 409, `Story '${body.id}' already exists`);
    if (store.isStoryIdTaken(body.id)) return fail(c, 409, `Story '${body.id}' is archived; pick another id`);
    const refused = contextFieldRefusal(body) ?? (Array.isArray(body.tasks) ? body.tasks.map((t) => contextFieldRefusal(t)).find(Boolean) : null);
    if (refused) return fail(c, 400, refused);

    const { story, tasks } = store.createStory(body.id, body.title, body.description, body.status || "open", body.dependsOn || [], Array.isArray(body.tasks) ? body.tasks.map((t) => ({ title: t.title, description: t.description, pending: requestsPending(t) })) : undefined, body.workflow, requestsStoryPending(body), body.directory);
    return c.json({ success: true, story: { id: story.id, title: story.title, description: story.description, status: story.status, dependsOn: story.dependsOn, ready: store.isStoryReady(story.id), directory: story.directory, pending: story.pending, workflow: story.workflow, tasks: tasks.map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, pending: store.isPending(t.id), assignee: null })) } } satisfies CreateStoryResponse, 201);
  });

  app.put("/api/stories/:id", async (c) => {
    const storyId = c.req.param("id");
    const body = (await readBody(c)) as UpdateStoryRequest;
    if (!store.getStory(storyId)) return fail(c, 404, `Story "${storyId}" not found`);
    const refused = contextFieldRefusal(body);
    if (refused) return fail(c, 400, refused);
    store.updateStoryDetails(storyId, { title: body.title, description: body.description, status: body.status, dependsOn: body.dependsOn, pending: requestsStoryPending(body), workflow: body.workflow, directory: body.directory });
    return c.json({ success: true } satisfies UpdateStoryResponse);
  });

  app.delete("/api/stories/:id", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return fail(c, 404, `Story "${storyId}" not found`);
    try { store.deleteStory(storyId); return c.json({ success: true } satisfies DeleteStoryResponse); }
    catch (e) { return fail(c, 400, (e as Error).message); }
  });

  // ─── Archive ───────────────────────────────────────────────────────

  app.post("/api/stories/:id/archive", async (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return fail(c, 404, `Story "${storyId}" not found`);
    const body = await readBody(c) as { force?: boolean };
    if (!body.force && !store.isStoryArchivable(storyId)) return fail(c, 400, "Not all tasks are done. Use force:true to archive anyway.");
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
    } catch (e) { return fail(c, 400, (e as Error).message); }
  });

  app.get("/api/archived", (c) => {
    const stories = store.getArchivedStories();
    const response: ArchivedStoriesResponse = { stories: stories.map(s => { const ctx2 = store.getArchivedStoryContext(s.id); return { id: s.id, title: s.title, archivedAt: (ctx2?.story?.archivedAt as string) || "", synopsis: s.synopsis }; }) };
    return c.json(response);
  });

  // ─── Pending ⇄ Active ──────────────────────────────────────────────
  // The same as PUT { pending }, as explicit verbs (mirrors the WorkDef
  // /activate route). Pending is reversible for stories.

  app.post("/api/stories/:id/pending", (c) => {
    const storyId = c.req.param("id");
    if (!store.setStoryPending(storyId, true)) return fail(c, 404, `Story "${storyId}" not found`);
    return c.json({ success: true, pending: true } satisfies SetStoryPendingResponse);
  });

  app.post("/api/stories/:id/activate", (c) => {
    const storyId = c.req.param("id");
    if (!store.setStoryPending(storyId, false)) return fail(c, 404, `Story "${storyId}" not found`);
    return c.json({ success: true, pending: false } satisfies SetStoryPendingResponse);
  });
}

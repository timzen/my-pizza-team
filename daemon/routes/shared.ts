/**
 * daemon/routes/shared.ts — Health, status, config, control, hosts, and workflow routes.
 *
 * These routes are used by all consumers: the web UI, leader tools,
 * and agents. Provides system-level endpoints for monitoring, config
 * management, and workflow definitions.
 */

import type { RouteContext } from "./types.ts";
import type { WorkflowConfig } from "../../shared/types.ts";
import { DEFAULT_NOUNS } from "../../shared/types.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";

export function registerSharedRoutes(ctx: RouteContext): void {
  const { app, store, config, teamDir, isPaused, setPaused, startedAt } = ctx;

  // ─── Health ────────────────────────────────────────────────────────

  app.get("/health", async (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const members = store.getMembers();
    const onlineAgents = members.filter(m => m.status === "working" || m.status === "idle").length;
    const queue = store.getAssistantQueue();
    const queueDepth = queue.filter(item => item.status === "pending").length;
    const mem = Deno.memoryUsage();

    let lastCommitTime: string | null = null;
    try {
      const cmd = new Deno.Command("git", {
        args: ["log", "-1", "--format=%aI"],
        cwd: teamDir,
        stdout: "piped",
        stderr: "null",
      });
      const result = await cmd.output();
      if (result.code === 0) {
        const output = new TextDecoder().decode(result.stdout).trim();
        if (output) lastCommitTime = output;
      }
    } catch { /* git not available */ }

    return c.json({
      status: "ok",
      service: "my-pizza-team",
      uptime: uptimeSeconds,
      agents: onlineAgents,
      queueDepth,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      lastCommitTime,
    });
  });

  // ─── Status ────────────────────────────────────────────────────────

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
    return c.json({
      running: true,
      stories: { total: stories.length, open: stories.filter(s => s.status === "open").length, done: stories.filter(s => s.status === "done").length },
      tasks: { total: totalTasks, byStatus: allTasks },
      members: { total: members.length, working: members.filter(m => m.status === "working").length, idle: members.filter(m => m.status === "idle").length },
      defaultWorkflow: config.defaultWorkflow,
      workflows: store.getWorkflows(),
      workflow: store.getWorkflows()[config.defaultWorkflow],
    });
  });

  // ─── Control ───────────────────────────────────────────────────────

  app.post("/api/control/pause", (c) => { setPaused(true); return c.json({ paused: true }); });
  app.post("/api/control/resume", (c) => { setPaused(false); return c.json({ paused: false }); });


  // ─── Config ────────────────────────────────────────────────────────

  app.get("/api/config", (c) => c.json({ ...config, workflows: store.getWorkflows(), defaultNouns: DEFAULT_NOUNS }));

  app.put("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.workflows || typeof body.workflows !== "object" || Object.keys(body.workflows).length === 0) {
        return c.json({ success: false, error: "At least one workflow is required" }, 400);
      }
      if (!body.defaultWorkflow || !body.workflows[body.defaultWorkflow]) {
        return c.json({ success: false, error: "defaultWorkflow must reference an existing workflow" }, 400);
      }

      config.port = body.port || config.port;
      config.tmuxSession = body.tmuxSession || config.tmuxSession;
      config.maxTeammates = body.maxTeammates || config.maxTeammates;
      config.defaultWorkflow = body.defaultWorkflow;

      for (const [name, wf] of Object.entries(body.workflows)) {
        store.saveWorkflow(name, wf as WorkflowConfig);
      }
      store.reloadWorkflows();

      if (body.autosave) {
        config.autosave = {
          flushIntervalMinutes: body.autosave.flushIntervalMinutes || 30,
          commitIntervalHours: body.autosave.commitIntervalHours || 24,
          commitMessage: config.autosave.commitMessage,
          autoCommit: body.autosave.autoCommit !== false,
        };
      }
      if (body.teammates !== undefined) config.teammates = body.teammates;
      if (body.categories !== undefined) config.categories = body.categories;

      const configFile = path.join(teamDir, "config.json");
      const toWrite: Record<string, unknown> = {
        port: config.port,
        tmuxSession: config.tmuxSession,
        defaultWorkflow: config.defaultWorkflow,
        autosave: config.autosave,
        maxTeammates: config.maxTeammates,
      };
      if (config.teammates && Object.keys(config.teammates).length > 0) toWrite.teammates = config.teammates;
      if (config.categories && config.categories.length > 0) toWrite.categories = config.categories;
      if (config.recentCapabilities && Object.keys(config.recentCapabilities).length > 0) toWrite.recentCapabilities = config.recentCapabilities;
      Deno.writeTextFileSync(configFile, JSON.stringify(toWrite, null, 2) + "\n");

      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: (e as Error).message }, 400);
    }
  });

  // ─── Capabilities (recently used) ──────────────────────────────────

  // The map of capability name -> known values, auto-populated from story
  // requirements and agent registrations. See docs/DESIGN.md.
  app.get("/api/capabilities", (c) => c.json({ capabilities: store.getRecentCapabilities() }));

  app.post("/api/capabilities", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; value?: string };
    if (!body.name || typeof body.name !== "string") {
      return c.json({ success: false, error: "Field 'name' is required" }, 400);
    }
    store.addCapability(body.name, body.value);
    return c.json({ success: true, capabilities: store.getRecentCapabilities() });
  });

  // Remove a whole key, or just one value with ?value=<v> (query param avoids
  // path-encoding issues for directory paths).
  app.delete("/api/capabilities/:name", (c) => {
    const name = c.req.param("name");
    const value = c.req.query("value");
    const removed = store.removeCapability(name, value ?? undefined);
    if (!removed) return c.json({ success: false, error: "Capability or value not found" }, 404);
    return c.json({ success: true, capabilities: store.getRecentCapabilities() });
  });

  // ─── Hosts ─────────────────────────────────────────────────────────

  app.get("/api/hosts/:hostId", (c) => {
    const hostId = c.req.param("hostId");
    const hostConfig = config.hosts?.[hostId];
    return c.json({
      hostId,
      tmuxSession: hostConfig?.tmuxSession || config.tmuxSession,
      directories: store.getRecentCapabilities()["directory"] || [],
    });
  });

  // ─── Workflows ─────────────────────────────────────────────────────

  app.get("/api/workflows", (c) => {
    const workflows = store.getWorkflows();
    const summaries = Object.entries(workflows).map(([name, wf]) => {
      const transitionCount = Object.values(wf.transitions).reduce(
        (sum, t) => sum + Object.keys(t).length, 0
      );
      return { name, stateCount: wf.states.length, transitionCount, isDefault: name === config.defaultWorkflow };
    });
    return c.json(summaries);
  });

  app.get("/api/workflows/:name", (c) => {
    const name = c.req.param("name");
    const wf = store.getWorkflows()[name];
    if (!wf) return c.json({ error: `Workflow "${name}" not found` }, 404);
    return c.json(wf);
  });

  app.get("/api/workflows/:name/instructions/:filename", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    if (!store.getWorkflows()[name]) return c.json({ error: `Workflow "${name}" not found` }, 404);
    const filePath = path.join(teamDir, "workflows", name, `${filename}.md`);
    if (!existsSync(filePath)) return c.json({ error: `Instruction file "${filename}.md" not found` }, 404);
    return c.json({ content: Deno.readTextFileSync(filePath) });
  });

  app.put("/api/workflows/:name/instructions/:filename", async (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const body = await c.req.json() as { content?: string };
    if (typeof body.content !== "string") {
      return c.json({ success: false, error: "Field 'content' is required and must be a string" }, 400);
    }
    const wfDir = path.join(teamDir, "workflows", name);
    Deno.mkdirSync(wfDir, { recursive: true });
    Deno.writeTextFileSync(path.join(wfDir, `${filename}.md`), body.content);
    return c.json({ success: true });
  });
}

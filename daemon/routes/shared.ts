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
import { validateInstructionMarkdown } from "../workflow-lint.ts";
import { validateWorkflow } from "../workflow-engine.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";

export function registerSharedRoutes(ctx: RouteContext): void {
  const { app, store, config, teamDir, setPaused, isPaused, startedAt } = ctx;

  // ─── Health ────────────────────────────────────────────────────────

  app.get("/health", async (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const members = store.getMembers();
    const onlineAgents = members.filter(m => m.status === "working" || m.status === "idle").length;
    const queueDepth = store.getWorkItems({ states: ["READY"] }).total;
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
      // Surfaced for the menu bar app: the configured tmux session name and
      // whether a leader coordinator (a member named "leader") is connected.
      tmuxSession: config.tmuxSession,
      leaderPresent: members.some((m) => m.name === "leader" && m.status !== "offline"),
      // Hosts whose leader reported not-ready (e.g. expired credentials). While a
      // host is not ready, scheduled work destined for it is held (not failed).
      hostsNotReady: store.getAllHostReadiness().filter((h) => !h.ready),
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
      // Task distribution paused (control/pause)? The UI needs it to render the
      // pause toggle's real state and to explain why queued work isn't moving.
      paused: isPaused(),
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
      // 0 is meaningful ("spawn nothing"), so this can't use `||`.
      // `null` clears it back to the default (half of maxTeammates).
      if (body.minTeammates === null) {
        delete config.minTeammates;
      } else if (body.minTeammates !== undefined) {
        const min = Number(body.minTeammates);
        if (!Number.isInteger(min) || min < 0) {
          return c.json({ success: false, error: "minTeammates must be a non-negative integer" }, 400);
        }
        const max = config.maxTeammates ?? 0;
        config.minTeammates = max > 0 ? Math.min(min, max) : min;
      }
      config.defaultWorkflow = body.defaultWorkflow;

      for (const [name, wf] of Object.entries(body.workflows)) {
        const invalid = validateWorkflow(wf as WorkflowConfig);
        if (invalid) return c.json({ success: false, error: `Workflow "${name}": ${invalid}` }, 400);
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
      if (body.readinessProbe !== undefined) config.readinessProbe = body.readinessProbe || undefined;
      if (body.hosts !== undefined) config.hosts = body.hosts;

      // Store is the single config writer (it owns serializeConfig, so no field
      // this route doesn't know about — e.g. apiToken — is silently dropped).
      store.saveConfig();
      // A changed pool size takes effect now, not on the next heartbeat tick.
      store.reconcileTeammatePool();

      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: (e as Error).message }, 400);
    }
  });

  // ─── Teammate pool ─────────────────────────────────────────────────
  //
  // Team size is *declared*, not clicked: `minTeammates` is the number of
  // generalist teammates the daemon keeps online, reconciled by spawning
  // replacements when the pool dips (see Store.reconcileTeammatePool). These two
  // routes back the sidebar's team-size box; the same value also lives in
  // config.json, so it is applied at startup.

  app.get("/api/teammate-pool", (c) => c.json(store.getTeammatePool()));

  // `{ minTeammates: null }` clears the declaration → back to the default
  // (half of maxTeammates).
  app.put("/api/teammate-pool", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { minTeammates?: unknown };
    let stored: number | null;
    if (body.minTeammates === null) {
      stored = store.setMinTeammates(null);
    } else {
      const min = Number(body.minTeammates);
      stored = body.minTeammates !== undefined && Number.isFinite(min) ? store.setMinTeammates(min) : null;
    }
    if (stored === null) {
      return c.json({ success: false, error: "Field 'minTeammates' must be a non-negative integer" }, 400);
    }
    return c.json({ success: true, ...store.getTeammatePool() });
  });

  // ─── Hosts ─────────────────────────────────────────────────────────

  app.get("/api/hosts/:hostId", (c) => {
    const hostId = c.req.param("hostId");
    const hostConfig = config.hosts?.[hostId];
    return c.json({
      hostId,
      tmuxSession: hostConfig?.tmuxSession || config.tmuxSession,
      readinessProbe: hostConfig?.readinessProbe || config.readinessProbe || null,
      readiness: store.getHostReadiness(hostId) ?? null,
    });
  });

  // Report a host's readiness (its leader runs a probe — e.g. "are the shared
  // credentials on this box valid?"). A not-ready host holds scheduled enqueues
  // that would land on it until it recovers. See docs/ARCHITECTURE.md.
  app.post("/api/hosts/:hostId/readiness", async (c) => {
    const hostId = c.req.param("hostId");
    const body = await c.req.json().catch(() => ({})) as { ready?: boolean; reason?: string };
    if (typeof body.ready !== "boolean") {
      return c.json({ success: false, error: "Field 'ready' (boolean) is required" }, 400);
    }
    store.setHostReadiness(hostId, body.ready, body.reason);
    return c.json({ success: true });
  });

  app.get("/api/hosts-readiness", (c) => {
    return c.json({ hosts: store.getAllHostReadiness() });
  });

  // ─── Workflows ─────────────────────────────────────────────────────

  app.get("/api/workflows", (c) => {
    const workflows = store.getWorkflows();
    const summaries = Object.entries(workflows).map(([name, wf]) => {
      const agentCount = wf.states.filter((s) => s.type === "agent").length;
      return { name, stateCount: wf.states.length, agentCount, manualCount: wf.states.length - agentCount, isDefault: name === config.defaultWorkflow };
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
    // Lint before writing: block on errors (they would mangle the agent prompt),
    // pass warnings back on success so the editor can surface them.
    const { errors, warnings } = validateInstructionMarkdown(body.content);
    if (errors.length > 0) {
      return c.json({ success: false, error: errors.join(" "), errors, warnings }, 400);
    }
    const wfDir = path.join(teamDir, "workflows", name);
    Deno.mkdirSync(wfDir, { recursive: true });
    Deno.writeTextFileSync(path.join(wfDir, `${filename}.md`), body.content);
    return c.json({ success: true, warnings });
  });
}

/**
 * daemon/routes/shared.ts — Health, status, config, control, readiness, and workflow routes.
 *
 * These routes are used by all consumers: the web UI, leader tools,
 * and agents. Provides system-level endpoints for monitoring, config
 * management, and workflow definitions. `PUT /api/config` also takes the
 * feature toggles (validated by daemon/features.ts).
 */

import type { RouteContext } from "./types.ts";
import type { TeamConfig, WorkflowConfig } from "../../shared/types.ts";
import { DEFAULT_HARNESS, DEFAULT_NOUNS, isExperimentalHarness } from "../../shared/types.ts";
import { enabledFeatures, featureUsage, resolveFeaturesUpdate } from "../features.ts";
import { resolveTemplates } from "../spawner.ts";
import { externalSourceViews } from "./work-sources.ts";
import { validateInstructionMarkdown } from "../workflow-lint.ts";
import { validateWorkflow } from "../workflow-engine.ts";
import * as path from "node:path";
import { existsSync } from "node:fs";

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
      // The team's readiness when it is *not* ready (e.g. expired credentials),
      // else null. While not ready, scheduled work is held (not failed).
      notReady: store.getTeamReadiness()?.ready === false ? store.getTeamReadiness() : null,
      // Which path realizes spawns (P3-1), so `mpt doctor` can say rather than the
      // user discovering that nothing spawns.
      spawning: store.getSpawnCapability(),
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
      // Toolbar badges on the Pizza Team link (NavBar): WorkItems waiting to be
      // picked up, and finished ones not yet reviewed in the Inbox. Plain
      // COUNT(*)s so polling them costs nothing — the UI never fetches the lists.
      queuedCount: store.countWorkItems({ states: ["READY"] }),
      unreadInboxCount: store.countWorkItems({ states: ["COMPLETE", "FAILED"], read: false }),
      defaultWorkflow: config.defaultWorkflow,
      workflows: store.getWorkflows(),
      workflow: store.getWorkflows()[config.defaultWorkflow],
      // Which work-item kinds are on (defaults applied), so the nav, CLI and the
      // Pi tools can hide what the team has switched off. One flag per
      // toggleable Work Source (daemon/features.ts).
      features: enabledFeatures(store, config),
      // The registered external (pull-only) Work Sources, so the UI shows a
      // read-only Work tab per source — none, no tab.
      externalSources: externalSourceViews(store),
    });
  });

  // ─── Control ───────────────────────────────────────────────────────

  app.post("/api/control/pause", (c) => { setPaused(true); return c.json({ paused: true }); });
  app.post("/api/control/resume", (c) => { setPaused(false); return c.json({ paused: false }); });


  // ─── Config ────────────────────────────────────────────────────────

  // `features` is the resolved view (absent ⇒ all on), not the raw block.
  // `featureUsage` counts each kind's active items, so the Config page can say
  // "archive or delete 3 stories first" before a save is refused.
  app.get("/api/config", (c) => c.json({
    ...config, workflows: store.getWorkflows(), defaultNouns: DEFAULT_NOUNS, features: enabledFeatures(store, config),
    featureUsage: featureUsage(store),
  }));

  app.put("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.workflows || typeof body.workflows !== "object" || Object.keys(body.workflows).length === 0) {
        return c.json({ success: false, error: "At least one workflow is required" }, 400);
      }
      if (!body.defaultWorkflow || !body.workflows[body.defaultWorkflow]) {
        return c.json({ success: false, error: "defaultWorkflow must reference an existing workflow" }, 400);
      }
      // Harness settings are validated before anything is mutated, so a refused
      // save leaves the live config (which the spawner reads) untouched.
      const harnessSettings = resolveHarnessSettings(config, body);
      if ("error" in harnessSettings) return c.json({ success: false, error: harnessSettings.error }, 400);
      if (body.exclusiveDirectories != null && typeof body.exclusiveDirectories !== "boolean") {
        return c.json({ success: false, error: "exclusiveDirectories must be a boolean" }, 400);
      }
      // Feature toggles: validated (and the turn-off guard checked) up front too.
      const featureSettings = resolveFeaturesUpdate(config, body, store);
      if ("error" in featureSettings) return c.json({ success: false, error: featureSettings.error }, featureSettings.status);

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
      // One teammate per directory (default on). Live: getNextWorkItem and
      // claimWorkItem read the in-memory config on every poll. `null` = default.
      if (body.exclusiveDirectories === null) {
        delete config.exclusiveDirectories;
      } else if (body.exclusiveDirectories !== undefined) {
        config.exclusiveDirectories = body.exclusiveDirectories;
      }
      // Auto triage. A changed interval needs a daemon restart to re-arm the
      // timer; enabling/disabling and the quiet period take effect next sweep.
      if (body.triage !== undefined) {
        const t = (body.triage || {}) as { enabled?: unknown; intervalMinutes?: unknown; quietMinutes?: unknown };
        const minutes = (v: unknown, min: number) =>
          typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;
        if (t.intervalMinutes !== undefined && minutes(t.intervalMinutes, 1) === undefined) {
          return c.json({ success: false, error: "triage.intervalMinutes must be an integer >= 1" }, 400);
        }
        if (t.quietMinutes !== undefined && minutes(t.quietMinutes, 0) === undefined) {
          return c.json({ success: false, error: "triage.quietMinutes must be an integer >= 0" }, 400);
        }
        config.triage = {
          enabled: t.enabled !== false,
          ...(minutes(t.intervalMinutes, 1) !== undefined ? { intervalMinutes: t.intervalMinutes as number } : {}),
          ...(minutes(t.quietMinutes, 0) !== undefined ? { quietMinutes: t.quietMinutes as number } : {}),
        };
      }
      // Experimental harnesses + default harness (Config → Teammates). Live: the
      // spawner, the directive/register gates and the Spawn dialog all read this
      // in-memory config, so no restart is needed.
      // Feature toggles. Live: the gates in daemon/features.ts read this config
      // on every request.
      if (featureSettings.features) config.features = featureSettings.features;
      else delete config.features;
      config.experimental = harnessSettings.experimental;
      if (harnessSettings.defaultHarness) config.defaultHarness = harnessSettings.defaultHarness;
      else delete config.defaultHarness;

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

  // ─── Readiness ─────────────────────────────────────────────────────
  //
  // The daemon runs the optional probe itself (daemon/readiness.ts) — e.g. "are the
  // shared credentials on this box valid?" — and a harness may also report here. A
  // not-ready team *holds* scheduled enqueues rather than failing them, and the held
  // Schedule re-fires exactly once on recovery. Team-level: credential/VPN state
  // belongs to the machine the team runs on. See docs/ARCHITECTURE.md
  // "Scheduler readiness gating".

  app.post("/api/readiness", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ready?: boolean; reason?: string };
    if (typeof body.ready !== "boolean") {
      return c.json({ success: false, error: "Field 'ready' (boolean) is required" }, 400);
    }
    store.setTeamReadiness(body.ready, body.reason);
    return c.json({ success: true });
  });

  app.get("/api/readiness", (c) => {
    return c.json({ readiness: store.getTeamReadiness() ?? null });
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

/**
 * The `experimental` and `defaultHarness` a config PUT would leave in place, or why
 * it's refused.
 *
 * Absent fields keep their current value; `defaultHarness` of `""`, `null` or `"pi"`
 * means unset (Pi is the default anyway). A default must be a harness with a teammate
 * template (built-in or `harnesses.*`), and a non-Pi default needs
 * `experimental.harnesses` on — that combination would otherwise be saved and leave
 * the spawner refusing every default spawn.
 */
function resolveHarnessSettings(
  config: TeamConfig,
  body: { experimental?: unknown; defaultHarness?: unknown },
): { experimental: TeamConfig["experimental"]; defaultHarness: string | undefined } | { error: string } {
  let experimental = config.experimental;
  if (body.experimental !== undefined) {
    if (body.experimental === null || body.experimental === false) {
      experimental = undefined;
    } else if (typeof body.experimental !== "object" || Array.isArray(body.experimental)) {
      return { error: "experimental must be an object, e.g. { \"harnesses\": true }" };
    } else {
      const next = { ...(body.experimental as Record<string, unknown>) };
      if (next.harnesses !== undefined && typeof next.harnesses !== "boolean") {
        return { error: "experimental.harnesses must be a boolean" };
      }
      // `false` is the default; dropping it keeps config.json minimal.
      if (!next.harnesses) delete next.harnesses;
      experimental = Object.keys(next).length > 0 ? next as TeamConfig["experimental"] : undefined;
    }
  }

  let defaultHarness = config.defaultHarness;
  if (body.defaultHarness !== undefined) {
    const h = body.defaultHarness;
    if (h === null || h === "" || h === DEFAULT_HARNESS) {
      defaultHarness = undefined;
    } else if (typeof h !== "string" || !resolveTemplates(config)[h]?.teammate) {
      const known = Object.keys(resolveTemplates(config)).join(", ");
      return { error: `defaultHarness must be one of: ${known}` };
    } else {
      defaultHarness = h;
    }
  }

  if (isExperimentalHarness(defaultHarness) && !experimental?.harnesses) {
    return {
      error: `The default harness "${defaultHarness}" is experimental: turn on Experimental harnesses, ` +
        `or set the default harness back to pi.`,
    };
  }
  return { experimental, defaultHarness };
}

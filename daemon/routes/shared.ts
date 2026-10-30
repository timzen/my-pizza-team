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
import {
  ASSISTANT_CHAT_MODES, DEFAULT_HARNESS, DEFAULT_NOUNS, isAssistantChatMode, isExperimentalHarness, resolveAssistantChatMode,
} from "../../shared/types.ts";
import { enabledFeatures, featureSources, featureUsage, resolveFeaturesUpdate } from "../features.ts";
import { resolveTemplates } from "../spawner.ts";
import { externalSourceViews } from "./work-sources.ts";
import { validateWorkflow } from "../workflow-engine.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function registerSharedRoutes(ctx: RouteContext): void {
  const { app, store, config, teamDir, setPaused, isPaused, startedAt } = ctx;

  // ─── Health ────────────────────────────────────────────────────────

  app.get("/health", async (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const members = store.getMembers();
    const onlineAgents = members.filter(m => m.status === "working" || m.status === "idle").length;
    const queueDepth = store.getWorkItems({ states: ["READY"] }).total;
    const mem = process.memoryUsage();

    let lastCommitTime: string | null = null;
    try {
      const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%aI"], { cwd: teamDir });
      const output = stdout.trim();
      if (output) lastCommitTime = output;
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
      // How the UI renders the assistant (default applied): "chat" bubbles or the
      // teammate-style "terminal" transcript (TeamConfig.assistant).
      assistantChatMode: resolveAssistantChatMode(config),
      // One-line notices (the persona migration's), dismissed with DELETE /api/notices/:id.
      notices: store.getNotices(),
    });
  });

  app.delete("/api/notices/:id", (c) => {
    if (!store.dismissNotice(c.req.param("id"))) return c.json({ success: false, error: "Notice not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Control ───────────────────────────────────────────────────────

  app.post("/api/control/pause", (c) => { setPaused(true); return c.json({ paused: true }); });
  app.post("/api/control/resume", (c) => { setPaused(false); return c.json({ paused: false }); });


  // ─── Config ────────────────────────────────────────────────────────

  // `features` is the resolved view (absent ⇒ all on), not the raw block.
  // `featureUsage` counts each kind's active items, so the Config page can say
  // "archive or delete 3 stories first" before a save is refused.
  // `featureSources` names each toggle's source (label, external or not), so
  // the page lists plugin sources too and offers to disconnect an external one.
  app.get("/api/config", (c) => c.json({
    ...config, workflows: store.getWorkflows(), defaultNouns: DEFAULT_NOUNS, features: enabledFeatures(store, config),
    featureUsage: featureUsage(store), featureSources: featureSources(store),
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
      // Assistant chat mode: `null` (or `assistant: null`) clears back to the default.
      const chatMode = body.assistant === null ? null : body.assistant?.chatMode;
      if (body.assistant != null && typeof body.assistant !== "object") {
        return c.json({ success: false, error: "assistant must be an object" }, 400);
      }
      if (chatMode != null && !isAssistantChatMode(chatMode)) {
        return c.json({ success: false, error: `assistant.chatMode must be one of: ${ASSISTANT_CHAT_MODES.join(", ")}` }, 400);
      }
      // Feature toggles: validated (and the turn-off guard checked) up front too.
      const featureSettings = resolveFeaturesUpdate(config, body, store);
      if ("error" in featureSettings) return c.json({ success: false, error: featureSettings.error }, featureSettings.status);

      // Workflows (structure and each agent state's `persona`) are validated up
      // front too, so a refused save writes nothing.
      for (const [name, wf] of Object.entries(body.workflows)) {
        const invalid = validateWorkflow(wf as WorkflowConfig) ?? statePersonaError(store, name, wf as WorkflowConfig);
        if (invalid) return c.json({ success: false, error: `Workflow "${name}": ${invalid}` }, 400);
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

      for (const [name, wf] of Object.entries(body.workflows)) store.saveWorkflow(name, wf as WorkflowConfig);
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
      // Assistant chat mode. Live: the persona route composes the leader's system
      // prompt from this on every request, and the leader refetches it before each
      // run — so no leader restart or session reset is needed.
      if (chatMode === null) {
        // Only the mode: the persona selection lives beside it (PUT /api/assistant/persona).
        const { chatMode: _mode, ...rest } = config.assistant ?? {};
        if (Object.keys(rest).length > 0) config.assistant = rest;
        else delete config.assistant;
      } else if (chatMode !== undefined) {
        config.assistant = { ...config.assistant, chatMode };
      }
      // Auto triage. A changed interval needs a daemon restart to re-arm the
      // timer; enabling/disabling and the quiet period take effect next sweep.
      if (body.triage !== undefined) {
        const t = (body.triage || {}) as { enabled?: unknown; intervalMinutes?: unknown; quietMinutes?: unknown; persona?: unknown };
        const minutes = (v: unknown, min: number) =>
          typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;
        if (t.intervalMinutes !== undefined && minutes(t.intervalMinutes, 1) === undefined) {
          return c.json({ success: false, error: "triage.intervalMinutes must be an integer >= 1" }, 400);
        }
        if (t.quietMinutes !== undefined && minutes(t.quietMinutes, 0) === undefined) {
          return c.json({ success: false, error: "triage.quietMinutes must be an integer >= 0" }, 400);
        }
        // The note-triage persona: absent keeps the current one, null/"" clears it
        // (back to builtin:triage), an id must resolve.
        if (t.persona !== undefined && t.persona !== null && t.persona !== "" && (typeof t.persona !== "string" || !store.getPersona(t.persona))) {
          return c.json({ success: false, error: `triage.persona: persona "${String(t.persona)}" doesn't exist` }, 400);
        }
        const triagePersona = t.persona === undefined ? config.triage?.persona : (t.persona as string | null) || undefined;
        config.triage = {
          ...(triagePersona ? { persona: triagePersona } : {}),
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
      const wasOn = enabledFeatures(store, config);
      if (featureSettings.features) config.features = featureSettings.features;
      else delete config.features;
      // An external source switched back on syncs now rather than at its next
      // interval (its timer skipped it while off; daemon/sources/sync.ts).
      const nowOn = enabledFeatures(store, config);
      for (const { source, toggle } of store.listExternalSources()) {
        if (toggle && !wasOn[toggle.feature] && nowOn[toggle.feature]) void store.syncWorkSource(source.id, { force: true });
      }
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
  // A state's persona is selected with PUT /api/workflows/:name/states/:state
  // (daemon/routes/personas.ts); the old instruction-file routes answer 410 there.
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

/**
 * Why a workflow's state `persona` references are refused, or null. A persona
 * must be a string; one that *changed* must be on an agent state (manual states
 * have no teammate) and must resolve — a typo at the point of entry is a 400, like
 * `PUT /api/workflows/:name/states/:state`. An unchanged reference that has
 * since gone stale is accepted (the config form re-sends every workflow on any
 * save; the claim-time fallback covers it — docs/DESIGN.md "Resolution").
 */
function statePersonaError(store: RouteContext["store"], name: string, wf: WorkflowConfig): string | null {
  const current = store.getWorkflows()[name];
  for (const st of wf.states) {
    if (st.persona === undefined || st.persona === null || st.persona === "") continue;
    if (typeof st.persona !== "string") return `State "${st.name}": persona must be a persona id`;
    if (st.persona === current?.states.find((s) => s.name === st.name)?.persona) continue;
    if (st.type !== "agent") return `State "${st.name}" is manual; only agent states have a persona`;
    if (!store.getPersona(st.persona)) return `State "${st.name}": persona "${st.persona}" doesn't exist`;
  }
  return null;
}

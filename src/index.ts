// pi-pizza-team extension entry point
//
// Role detection logic:
// 1. If --ppt-worker flag → Teammate (autonomous agent)
// 2. If --ppt-assistant flag → Assistant (queue processor)
// 3. If --ppt-lead flag OR .my-pizza-team/config.json exists → Leader
// 4. Otherwise → Inactive (only /ppt-help available)
//
// Daemon URL resolution (priority order):
//   --ppt-daemon flag → config.json port/daemonUrl → default (localhost:7437)
//
// See docs/ARCHITECTURE.md for the full module map and data flow.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEAM_DIR, LEGACY_TEAM_DIR, DEFAULT_DAEMON_URL } from "./shared/types.js";
import { DaemonClient } from "./client.js";

export default function (pi: ExtensionAPI) {
  // ─── Flag Registration ─────────────────────────────────────────────

  pi.registerFlag("ppt-worker", {
    description: "Run as a pi-pizza-team teammate",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-lead", {
    description: "Run as team leader (connect to daemon via --ppt-daemon or auto-detect)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-name", {
    description: "Agent name (for teammate/assistant)",
    type: "string",
    default: "",
  });

  pi.registerFlag("ppt-assistant", {
    description: "Run as the pi-pizza-team assistant",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-daemon", {
    description: "Daemon URL (default: http://localhost:7437)",
    type: "string",
    default: "",
  });

  pi.registerFlag("ppt-work-mode", {
    description: "Teammate work selection mode: eager-helper (default) or assigned-story",
    type: "string",
    default: "",
  });

  pi.registerFlag("ppt-story", {
    description: "Story ID to bind to (required for --ppt-work-mode assigned-story)",
    type: "string",
    default: "",
  });

  pi.registerFlag("ppt-skills", {
    description: "Comma-separated capabilities this teammate has; `name` is presence-only, `name:value` binds a value (e.g. python,java:8)",
    type: "string",
    default: "",
  });

  // Set by the leader when spawning an agent, so the agent can report its own
  // tmux window/session back to the daemon as opaque metadata (used to deliver
  // control intents like session reset).
  pi.registerFlag("ppt-tmux-window", { description: "tmux window name (set by leader on spawn)", type: "string", default: "" });
  pi.registerFlag("ppt-tmux-session", { description: "tmux session name (set by leader on spawn)", type: "string", default: "" });

  // ─── Session Start ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    const isWorker = pi.getFlag("ppt-worker") as boolean;
    const isAssistant = pi.getFlag("ppt-assistant") as boolean;
    const isLead = pi.getFlag("ppt-lead") as boolean;
    const pptDaemon = (pi.getFlag("ppt-daemon") as string) || "";
    const agentName = (pi.getFlag("ppt-name") as string) || "";

    // Detect leader via config file (check current name, then legacy)
    let teamDirName = TEAM_DIR;
    let configFile = path.join(cwd, TEAM_DIR, "config.json");
    let hasConfig = fs.existsSync(configFile);
    if (!hasConfig) {
      configFile = path.join(cwd, LEGACY_TEAM_DIR, "config.json");
      hasConfig = fs.existsSync(configFile);
      if (hasConfig) teamDirName = LEGACY_TEAM_DIR;
    }

    // Resolve daemon URL (priority: --ppt-daemon > config > default)
    let daemonUrl = pptDaemon || "";
    if (!daemonUrl && hasConfig) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        if (config.daemonUrl) daemonUrl = config.daemonUrl;
        else if (config.port) daemonUrl = `http://localhost:${config.port}`;
      } catch { /* ignore parse errors */ }
    }
    if (!daemonUrl) daemonUrl = DEFAULT_DAEMON_URL;

    // ─── TEAMMATE ROLE ─────────────────────────────────────────────

    if (isWorker) {
      const memberId = agentName || process.env.TMUX_PANE || `teammate-${Date.now()}`;
      const client = new DaemonClient(daemonUrl, memberId);
      // Work-selection options (see my-pizza-team DESIGN.md: Capability-Based Work Matching)
      const rawMode = (pi.getFlag("ppt-work-mode") as string) || "";
      const workMode = rawMode === "assigned-story" ? "assigned-story" : "eager-helper";
      const assignedStoryId = (pi.getFlag("ppt-story") as string) || "";
      const skills = ((pi.getFlag("ppt-skills") as string) || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      await setupTeammate(pi, ctx, client, memberId, cwd, { workMode, assignedStoryId, skills });
      return;
    }

    // ─── ASSISTANT ROLE ────────────────────────────────────────────

    if (isAssistant) {
      const client = new DaemonClient(daemonUrl, "assistant");
      await setupAssistant(pi, ctx, client, cwd);
      return;
    }

    // ─── LEADER ROLE ───────────────────────────────────────────────

    if (isLead || hasConfig) {
      const client = new DaemonClient(daemonUrl, "leader");
      const { setupLeader } = await import("./leader.js");
      await setupLeader(pi, ctx, client, cwd);
      return;
    }

    // ─── INACTIVE — register /ppt-help only ────────────────────────

    pi.registerCommand("ppt-help", {
      description: "How to set up my-pizza-team in this directory",
      handler: async (_args, cmdCtx) => {
        cmdCtx.ui.notify(
          [
            "🍕 my-pizza-team is not set up in this directory.",
            "",
            "To get started:",
            "  1. Install mpt: https://github.com/timzen/my-pizza-team/releases",
            "  2. Run `mpt start` in this directory (creates .my-pizza-team/)",
            "  3. Restart Pi — leader mode will activate automatically.",
            "",
            "Or point Pi at an existing team:",
            "  cd /path/to/project-with-.my-pizza-team && pi",
          ].join("\n"),
          "info"
        );
      },
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE SETUP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Read the tmux window/session the leader passed at spawn time and package it
 * as opaque registration metadata. The daemon stores it verbatim and hands it
 * back so the leader can deliver control intents (e.g. session reset).
 */
function readTmuxMetadata(pi: ExtensionAPI): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const tmuxWindow = (pi.getFlag("ppt-tmux-window") as string) || "";
  const tmuxSession = (pi.getFlag("ppt-tmux-session") as string) || "";
  if (tmuxWindow) metadata.tmuxWindow = tmuxWindow;
  if (tmuxSession) metadata.tmuxSession = tmuxSession;
  return metadata;
}

async function setupTeammate(
  pi: ExtensionAPI,
  ctx: any,
  client: DaemonClient,
  memberId: string,
  cwd: string,
  workOpts?: { workMode: "eager-helper" | "assigned-story"; assignedStoryId: string; skills: string[] }
): Promise<void> {
  const { TeammateLoop } = await import("./teammate.js");
  const { registerPermissionBypass, updatePermissionConfig } = await import("./permissions.js");
  const { registerTeammateTools } = await import("./tools.js");

  // Check daemon reachability
  const serverUp = await client.checkHealth();
  if (!serverUp && ctx.hasUI) {
    ctx.ui.notify(`🍕 Cannot reach daemon at ${client.url} — will retry...`, "warning");
  }

  // Build the capability map from --ppt-skills entries. Each entry is either
  // `name` (presence-only, value null) or `name:value` (value-bound — e.g.
  // `java:8` matches a story requiring java 8 exactly, or java at any value).
  // The working directory is NOT a capability — it's story data; the task
  // prompt tells the agent to cd there (see the daemon's docs/WORK-MODEL.md).
  const capabilities: Record<string, string | null> = {};
  for (const entry of workOpts?.skills || []) {
    const i = entry.indexOf(":");
    if (i > 0) {
      const name = entry.slice(0, i).trim();
      const value = entry.slice(i + 1).trim();
      if (name) capabilities[name] = value || null;
    } else if (entry.trim()) {
      capabilities[entry.trim()] = null;
    }
  }

  // Register with daemon
  try {
    await client.register({
      name: memberId,
      capabilities,
      workMode: workOpts?.workMode,
      assignedStoryId: workOpts?.assignedStoryId || undefined,
      metadata: readTmuxMetadata(pi),
    });
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Failed to register — will keep trying via polling`, "warning");
    }
  }

  // ─── Debug logging (enable with PPT_DEBUG=1) ────────────────────────

  const debugEnabled = process.env.PPT_DEBUG === "1";
  const debugLogPath = path.join(cwd, "ppt-debug.log");
  const debug = debugEnabled
    ? (msg: string) => {
        const ts = new Date().toISOString();
        fs.appendFileSync(debugLogPath, `${ts} ${msg}\n`);
      }
    : () => {};
  debug(`teammate setup complete. memberId=${memberId} cwd=${cwd}`);

  // Create work loop
  const loop = new TeammateLoop(pi, client);
  loop.debugLog = debug;

  // Register tools. return_task lets the agent give a claimed task back to the
  // queue with a comment when it can't proceed; the loop then skips "done".
  registerTeammateTools(pi, client, () => loop.currentTask || loop.lastTask, (taskId) => loop.markReturned(taskId));

  // Permission bypass (auto-pause on interactive input)
  registerPermissionBypass(
    pi,
    () => loop.isAutonomous,
    () => {
      loop.pause();
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 pairing mode — autonomous work paused"]);
        ctx.ui.notify("🍕 Autonomous work paused — use /ppt-worker-resume when done.", "info");
      }
    },
    cwd
  );

  // Wire permission toggler to the loop
  const configPath = path.join(cwd, ".pi/extensions/pi-permission-system/config.json");
  loop.setAutonomousPermissions = (autonomous: boolean) => {
    updatePermissionConfig(configPath, autonomous);
  };

  // ─── agent_start: track loop activity ──────────────────────────

  pi.on("agent_start" as any, async () => {
    debug(`[ppt-debug agent_start] fired. isAutonomous=${loop.isAutonomous} currentTask=${loop.currentTask}`);
  });

  // ─── agent_end: capture results ──────────────────────────────────

  pi.on("agent_end", async (event) => {
    const debugPrefix = `[ppt-debug agent_end]`;
    debug(`${debugPrefix} fired. isAutonomous=${loop.isAutonomous} currentTask=${loop.currentTask}`);

    if (!loop.isAutonomous || !loop.currentTask) {
      debug(`${debugPrefix} skipping — guard failed`);
      return;
    }

    const messages = event.messages || [];
    let lastText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = "unknown";

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        if (msg.usage) {
          inputTokens += msg.usage.input || 0;
          outputTokens += msg.usage.output || 0;
        }
        if (msg.model && model === "unknown") model = msg.model;
        if (!lastText) {
          for (const part of msg.content) {
            if (part.type === "text") { lastText = part.text; break; }
          }
        }
      }
    }

    debug(`${debugPrefix} lastText length=${lastText.length}, tokens in=${inputTokens} out=${outputTokens}, model=${model}`);

    await loop.handleAgentComplete(lastText, { inputTokens, outputTokens, model });
  });

  // ─── Commands ────────────────────────────────────────────────────

  // Tracking state for widget and status command
  let taskStartedAt: number | null = null;

  // Fresh session per work item (context hygiene): the loop queues this
  // command after each completed/returned task. Session control only exists
  // on command contexts (event handlers could deadlock), hence the documented
  // queue-a-command pattern. ctx.newSession() tears this instance down
  // (session_shutdown → loop.stop) and re-runs session_start in the fresh
  // session, which re-registers this member (same flags → same memberId) and
  // starts a new loop that polls for the next task.
  //
  // The flag makes session_shutdown skip deregistration for self-resets: the
  // member row stays put (no offline blip in the UI) and the re-register
  // upserts it moments later. If the reset dies mid-way, the daemon's
  // heartbeat timeout marks the member offline as usual.
  let resettingForFreshSession = false;
  pi.registerCommand("ppt-fresh-session", {
    description: "Start a fresh session before the next work item (used by the work loop)",
    handler: async (_args: unknown, cmdCtx: any) => {
      resettingForFreshSession = true;
      try {
        const result = await cmdCtx.newSession();
        // Cancelled by another extension — we're staying in this session.
        if (result?.cancelled) resettingForFreshSession = false;
      } catch (e) {
        resettingForFreshSession = false;
        throw e;
      }
    },
  });

  loop.requestFreshSession = () => {
    debug(`[ppt-debug] work item finished — queueing /ppt-fresh-session`);
    pi.sendUserMessage("/ppt-fresh-session", { deliverAs: "followUp" });
  };

  pi.registerCommand("ppt-worker-resume", {
    description: "Resume autonomous work after pairing session",
    handler: async () => {
      loop.resume();
      loop.setAutonomousPermissions?.(true);
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 autonomous mode — waiting for work..."]);
        ctx.ui.notify("🍕 Resuming autonomous work", "info");
      }
    },
  });

  pi.registerCommand("ppt-worker-status", {
    description: "Show current teammate status",
    handler: async () => {
      let output = `🍕 Teammate: ${memberId}\nMode: ${loop.isAutonomous ? "autonomous" : "pairing"}\n\n`;
      if (loop.currentTask) {
        const elapsed = taskStartedAt ? Math.round((Date.now() - taskStartedAt) / 60000) : 0;
        output += `🔨 Current task: ${loop.currentTask} (${elapsed}m)\n`;
      } else {
        output += `☕ No active task (waiting for work)\n`;
      }
      if (ctx.hasUI) ctx.ui.notify(output, "info");
    },
  });

  // ─── Start + Widget ──────────────────────────────────────────────

  loop.resume();
  await loop.start();

  loop.onTaskComplete = () => { taskStartedAt = null; };

  loop.onDismissed = () => {
    if (ctx.hasUI) {
      ctx.ui.notify("🍕 Agent dismissed by lead. Shutting down.", "warning");
    }
    clearInterval(widgetInterval);
    // Exit the process so the tmux window closes
    setTimeout(() => process.exit(0), 500);
  };

  const updateWidget = () => {
    if (!ctx.hasUI || !loop.isAutonomous) return;
    if (loop.currentTask) {
      if (!taskStartedAt) taskStartedAt = Date.now();
      const elapsed = Math.round((Date.now() - taskStartedAt) / 60000);
      const timeStr = elapsed > 0 ? ` (${elapsed}m)` : "";
      ctx.ui.setWidget("pi-pizza-team", [`🔨 Working: ${loop.currentTask}${timeStr}`]);
    } else {
      ctx.ui.setWidget("pi-pizza-team", ["🍕 waiting for work..."]);
    }
  };
  const widgetInterval = setInterval(updateWidget, 5000);

  if (ctx.hasUI) {
    ctx.ui.setWidget("pi-pizza-team", ["🍕 teammate ready — waiting for work..."]);
    ctx.ui.setStatus("pi-pizza-team", `🍕 ${memberId}`);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    clearInterval(widgetInterval);
    loop.stop();
    // Self-reset between work items: keep the daemon registration alive so
    // the member doesn't flicker offline; the fresh instance re-registers.
    if (resettingForFreshSession) return;
    await client.deregister().catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ASSISTANT SETUP
// ═══════════════════════════════════════════════════════════════════════

async function setupAssistant(
  pi: ExtensionAPI,
  ctx: any,
  client: DaemonClient,
  cwd: string
): Promise<void> {
  const { AssistantLoop } = await import("./assistant.js");
  const { registerAssistantTools } = await import("./tools.js");

  // Check daemon reachability
  const serverUp = await client.checkHealth();
  if (!serverUp && ctx.hasUI) {
    ctx.ui.notify(`🤖 Cannot reach daemon at ${client.url} — will retry...`, "warning");
  }

  // Register with daemon. The `persona` capability advertises that this build
  // knows how to load a context-library persona as its system prompt; the web
  // UI only shows persona chips when an assistant with this capability is online.
  try {
    await client.register({ name: "assistant", capabilities: { directory: cwd, persona: "true" }, metadata: readTmuxMetadata(pi) });
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🤖 Failed to register — will keep trying via polling`, "warning");
    }
  }

  const loop = new AssistantLoop(pi, client);
  let completedItems = 0;

  // Register tools. The `send_message` tool needs the active response turn id so
  // it can append chat bubbles to the turn currently being worked.
  registerAssistantTools(pi, client, () => loop.currentItem);

  // Inject the assistant's persona as the system prompt each turn. The persona
  // text comes from the daemon (a selected context entry, or the daemon's
  // default assistant persona when none is chosen) and is cached by the loop.
  // Swapping it in the web UI resets the session so the new persona takes over.
  pi.on("before_agent_start", async (event) => {
    const persona = loop.persona;
    if (!persona) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${persona}` };
  });

  loop.onItemComplete = () => {
    completedItems++;
    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-pizza-team", [`🤖 assistant idle — ${completedItems} processed`]);
    }
  };

  // ─── agent_end: capture results ──────────────────────────────────

  pi.on("agent_end", async (event) => {
    if (!loop.isWorking) return;

    const messages = event.messages || [];
    let lastText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text") { lastText = part.text; break; }
        }
        if (lastText) break;
      }
    }

    await loop.handleAgentComplete(lastText);
  });

  // ─── Start + Widget ──────────────────────────────────────────────

  await loop.start();

  if (ctx.hasUI) {
    ctx.ui.setWidget("pi-pizza-team", ["🤖 assistant ready — waiting for requests..."]);
    ctx.ui.setStatus("pi-pizza-team", "🤖 assistant");
    ctx.ui.notify("🤖 pi-pizza-team assistant active", "info");
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    loop.stop();
    await client.deregister().catch(() => {});
  });
}

// pi-pizza-team extension entry point
//
// Role detection logic:
// 1. If --ppt-worker flag → Teammate (autonomous agent)
// 2. If --ppt-assistant flag → Assistant (queue processor)
// 3. If --ppt-lead flag OR .pi-pizza-team/config.json exists → Leader
// 4. Otherwise → Inactive (only /ppt-init available)
//
// All roles communicate with the my-pizza-team daemon via HTTP.
// Daemon URL resolution (priority order):
//   --ppt-daemon flag → --ppt-lead flag (string) → config.json daemonUrl → default
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
    description: "Run as team leader (or daemon URL for backwards compat)",
    type: "string",
    default: "",
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

  // ─── Session Start ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    const isWorker = pi.getFlag("ppt-worker") as boolean;
    const isAssistant = pi.getFlag("ppt-assistant") as boolean;
    const pptLead = (pi.getFlag("ppt-lead") as string) || "";
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

    // Resolve daemon URL (priority: --ppt-daemon > --ppt-lead > config > default)
    let daemonUrl = pptDaemon || "";
    if (!daemonUrl && pptLead && pptLead.startsWith("http")) {
      daemonUrl = pptLead; // backwards compat: --ppt-lead=http://...
    }
    if (!daemonUrl && hasConfig) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        if (config.daemonUrl) daemonUrl = config.daemonUrl;
      } catch { /* ignore parse errors */ }
    }
    if (!daemonUrl) daemonUrl = DEFAULT_DAEMON_URL;

    // ─── TEAMMATE ROLE ─────────────────────────────────────────────

    if (isWorker) {
      const memberId = agentName || process.env.TMUX_PANE || `teammate-${Date.now()}`;
      const client = new DaemonClient(daemonUrl, memberId);
      await setupTeammate(pi, ctx, client, memberId, cwd);
      return;
    }

    // ─── ASSISTANT ROLE ────────────────────────────────────────────

    if (isAssistant) {
      const client = new DaemonClient(daemonUrl, "assistant");
      await setupAssistant(pi, ctx, client, cwd);
      return;
    }

    // ─── LEADER ROLE ───────────────────────────────────────────────

    if (pptLead || hasConfig) {
      const client = new DaemonClient(daemonUrl, "leader");
      const { setupLeader } = await import("./leader.js");
      await setupLeader(pi, ctx, client, cwd);
      return;
    }

    // ─── INACTIVE — register /ppt-init only ────────────────────────

    pi.registerCommand("ppt-init", {
      description: "Initialize current directory as a pi-pizza-team board",
      handler: async (_args, cmdCtx) => {
        const teamDir = path.join(cwd, TEAM_DIR);
        fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
        fs.mkdirSync(path.join(teamDir, "notes"), { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, "config.json"),
          JSON.stringify({ daemonUrl: DEFAULT_DAEMON_URL }, null, 2) + "\n"
        );
        fs.writeFileSync(
          path.join(teamDir, ".gitignore"),
          "state.db\nstate.db-wal\nstate.db-shm\n"
        );
        cmdCtx.ui.notify(
          "✓ Initialized .pi-pizza-team/ — restart Pi to activate leader mode. 🍕",
          "info"
        );
      },
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE SETUP
// ═══════════════════════════════════════════════════════════════════════

async function setupTeammate(
  pi: ExtensionAPI,
  ctx: any,
  client: DaemonClient,
  memberId: string,
  cwd: string
): Promise<void> {
  const { TeammateLoop } = await import("./teammate.js");
  const { registerPermissionBypass, updatePermissionConfig } = await import("./permissions.js");
  const { registerTeammateTools } = await import("./tools.js");

  // Check daemon reachability
  const serverUp = await client.checkHealth();
  if (!serverUp && ctx.hasUI) {
    ctx.ui.notify(`🍕 Cannot reach daemon at ${client.url} — will retry...`, "warning");
  }

  // Register with daemon
  try {
    await client.register({ name: memberId, cwd });
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Failed to register — will keep trying via polling`, "warning");
    }
  }

  // ─── Debug logging ───────────────────────────────────────────

  const debugLogPath = path.join(cwd, "ppt-debug.log");
  const debug = (msg: string) => {
    const ts = new Date().toISOString();
    fs.appendFileSync(debugLogPath, `${ts} ${msg}\n`);
  };
  debug(`teammate setup complete. memberId=${memberId} cwd=${cwd}`);

  // Create work loop
  const loop = new TeammateLoop(pi, client);
  loop.debugLog = debug;

  // Register tools
  registerTeammateTools(pi, client, () => loop.currentTask || loop.lastTask);

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
  let completedTasks = 0;

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
      output += `\n✓ Tasks completed this session: ${completedTasks}\n`;
      if (ctx.hasUI) ctx.ui.notify(output, "info");
    },
  });

  // ─── Start + Widget ──────────────────────────────────────────────

  loop.resume();
  await loop.start();

  loop.onTaskComplete = () => { completedTasks++; taskStartedAt = null; };

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

  // Register with daemon
  try {
    await client.register({ name: "assistant", cwd });
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🤖 Failed to register — will keep trying via polling`, "warning");
    }
  }

  // Fetch categories from daemon
  let categories: string[] = ["coding", "research", "doc-writing"];
  try {
    const config = await client.getConfig();
    if (config.categories?.length) categories = config.categories;
  } catch { /* use defaults */ }

  // Register tools
  registerAssistantTools(pi, client, categories);

  // ─── Work loop ───────────────────────────────────────────────────

  const loop = new AssistantLoop(pi, client);
  let completedItems = 0;

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

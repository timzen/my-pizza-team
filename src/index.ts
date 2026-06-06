// pi-pizza-team extension entry point
//
// Role detection logic (simplified for daemon architecture):
// 1. If --ppt-lead flag → Team Lead
//    - Registers with daemon, polls spawn requests, manages tmux
// 2. If --ppt-worker flag → Teammate (autonomous agent)
//    - Connects to daemon, starts work loop
// 3. If --ppt-assistant flag → Assistant (queue processor)
//    - Connects to daemon, polls assistant queue
// 4. Otherwise → Inactive
//
// All roles communicate with the my-pizza-team daemon via HTTP.
// The daemon URL is configured via --ppt-daemon (default: http://localhost:7437).
//
// See docs/ARCHITECTURE.md for the full module map and data flow.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DAEMON_URL } from "./shared/types.js";
import { DaemonClient } from "./client.js";

export default function (pi: ExtensionAPI) {
  // --- Flag Registration ---

  pi.registerFlag("ppt-worker", {
    description: "Run as a pi-pizza-team teammate",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-lead", {
    description: "Run as the pi-pizza-team leader",
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
    default: DEFAULT_DAEMON_URL,
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    const isWorker = pi.getFlag("ppt-worker") as boolean;
    const isLead = pi.getFlag("ppt-lead") as boolean;
    const isAssistant = pi.getFlag("ppt-assistant") as boolean;
    const daemonUrl = (pi.getFlag("ppt-daemon") as string) || DEFAULT_DAEMON_URL;
    const agentName = (pi.getFlag("ppt-name") as string) || "";

    // No role selected — extension is inactive
    if (!isWorker && !isLead && !isAssistant) {
      return;
    }

    // ─── LEADER ROLE ───────────────────────────────────────────────

    if (isLead) {
      const client = new DaemonClient(daemonUrl, "leader");
      const { setupLeader } = await import("./leader.js");
      await setupLeader(pi, ctx, client, cwd);
      return;
    }

    // ─── ASSISTANT ROLE ────────────────────────────────────────────

    if (isAssistant) {
      const memberId = "assistant";
      const client = new DaemonClient(daemonUrl, memberId);
      await setupAssistantRole(pi, ctx, client, cwd);
      return;
    }

    // ─── TEAMMATE ROLE ─────────────────────────────────────────────

    if (isWorker) {
      const memberId = agentName || process.env.TMUX_PANE || `teammate-${Date.now()}`;
      const client = new DaemonClient(daemonUrl, memberId);
      await setupTeammateRole(pi, ctx, client, memberId, cwd);
      return;
    }
  });
}

// --- Teammate Setup ---
async function setupTeammateRole(
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

  // Create work loop
  const loop = new TeammateLoop(pi, client);

  // Register tools (search_memory + upload_attachment for teammates)
  registerTeammateTools(pi, client, () => loop.currentTask || loop.lastTask);

  // Permission bypass
  registerPermissionBypass(
    pi,
    () => loop.isAutonomous,
    () => {
      loop.pause();
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 pairing mode — autonomous work paused"]);
        ctx.ui.notify("🍕 Autonomous work paused — you're now pairing. Use /ppt-worker-resume when done.", "info");
      }
    },
    cwd
  );

  // Store permission toggler on the loop
  const path = await import("node:path");
  const configPath = path.join(cwd, ".pi/extensions/pi-permission-system/config.json");
  loop.setAutonomousPermissions = (autonomous: boolean) => {
    updatePermissionConfig(configPath, autonomous);
  };

  // Listen for agent completion
  pi.on("agent_end", async (event) => {
    if (!loop.isAutonomous || !loop.currentTask) return;

    const messages = event.messages || [];
    let lastAssistantText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let model = "unknown";

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        if (msg.usage) {
          totalInputTokens += msg.usage.input || 0;
          totalOutputTokens += msg.usage.output || 0;
          if (msg.usage.cost) totalCost += msg.usage.cost.total || 0;
        }
        if (msg.model && model === "unknown") model = msg.model;
        if (!lastAssistantText) {
          for (const part of msg.content) {
            if (part.type === "text") { lastAssistantText = part.text; break; }
          }
        }
      }
    }

    await loop.handleAgentComplete(lastAssistantText, {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model,
      costFromProvider: totalCost,
    });
  });

  // Command to resume autonomous work after pairing
  pi.registerCommand("ppt-worker-resume", {
    description: "Resume autonomous work after pairing session",
    handler: async (_args) => {
      loop.resume();
      loop.setAutonomousPermissions?.(true);
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 autonomous mode — waiting for work..."]);
        ctx.ui.notify("🍕 Resuming autonomous work", "info");
      }
    },
  });

  // Start the work loop
  loop.resume();
  await loop.start();

  // Widget update
  let taskStartedAt: number | null = null;
  let completedTasks = 0;
  loop.onTaskComplete = (_taskId, _result) => {
    completedTasks++;
    taskStartedAt = null;
  };

  const updateWidget = () => {
    if (!ctx.hasUI || !loop.isAutonomous) return;
    if (loop.currentTask) {
      if (!taskStartedAt) taskStartedAt = Date.now();
      const elapsed = Math.round((Date.now() - taskStartedAt) / 60000);
      const timeStr = elapsed > 0 ? ` (${elapsed}m)` : '';
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

  // /ppt-worker-status
  pi.registerCommand("ppt-worker-status", {
    description: "Show current teammate status",
    handler: async (_args) => {
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

  // Cleanup
  pi.on("session_shutdown", async () => {
    clearInterval(widgetInterval);
    loop.stop();
    await client.deregister().catch(() => {});
  });
}

// --- Assistant Setup ---
async function setupAssistantRole(
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

  // Fetch categories from daemon config
  let categories: string[] = ["coding", "research", "doc-writing"];
  try {
    const config = await client.getConfig();
    if (config.categories?.length) categories = config.categories;
  } catch { /* use defaults */ }

  // Register tools (create_story, edit_story, add_task, save_memory, search_memory, queue_request)
  registerAssistantTools(pi, client, categories);

  // Create the work loop
  const loop = new AssistantLoop(pi, client);
  let completedItems = 0;

  // Track completions for widget
  loop.onItemComplete = (_itemId, _summary) => {
    completedItems++;
    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-pizza-team", [`🤖 assistant idle — ${completedItems} processed`]);
    }
  };

  // Listen for agent completion
  pi.on("agent_end", async (event) => {
    if (!loop.isWorking) return;

    const messages = event.messages || [];
    let lastAssistantText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text") { lastAssistantText = part.text; break; }
        }
        if (lastAssistantText) break;
      }
    }

    await loop.handleAgentComplete(lastAssistantText);
  });

  // Start the loop
  await loop.start();

  if (ctx.hasUI) {
    ctx.ui.setWidget("pi-pizza-team", ["🤖 assistant ready — waiting for requests..."]);
    ctx.ui.setStatus("pi-pizza-team", "🤖 assistant");
    ctx.ui.notify("🤖 pi-pizza-team assistant active", "info");
  }

  // Cleanup
  pi.on("session_shutdown", async () => {
    loop.stop();
    await client.deregister().catch(() => {});
  });
}

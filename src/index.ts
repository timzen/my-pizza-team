// pi-pizza-team extension entry point
//
// Role detection logic:
// 1. If .pi-pizza-team/config.json exists in cwd → Team Lead
//    - Loads SQLite store, starts HTTP server, registers commands
// 2. If --ppt-worker flag + --ppt-lead URL → Teammate (auto-start)
//    - Connects to leader API, starts work loop
// 3. If PI_TEAM_LEADER_URL env var set → Teammate (prompts to join)
// 4. Otherwise → Inactive (only /ppt-init available)
//
// See docs/ARCHITECTURE.md for the full module map and data flow.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEAM_DIR, CONFIG_FILE, type TeamConfig, DEFAULT_CONFIG } from "./shared/types.js";

export default function (pi: ExtensionAPI) {
  // --- Role Detection ---

  // Check CLI flags for teammate mode
  pi.registerFlag("ppt-worker", {
    description: "Run as a pi-pizza-team teammate",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-lead", {
    description: "Team lead URL to connect to",
    type: "string",
    default: "",
  });

  pi.registerFlag("ppt-name", {
    description: "Teammate name",
    type: "string",
    default: "",
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const teamDir = path.join(cwd, TEAM_DIR);
    const configFile = path.join(teamDir, CONFIG_FILE);

    const isTeamWorkerFlag = pi.getFlag("ppt-worker") as boolean;
    const teamLeadUrl = (pi.getFlag("ppt-lead") as string) || process.env.PI_TEAM_LEADER_URL || "";
    const teamName = (pi.getFlag("ppt-name") as string) || "";

    // --- TEAM LEAD ROLE ---
    if (fs.existsSync(configFile)) {
      await setupTeamLead(pi, ctx, teamDir, configFile);
      return;
    }

    // --- TEAMMATE ROLE (explicit flag) ---
    if (isTeamWorkerFlag && teamLeadUrl) {
      await setupTeammate(pi, ctx, teamLeadUrl, teamName, cwd);
      return;
    }

    // --- TEAMMATE ROLE (auto-detect via env var) ---
    if (teamLeadUrl) {
      if (ctx.hasUI) {
        const join = await ctx.ui.confirm(
          "🍕 pi-pizza-team",
          `Team lead detected at ${teamLeadUrl}. Join the team?`
        );
        if (join) {
          await setupTeammate(pi, ctx, teamLeadUrl, teamName, cwd);
        }
      }
      return;
    }

    // Neither lead nor teammate — extension is loaded but inactive
    // Register ppt-init so they can initialize a board
    const { registerLeadCommands } = await import("./lead/commands.js");
    // Only register ppt-init in this case
    pi.registerCommand("ppt-init", {
      description: "Initialize current directory as a pi-pizza-team board",
      handler: async (_args, cmdCtx) => {
        fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, "config.json"),
          JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n"
        );
        fs.writeFileSync(
          path.join(teamDir, ".gitignore"),
          "state.db\nstate.db-wal\nstate.db-shm\n"
        );
        cmdCtx.ui.notify("✓ Initialized .pi-pizza-team/ — your kanban board is ready! 🍕\nRestart Pi to activate team lead mode.", "info");
      },
    });
  });
}

// --- Team Lead Setup ---
async function setupTeamLead(
  pi: ExtensionAPI,
  ctx: any,
  teamDir: string,
  configFile: string
): Promise<void> {
  const { Store } = await import("./lead/store.js");
  const { TeamServer } = await import("./lead/server.js");
  const { registerLeadCommands } = await import("./lead/commands.js");

  // Load config
  const configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const config: TeamConfig = { ...DEFAULT_CONFIG, ...configData };

  // Migrate legacy single-workflow config to named workflows
  if (configData.workflow && !configData.workflows) {
    config.workflows = { default: configData.workflow };
    config.defaultWorkflow = "default";
  }

  // Initialize store
  const store = new Store(teamDir, config);
  store.loadFromDisk();
  store.startTimers();

  // Start HTTP server
  const server = new TeamServer(store, config);
  await server.start();

  // Register commands
  registerLeadCommands(
    pi,
    () => store,
    () => server,
    () => config,
    teamDir
  );

  // Register LLM tools
  const { registerLeadTools } = await import("./lead/tools.js");
  registerLeadTools(
    pi,
    () => store,
    () => config,
    teamDir
  );

  // Status widget
  const updateWidget = () => {
    const stories = store.getStories();
    const members = store.getMembers();
    const inbox = store.getInboxTasks();
    const activeStories = stories.filter((s) => s.status === "open").length;

    const memberStatus = members
      .map((m) => {
        const assignment = store.getAssignmentForMember(m.id);
        return assignment ? `${m.name} 🔨` : `${m.name} ☕`;
      })
      .join(" • ");

    const parts = [`📋 ${activeStories} stories`];
    if (memberStatus) parts.push(memberStatus);
    if (inbox.length > 0) parts.push(`📬 ${inbox.length} inbox`);

    ctx.ui.setWidget("pi-pizza-team", [parts.join(" • ")]);
  };

  updateWidget();
  const widgetInterval = setInterval(updateWidget, 10000);

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    clearInterval(widgetInterval);
    await server.stop();
    store.close();
  });

  if (ctx.hasUI) {
    ctx.ui.notify(`🍕 pi-pizza-team lead active on port ${config.port}`, "info");
  }
}

// --- Teammate Setup ---
async function setupTeammate(
  pi: ExtensionAPI,
  ctx: any,
  leaderUrl: string,
  name: string,
  cwd: string
): Promise<void> {
  const { TeamClient } = await import("./teammate/client.js");
  const { WorkLoop } = await import("./teammate/loop.js");
  const { registerPermissionBypass } = await import("./teammate/permissions.js");

  // Determine identity
  const memberId = name || process.env.TMUX_PANE || `teammate-${Date.now()}`;
  const tmuxWindow = process.env.TMUX_PANE || memberId;

  // Create client and join
  const client = new TeamClient(leaderUrl, memberId);

  // Check if server is reachable
  const serverUp = await client.checkServer();
  if (!serverUp) {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Cannot reach team lead at ${leaderUrl} — will retry...`, "warning");
    }
  }

  // Join the team (retry-tolerant)
  try {
    await client.join(memberId, cwd, tmuxWindow);
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Failed to join team — will keep trying via polling`, "warning");
    }
  }

  // Create work loop
  const loop = new WorkLoop(pi, client, memberId);

  // Permission bypass (toggles yoloMode based on autonomous vs pairing)
  registerPermissionBypass(pi, () => loop, cwd);

  // Listen for agent completion to capture results
  pi.on("agent_end", async (event) => {
    if (!loop.isAutonomous || !loop.currentTask) return;

    // Extract last assistant message
    const messages = event.messages || [];
    let lastAssistantText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let model = "unknown";

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        // Accumulate token usage from all assistant turns
        if (msg.usage) {
          totalInputTokens += msg.usage.input || 0;
          totalOutputTokens += msg.usage.output || 0;
          if (msg.usage.cost) totalCost += msg.usage.cost.total || 0;
        }
        if (msg.model && model === "unknown") model = msg.model;
        if (!lastAssistantText) {
          for (const part of msg.content) {
            if (part.type === "text") {
              lastAssistantText = part.text;
              break;
            }
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

  // Detect interactive input to pause autonomous work
  pi.on("input", async (event) => {
    if (event.source === "interactive" && loop.isAutonomous) {
      loop.pause();
      // Permission config is toggled by permissions.ts input handler
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 pairing mode — autonomous work paused"]);
        ctx.ui.notify("🍕 Autonomous work paused — you're now pairing. Use /ppt-worker-resume when done.", "info");
      }
    }
    return { action: "continue" as const };
  });

  // Command to resume autonomous work after pairing
  pi.registerCommand("ppt-worker-resume", {
    description: "Resume autonomous work after pairing session",
    handler: async (_args) => {
      loop.resume();
      // Re-enable yoloMode for autonomous work
      if ((loop as any)._setAutonomousPermissions) {
        (loop as any)._setAutonomousPermissions(true);
      }
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 autonomous mode — waiting for work..."]);
        ctx.ui.notify("🍕 Resuming autonomous work", "info");
      }
    },
  });

  // Start the work loop
  loop.resume();
  await loop.start();

  // Widget
  if (ctx.hasUI) {
    ctx.ui.setWidget("pi-pizza-team", ["🍕 teammate ready — waiting for work..."]);
    ctx.ui.setStatus("pi-pizza-team", `🍕 ${memberId}`);
  }

  // Cleanup
  pi.on("session_shutdown", async () => {
    loop.stop();
    await client.heartbeat("idle");
  });
}

// Leader role: tmux management, spawn request polling, LLM tools
//
// The leader is the Pi-specific host coordinator. It doesn't own state —
// the daemon does. The leader's responsibilities are:
//   1. Register with daemon as { role: "leader", harness: "pi", hostId }
//   2. Poll GET /api/spawn-requests?hostId=X every 5s for pending spawns
//   3. Execute spawns locally via tmux (multi-harness: pi, claude-code, codex)
//   4. Acknowledge spawns: POST /api/spawn-requests/:id/ack
//   5. Register LLM tools for the lead user
//   6. Provide tmux commands: /ppt-spawn, /ppt-dismiss, /ppt-hop, /ppt-status
//   7. Show status widget with team progress
//
// Multi-harness support:
//   Spawn requests may specify a harness type. The leader uses command
//   templates to spawn the appropriate agent process. Default is "pi".
//   Templates use {name}, {url}, {cwd} placeholders.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import { registerLeaderTools } from "./tools.js";

const SPAWN_POLL_INTERVAL_MS = 5000;
const WIDGET_UPDATE_INTERVAL_MS = 10000;

// ─── Harness command templates ───────────────────────────────────────

/** Command templates for spawning agents by harness type */
interface HarnessTemplates {
  [harness: string]: string;
}

const DEFAULT_HARNESS_TEMPLATES: HarnessTemplates = {
  pi: "pi --ppt-worker --ppt-daemon={url} --ppt-name={name}",
  "claude-code": "mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}",
  codex: "mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}",
};



// ─── Shell safety ────────────────────────────────────────────────────

/** Sanitize a string for safe use in shell commands */
function shellSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._~/:@-]/g, "");
}

// ═══════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════

export async function setupLeader(
  pi: ExtensionAPI,
  ctx: any,
  client: DaemonClient,
  cwd: string
): Promise<void> {
  const { execSync } = await import("node:child_process");

  // Configuration from daemon
  let tmuxSession = "pi-pizza-team";
  let favoriteDirectories: string[] = [];
  let harnessTemplates: HarnessTemplates = { ...DEFAULT_HARNESS_TEMPLATES };

  // Register with daemon
  try {
    const regRes = await client.register({ name: "leader", cwd });
    if (regRes.config?.tmuxSession) tmuxSession = regRes.config.tmuxSession;
    if (regRes.config?.favoriteDirectories) favoriteDirectories = regRes.config.favoriteDirectories;
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Failed to register with daemon — will retry via heartbeat`, "warning");
    }
  }

  // Fall back to host-specific config if register didn't provide tmuxSession
  if (tmuxSession === "pi-pizza-team") {
    try {
      const hostConfig = await client.getHostConfig();
      if (hostConfig.tmuxSession) tmuxSession = hostConfig.tmuxSession;
      if (hostConfig.favoriteDirectories?.length) favoriteDirectories = hostConfig.favoriteDirectories;
    } catch {
      // Use defaults
    }
  }

  // Try to load harness templates from daemon config
  try {
    const daemonConfig = await client.getConfig();
    if (daemonConfig.harnessCommands) {
      harnessTemplates = { ...DEFAULT_HARNESS_TEMPLATES, ...daemonConfig.harnessCommands };
    }
  } catch {
    // Use defaults
  }



  // Register LLM tools (stories, tasks, queue, search)
  registerLeaderTools(pi, client);

  // ─── Leader Heartbeat ──────────────────────────────────────────────
  // Send periodic heartbeats so the daemon knows the leader is alive.
  // Without this, the daemon's reaper marks the leader as offline.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    client.heartbeat("idle").catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  // Send an initial heartbeat immediately
  client.heartbeat("idle").catch(() => {});

  // ─── Spawn Request Polling ─────────────────────────────────────────

  const spawnPollTimer = setInterval(async () => {
    try {
      const res = await client.getSpawnRequests();
      for (const req of res.requests) {
        try {
          // Use the daemon-generated name from the spawn request
          const name = req.name || `agent-${Date.now()}`;

          // Determine harness (default to "pi" until daemon supports harness field)
          const harness = (req as any).harness || "pi";
          const spawnCwd = req.cwd || cwd;

          spawnAgent(name, spawnCwd, {
            session: tmuxSession,
            daemonUrl: client.url,
            harness,
            harnessTemplates,
          }, execSync);

          await client.ackSpawnRequest(req.id);
        } catch {
          // Failed to spawn — will retry next poll cycle
        }
      }
    } catch {
      // Daemon unreachable
    }
  }, SPAWN_POLL_INTERVAL_MS);

  // ─── Slash Commands ────────────────────────────────────────────────

  pi.registerCommand("ppt-spawn", {
    description: "Hire a new teammate: /ppt-spawn [name] [cwd]",
    handler: async (args, cmdCtx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const userProvidedName = parts[0] || undefined;
      const spawnCwd = parts[1] || (favoriteDirectories.length > 0 ? favoriteDirectories[0] : cwd);
      const resolvedCwd = resolvePath(spawnCwd);

      try {
        // Create a spawn request via daemon to get a centrally-generated name
        const spawnRes = await client.createSpawnRequest(resolvedCwd);
        const name = userProvidedName || spawnRes.name;

        spawnAgent(name, resolvedCwd, {
          session: tmuxSession,
          daemonUrl: client.url,
          harness: "pi",
          harnessTemplates,
        }, execSync);

        // Acknowledge the spawn request we just created
        await client.ackSpawnRequest(spawnRes.id);
        cmdCtx.ui.notify(`✓ ${name} has joined the team working in ${spawnCwd} 🍕`, "info");
      } catch (err: any) {
        cmdCtx.ui.notify(`Failed to spawn: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("ppt-dismiss", {
    description: "Stop a teammate: /ppt-dismiss <name>",
    handler: async (args, cmdCtx) => {
      const name = args?.trim();
      if (!name) { cmdCtx.ui.notify("Usage: /ppt-dismiss <name>", "warning"); return; }

      try {
        dismissAgent(name, tmuxSession, execSync);
        cmdCtx.ui.notify(`✓ ${name} has left the team`, "info");
      } catch {
        cmdCtx.ui.notify(`No tmux window named "${name}" found`, "error");
      }
    },
  });

  pi.registerCommand("ppt-hop", {
    description: "Jump to a teammate's tmux window: /ppt-hop <name>",
    handler: async (args, cmdCtx) => {
      const name = args?.trim();
      if (!name) { cmdCtx.ui.notify("Usage: /ppt-hop <name>", "warning"); return; }
      try {
        execSync(`tmux select-window -t "${shellSafe(tmuxSession)}:${shellSafe(name)}"`, { stdio: "pipe" });
        cmdCtx.ui.notify(`→ Switching to ${name}'s window`, "info");
      } catch {
        cmdCtx.ui.notify(`No tmux window named "${name}"`, "error");
      }
    },
  });

  pi.registerCommand("ppt-status", {
    description: "Quick status summary from the daemon",
    handler: async (_args, cmdCtx) => {
      try {
        const status = await client.getStatus();
        let output = `🍕 pi-pizza-team status\n`;
        output += `🌐 ${client.url}\n\n`;
        output += `  Stories: ${status.stories.open} open, ${status.stories.done} done\n`;
        output += `  Tasks: ${status.tasks.total} total`;
        const byStatus = Object.entries(status.tasks.byStatus).map(([s, n]) => `${n} ${s}`).join(", ");
        if (byStatus) output += ` (${byStatus})`;
        output += `\n  Team: ${status.members.total} members (${status.members.working} working, ${status.members.idle} idle)\n`;
        if (status.inbox > 0) output += `  📬 Inbox: ${status.inbox} items needing attention\n`;

        // List active tmux windows
        const windows = listWindows(tmuxSession, execSync);
        if (windows.length > 0) {
          output += `\n  tmux windows: ${windows.join(", ")}\n`;
        }

        cmdCtx.ui.notify(output, "info");
      } catch {
        cmdCtx.ui.notify("Cannot reach daemon", "error");
      }
    },
  });

  pi.registerCommand("ppt-browse", {
    description: "Show favorite working directories for spawning",
    handler: async (_args, cmdCtx) => {
      if (favoriteDirectories.length === 0) {
        cmdCtx.ui.notify("No favorite directories configured.\nAdd them via the daemon's host config.", "info");
        return;
      }
      let output = "📂 Favorite directories:\n";
      for (const dir of favoriteDirectories) {
        output += `  • ${dir}\n`;
      }
      output += `\nUse /ppt-spawn <name> <dir> to spawn in a specific directory.`;
      cmdCtx.ui.notify(output, "info");
    },
  });

  // ─── Widget ────────────────────────────────────────────────────────

  const updateWidget = async () => {
    if (!ctx.hasUI) return;
    try {
      const status = await client.getStatus();
      const done = status.tasks.byStatus.done || 0;
      const parts = [`🍕 ${done}/${status.tasks.total} tasks done`];
      if (status.members.working > 0) parts.push(`${status.members.working} working`);
      if (status.inbox > 0) parts.push(`📬 ${status.inbox} inbox`);
      ctx.ui.setWidget("pi-pizza-team", [parts.join(" • ")]);
    } catch {
      ctx.ui.setWidget("pi-pizza-team", ["🍕 daemon unreachable"]);
    }
  };

  updateWidget();
  const widgetInterval = setInterval(updateWidget, WIDGET_UPDATE_INTERVAL_MS);

  // ─── Cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    clearInterval(heartbeatTimer);
    clearInterval(spawnPollTimer);
    clearInterval(widgetInterval);
    await client.deregister().catch(() => {});
  });

  if (ctx.hasUI) {
    ctx.ui.notify(`🍕 pi-pizza-team lead connected to daemon at ${client.url}`, "info");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TMUX HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Resolve ~ and relative paths */
function resolvePath(p: string): string {
  if (p.startsWith("~")) return p.replace("~", process.env.HOME || "");
  return path.resolve(p);
}

/** Ensure a tmux session exists. Returns true if just created. */
function ensureSession(session: string, execSync: any): boolean {
  const safeSession = shellSafe(session);
  try {
    execSync(`tmux has-session -t "${safeSession}" 2>/dev/null`, { stdio: "pipe" });
    return false;
  } catch {
    execSync(`tmux new-session -d -s "${safeSession}"`, { stdio: "pipe" });
    return true;
  }
}

/** List tmux window names in a session */
function listWindows(session: string, execSync: any): string[] {
  const safeSession = shellSafe(session);
  try {
    const output = execSync(
      `tmux list-windows -t "${safeSession}" -F "#{window_name}"`,
      { stdio: "pipe" }
    ).toString();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Spawn an agent in a tmux window.
 *
 * Supports multiple harness types via command templates. The template
 * uses {name}, {url}, {cwd} placeholders that are replaced with the
 * actual values.
 */
function spawnAgent(
  name: string,
  agentCwd: string,
  options: {
    session: string;
    daemonUrl: string;
    harness: string;
    harnessTemplates: HarnessTemplates;
  },
  execSync: any
): void {
  const { session, daemonUrl, harness, harnessTemplates } = options;
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  const safeCwd = shellSafe(agentCwd);
  const justCreated = ensureSession(session, execSync);

  // Create or reuse tmux window
  if (justCreated) {
    try {
      execSync(`tmux rename-window -t "${safeSession}" "${safeName}"`, { stdio: "pipe" });
    } catch {
      execSync(`tmux new-window -n "${safeName}" -t "${safeSession}"`, { stdio: "pipe" });
    }
  } else {
    execSync(`tmux new-window -n "${safeName}" -t "${safeSession}"`, { stdio: "pipe" });
  }

  // Ensure permissive permission config for Pi-based agents
  if (harness === "pi") {
    ensurePermissiveConfig(agentCwd);
  }

  // Resolve the command template
  const template = harnessTemplates[harness] || harnessTemplates.pi;
  const cmd = template
    .replace(/\{name\}/g, shellSafe(name))
    .replace(/\{url\}/g, shellSafe(daemonUrl))
    .replace(/\{cwd\}/g, safeCwd);

  // Send the command to the tmux window
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" 'cd ${safeCwd} && ${cmd}' Enter`, { stdio: "pipe" });
}

/**
 * Dismiss an agent by sending Ctrl+C then exit to its tmux window.
 */
function dismissAgent(name: string, session: string, execSync: any): void {
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" C-c`, { stdio: "pipe" });
  setTimeout(() => {
    try {
      execSync(`tmux send-keys -t "${safeSession}:${safeName}" 'exit' Enter`, { stdio: "pipe" });
    } catch {
      // Window may already be gone
    }
  }, 1000);
}

/**
 * Ensure permissive permission config exists for autonomous Pi agents.
 * Writes to <cwd>/.pi/extensions/pi-permission-system/config.json
 */
function ensurePermissiveConfig(agentCwd: string): void {
  const configDir = path.join(agentCwd, ".pi", "extensions", "pi-permission-system");
  const configFile = path.join(configDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(configDir, { recursive: true });
    const permissiveConfig = {
      yoloMode: true,
      permission: { "*": "allow", bash: { "*": "allow" }, external_directory: "allow" },
    };
    fs.writeFileSync(configFile, JSON.stringify(permissiveConfig, null, 2) + "\n");
  }
}

// Leader role: tmux management, spawn request polling, LLM tools
//
// The leader no longer runs an HTTP server or SQLite store — the daemon
// owns all state. The leader's responsibilities are:
//   1. Register with the daemon as a "leader" agent
//   2. Poll for spawn requests and execute them via tmux
//   3. Provide slash commands for team management (spawn, dismiss, hop)
//   4. Register LLM tools (via shared tools.ts)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import { registerTools } from "./tools.js";

const SPAWN_POLL_INTERVAL_MS = 5000;

/** Sanitize a string for safe use in shell commands */
function shellSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._~/:@-]/g, "");
}

export async function setupLeader(
  pi: ExtensionAPI,
  ctx: any,
  client: DaemonClient,
  cwd: string
): Promise<void> {
  const { execSync } = await import("node:child_process");

  // Get host config from daemon (tmux session name, etc.)
  let tmuxSession = "pi-pizza-team";

  // Register with daemon
  try {
    const regRes = await client.register({ name: "leader", cwd });
    if (regRes.config?.tmuxSession) tmuxSession = regRes.config.tmuxSession;
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
    } catch {
      // Use default
    }
  }

  // Register LLM tools (stories, tasks, queue, search)
  registerTools(pi, client);

  // ─── Spawn Request Polling ─────────────────────────────────────────

  const spawnPollTimer = setInterval(async () => {
    try {
      const res = await client.getSpawnRequests();
      for (const req of res.requests) {
        try {
          spawnTeammate(req.name, req.cwd, { session: tmuxSession, daemonUrl: client.url }, execSync);
          await client.ackSpawnRequest(req.id);
        } catch (err: any) {
          // Log but don't crash — retry next poll
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
      const name = parts[0] || `teammate-${Date.now()}`;
      const spawnCwd = parts[1] || cwd;
      const resolvedCwd = spawnCwd.startsWith("~")
        ? spawnCwd.replace("~", process.env.HOME || "")
        : spawnCwd;

      try {
        spawnTeammate(name, resolvedCwd, { session: tmuxSession, daemonUrl: client.url }, execSync);
        cmdCtx.ui.notify(`✓ ${name} has joined the team working in ${spawnCwd} 🍕`, "info");
      } catch (err: any) {
        cmdCtx.ui.notify(`Failed to spawn ${name}: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("ppt-dismiss", {
    description: "Stop a teammate: /ppt-dismiss <name>",
    handler: async (args, cmdCtx) => {
      const name = args?.trim();
      if (!name) { cmdCtx.ui.notify("Usage: /ppt-dismiss <name>", "warning"); return; }

      try {
        const safeName = shellSafe(name);
        const safeSession = shellSafe(tmuxSession);
        execSync(`tmux send-keys -t "${safeSession}:${safeName}" C-c`, { stdio: "pipe" });
        setTimeout(() => {
          try { execSync(`tmux send-keys -t "${safeSession}:${safeName}" 'exit' Enter`, { stdio: "pipe" }); } catch {}
        }, 1000);
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
        cmdCtx.ui.notify(output, "info");
      } catch {
        cmdCtx.ui.notify("Cannot reach daemon", "error");
      }
    },
  });

  // ─── Widget ────────────────────────────────────────────────────────

  const updateWidget = async () => {
    try {
      const status = await client.getStatus();
      const parts = [`🍕 ${status.tasks.byStatus.done || 0}/${status.tasks.total} tasks done`];
      if (status.members.working > 0) parts.push(`${status.members.working} working`);
      if (status.inbox > 0) parts.push(`📬 ${status.inbox} inbox`);
      ctx.ui.setWidget("pi-pizza-team", [parts.join(" • ")]);
    } catch {
      ctx.ui.setWidget("pi-pizza-team", ["🍕 daemon unreachable"]);
    }
  };

  updateWidget();
  const widgetInterval = setInterval(updateWidget, 10000);

  // ─── Cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    clearInterval(spawnPollTimer);
    clearInterval(widgetInterval);
    await client.deregister().catch(() => {});
  });

  if (ctx.hasUI) {
    ctx.ui.notify(`🍕 pi-pizza-team lead connected to daemon at ${client.url}`, "info");
  }
}

// ─── tmux helpers ──────────────────────────────────────────────────────

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

function spawnTeammate(
  name: string,
  cwd: string,
  options: { session: string; daemonUrl: string },
  execSync: any
): void {
  const { session, daemonUrl } = options;
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  const safeCwd = shellSafe(cwd);
  const safeUrl = shellSafe(daemonUrl);
  const justCreated = ensureSession(session, execSync);

  if (justCreated) {
    try { execSync(`tmux rename-window -t "${safeSession}" "${safeName}"`, { stdio: "pipe" }); }
    catch { execSync(`tmux new-window -n "${safeName}" -t "${safeSession}"`, { stdio: "pipe" }); }
  } else {
    execSync(`tmux new-window -n "${safeName}" -t "${safeSession}"`, { stdio: "pipe" });
  }

  // Ensure permissive permission config
  const fs = require("node:fs");
  const path = require("node:path");
  const configDir = path.join(cwd, ".pi", "extensions", "pi-permission-system");
  const configFile = path.join(configDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(configDir, { recursive: true });
    const permissiveConfig = {
      yoloMode: true,
      permission: { "*": "allow", bash: { "*": "allow" }, external_directory: "allow" }
    };
    fs.writeFileSync(configFile, JSON.stringify(permissiveConfig, null, 2) + "\n");
  }

  const cmd = `cd ${safeCwd} && pi --ppt-worker --ppt-daemon=${safeUrl} --ppt-name=${safeName}`;
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" '${cmd}' Enter`, { stdio: "pipe" });
}

// Leader role: tmux management, directive polling, LLM tools
//
// The leader is the Pi-specific host coordinator. It doesn't own state —
// the daemon does. The leader's responsibilities are:
//   1. Register with daemon as { role: "leader", harness: "pi", hostId }
//   2. Poll GET /api/hosts/:hostId/leader/directives every 5s (one queue)
//   3. Realize each directive locally (spawn via tmux, reset via /new, ...)
//   4. Mark done: PUT /api/hosts/:hostId/leader/directives/:id { status }
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
  pi: "pi --ppt-worker --ppt-daemon={url} --ppt-name={name}{workArgs} --ppt-tmux-session={session} --ppt-tmux-window={window}",
  "pi-assistant": "pi --ppt-assistant --ppt-daemon={url} --ppt-name=assistant --ppt-tmux-session={session} --ppt-tmux-window={window}",
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
  let directories: string[] = [];
  let harnessTemplates: HarnessTemplates = { ...DEFAULT_HARNESS_TEMPLATES };

  // Register with daemon
  try {
    const regRes = await client.register({ name: "leader", capabilities: { directory: cwd } });
    if (regRes.config?.tmuxSession) tmuxSession = regRes.config.tmuxSession;
    if (regRes.config?.directories) directories = regRes.config.directories;
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
      if (hostConfig.directories?.length) directories = hostConfig.directories;
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
      const { directives } = await client.getLeaderDirectives();
      for (const directive of directives) {
        try {
          dispatchDirective(directive, { session: tmuxSession, daemonUrl: client.url, harnessTemplates, fallbackCwd: cwd }, execSync);
          await client.completeLeaderDirective(directive.id);
        } catch (err) {
          // A directive that can't be realized (e.g. an invalid spawn cwd) would
          // otherwise stay pending and be retried every poll cycle forever,
          // piling up empty tmux windows. Mark it failed so it leaves the queue.
          const reason = err instanceof Error ? err.message : String(err);
          if (ctx.hasUI) ctx.ui?.notify?.(`Spawn directive failed: ${reason}`, "error");
          await client.failLeaderDirective(directive.id).catch(() => {});
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
      const spawnCwd = parts[1] || (directories.length > 0 ? directories[0] : cwd);
      const resolvedCwd = resolvePath(spawnCwd);

      // Validate up front so an accidental/half-typed path gives immediate
      // feedback and never creates a directive that can't be realized.
      const cwdError = validateSpawnCwd(resolvedCwd);
      if (cwdError) { cmdCtx.ui.notify(`Cannot spawn: ${cwdError}`, "error"); return; }

      try {
        // Create a spawn directive so the daemon generates a unique name, then
        // realize it immediately and mark it done (so our own poll won't re-run it).
        const res = await client.createLeaderDirective("spawn", { params: { cwd: resolvedCwd } });
        const generated = (res.directive?.params?.name as string) || `agent-${Date.now()}`;
        const name = userProvidedName || generated;

        spawnAgent(name, resolvedCwd, {
          session: tmuxSession,
          daemonUrl: client.url,
          harness: "pi",
          harnessTemplates,
        }, execSync);

        if (res.directive) await client.completeLeaderDirective(res.directive.id);
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
    description: "Show recently used working directories for spawning",
    handler: async (_args, cmdCtx) => {
      if (directories.length === 0) {
        cmdCtx.ui.notify("No recent directories yet.\nThey're recorded as stories and agents use them.", "info");
        return;
      }
      let output = "📂 Recent directories:\n";
      for (const dir of directories) {
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
 *
 * Idempotent: returns false (without creating anything) if a window with the
 * given name already exists, so retried spawn directives can't pile up
 * duplicate windows. Returns true when a window was actually created.
 *
 * Throws if the working directory is invalid (missing / not a directory) so no
 * tmux window is created; the caller marks the directive failed rather than
 * retrying an ask that can never succeed.
 */
function spawnAgent(
  name: string,
  agentCwd: string,
  options: {
    session: string;
    daemonUrl: string;
    harness: string;
    harnessTemplates: HarnessTemplates;
    /** When set, spawn the teammate in assigned-story mode bound to this story. */
    storyId?: string;
  },
  execSync: any
): boolean {
  const { session, daemonUrl, harness, harnessTemplates, storyId } = options;
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  const safeCwd = shellSafe(agentCwd);

  // Validate the working directory BEFORE touching tmux. A bad cwd (e.g. a
  // half-typed path that was submitted by accident) would otherwise create an
  // empty window and then fail, leaving an orphan window and an un-acked
  // directive that retries forever. Throwing here keeps tmux untouched and lets
  // the caller mark the directive failed.
  const cwdError = validateSpawnCwd(agentCwd);
  if (cwdError) throw new Error(cwdError);

  const justCreated = ensureSession(session, execSync);

  // Idempotency guard: tmux does NOT enforce unique window names, so
  // `new-window -n <name>` would happily create a duplicate every time it
  // runs. If a spawn directive is retried (e.g. completion failed to reach the
  // daemon), that produces a pile of identically-named windows with no agent.
  // Bail out if a window with this name already exists in the session.
  if (!justCreated && listWindows(session, execSync).includes(name)) {
    return false;
  }

  // Ensure permissive permission config for Pi-based agents. This is a
  // convenience (skips permission prompts), not a requirement — so a failure
  // (e.g. a read-only cwd) must not abort the spawn. Do it before creating the
  // window so a throw here can't orphan one.
  if (harness === "pi") {
    try {
      ensurePermissiveConfig(agentCwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[ppt] Could not write permissive config in ${agentCwd}: ${reason}`);
    }
  }

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

  // Resolve the command template
  // A spawn request bound to a story becomes an assigned-story teammate that
  // dismisses itself once that story is complete.
  const workArgs = storyId
    ? ` --ppt-work-mode=assigned-story --ppt-story=${shellSafe(storyId)}`
    : "";
  const template = harnessTemplates[harness] || harnessTemplates.pi;
  const cmd = template
    .replace(/\{name\}/g, shellSafe(name))
    .replace(/\{url\}/g, shellSafe(daemonUrl))
    .replace(/\{cwd\}/g, safeCwd)
    .replace(/\{workArgs\}/g, workArgs)
    .replace(/\{session\}/g, safeSession)
    .replace(/\{window\}/g, safeName);

  // Send the command to the tmux window
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" 'cd ${safeCwd} && ${cmd}' Enter`, { stdio: "pipe" });
  return true;
}

/**
 * Realize a leader directive: dispatch by action to the right mechanism.
 * This is where all harness/tmux specifics live — the daemon only said what.
 */
function dispatchDirective(
  directive: { action: string; params: Record<string, unknown>; metadata: Record<string, unknown> },
  ctx: { session: string; daemonUrl: string; harnessTemplates: HarnessTemplates; fallbackCwd: string },
  execSync: any
): void {
  if (directive.action === "spawn") {
    const params = directive.params || {};
    const name = (params.name as string) || `agent-${Date.now()}`;
    let harness = (params.harness as string) || "pi";
    if (params.reason === "assistant") harness = "pi-assistant";
    spawnAgent(name, (params.cwd as string) || ctx.fallbackCwd, {
      session: ctx.session,
      daemonUrl: ctx.daemonUrl,
      harness,
      harnessTemplates: ctx.harnessTemplates,
      storyId: params.storyId as string | undefined,
    }, execSync);
    return;
  }
  // Actions on an existing agent are delivered via its tmux window.
  deliverAgentCommand(directive, ctx.session, execSync);
}

/**
 * Realize a daemon control intent by translating it into tmux keystrokes.
 *
 * This is where harness-specific mechanism lives — the daemon only expressed
 * intent (e.g. "reset-session"); the leader decides that means sending Pi's
 * `/new` command to the agent's tmux window. The target window comes from the
 * opaque metadata the agent reported at registration (which the leader itself
 * supplied at spawn time).
 */
function deliverAgentCommand(
  command: { action: string; metadata: Record<string, unknown> },
  leaderSession: string,
  execSync: any
): void {
  const window = typeof command.metadata?.tmuxWindow === "string" ? command.metadata.tmuxWindow : "";
  if (!window) return; // Can't target without a window
  const session = typeof command.metadata?.tmuxSession === "string" ? command.metadata.tmuxSession : leaderSession;
  const target = `${shellSafe(session)}:${shellSafe(window)}`;

  // Map abstract intent -> Pi keystrokes.
  const keysByAction: Record<string, string> = {
    "reset-session": "/new",
  };
  const keys = keysByAction[command.action];
  if (!keys) return; // Unknown intent — ignore

  execSync(`tmux send-keys -t "${target}" '${keys}' Enter`, { stdio: "pipe" });
}

/**
 * Dismiss an agent by sending Ctrl+C then exit to its tmux window.
 */
function dismissAgent(name: string, session: string, execSync: any): void {
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  // Send Ctrl+C to interrupt Pi, then kill the tmux window after a brief delay
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" C-c`, { stdio: "pipe" });
  setTimeout(() => {
    try {
      execSync(`tmux kill-window -t "${safeSession}:${safeName}"`, { stdio: "pipe" });
    } catch {
      // Window may already be gone
    }
  }, 2000);
}

/**
 * Validate a spawn working directory. Returns an error message if the path is
 * unusable, or null if it's a real directory.
 *
 * Guards against accidental spawns (e.g. a half-typed path submitted early)
 * that would otherwise create an orphan tmux window and a directive that can
 * never succeed.
 */
function validateSpawnCwd(agentCwd: string): string | null {
  if (!agentCwd || !agentCwd.trim()) return "No working directory specified";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(agentCwd);
  } catch {
    return `Working directory does not exist: ${agentCwd}`;
  }
  if (!stat.isDirectory()) return `Not a directory: ${agentCwd}`;
  return null;
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

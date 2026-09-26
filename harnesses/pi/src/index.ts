// pi-pizza-team extension entry point
//
// Role detection logic:
// 1. If --ppt-worker flag → Teammate (autonomous agent)
// 2. If --ppt-lead flag OR .my-pizza-team/config.json exists → Leader, which is
//    also the agent you chat with (see chat.ts; there is no separate assistant)
// 3. Otherwise → Inactive (only /ppt-help available)
//
// --ppt-assistant is retired: it named a dedicated chat process that the leader
// now subsumes. The flag is still accepted so an old spawn command doesn't hard
// fail — it just explains itself and stays inactive.
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
import { summarizeRun, hasUsage } from "./usage.js";

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

  // Retired (kept so old spawn commands / templates don't crash on an unknown
  // flag). The leader answers the chat now.
  pi.registerFlag("ppt-assistant", {
    description: "Deprecated: the leader is the chat agent; this flag does nothing",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ppt-daemon", {
    description: "Daemon URL (default: http://localhost:7437)",
    type: "string",
    default: "",
  });

  // Leader-only: a host-level readiness probe. The leader runs this command each
  // heartbeat; exit 0 = ready, non-zero = not ready (stdout's first line is the
  // reason). A not-ready host makes the daemon hold scheduled work destined for
  // it instead of failing it (e.g. while cloud-desktop credentials are expired).
  // Falls back to the PPT_READINESS_PROBE env var. See docs/ARCHITECTURE.md.
  pi.registerFlag("ppt-readiness-probe", {
    description: "Leader host-readiness probe command (exit 0 = ready). Also PPT_READINESS_PROBE env var.",
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
      // All teammates are generalists biased by their working directory (the pi
      // cwd). Directory affinity is the only work-selection signal.
      await setupTeammate(pi, ctx, client, memberId, cwd);
      return;
    }

    // ─── RETIRED ASSISTANT ROLE ────────────────────────────────────

    if (isAssistant) {
      // Registering as a second chat participant would double-answer every
      // message, so do nothing but explain (the daemon designates one leader).
      if (ctx.hasUI) {
        ctx.ui.notify(
          "🤖 --ppt-assistant is retired: the leader is the agent you chat with. Close this window and chat with the leader (or the web UI).",
          "warning",
        );
      }
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
): Promise<void> {
  const { TeammateLoop } = await import("./teammate.js");
  const { registerPermissionBypass, registerAutonomousAuthorizer } = await import("./permissions.js");
  const { registerTeammateTools } = await import("./tools.js");

  // Check daemon reachability
  const serverUp = await client.checkHealth();
  if (!serverUp && ctx.hasUI) {
    ctx.ui.notify(`🍕 Cannot reach daemon at ${client.url} — will retry...`, "warning");
  }

  // Register with the daemon. The agent's working directory (its pi cwd) is the
  // only work-selection signal — the daemon biases matching by directory.
  try {
    await client.register({
      name: memberId,
      directory: cwd,
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

  // Register tools. The `fail` tool lets the agent give up on a claimed work
  // item with a comment when it can't proceed; the loop then skips COMPLETE.
  registerTeammateTools(pi, client, () => loop.currentTask || loop.lastTask, (workItemId) => loop.markReturned(workItemId));

  // Permission bypass (auto-pause on interactive input). Returns this agent's
  // lease on the directory's shared permission config (see permissions.ts).
  const permissions = registerPermissionBypass(
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

  // Authorizer chain link: auto-allows fail-closed asks (e.g. the bash
  // indirection-wrapper floor on `timeout`/`nohup` commands, which even
  // yoloMode can't approve) while autonomous; defers to the human while
  // pairing. Activated via `authorizerChain` in the config we write.
  registerAutonomousAuthorizer(pi, () => loop.isAutonomous);

  // Wire permission toggler to the loop
  loop.setAutonomousPermissions = (autonomous: boolean) => {
    permissions.setYolo(autonomous);
  };

  // ─── agent_start: track loop activity ──────────────────────────
  // Also marks the run that picks up a work prompt as that WorkItem's own run,
  // so agent_end can tell completion from a foreign run (see teammate.ts).

  pi.on("agent_start" as any, async () => {
    debug(`[ppt-debug agent_start] fired. isAutonomous=${loop.isAutonomous} currentTask=${loop.currentTask}`);
    loop.handleAgentStart();
  });

  // ─── agent_end: capture results ──────────────────────────────────

  // The latest assistant prose from any run — the summary if a web pairing is
  // released with "complete" while idle (the run that produced it is over).
  let lastAssistantText = "";

  pi.on("agent_end", async (event) => {
    const debugPrefix = `[ppt-debug agent_end]`;
    debug(`${debugPrefix} fired. isAutonomous=${loop.isAutonomous} currentTask=${loop.currentTask}`);
    // Bookkeeping first (unconditional): no run is in flight anymore, so the
    // loop is free to claim again.
    loop.handleAgentEnd();

    const usage = summarizeRun(event.messages as any);
    const lastText = usage.lastText;

    // Every run goes in the usage ledger, labelled by what it was (usage.ts):
    // this item's own run → `work` (billed to the item); a run while a human
    // pairs → `pairing` (still on the held item, if any); anything else (a
    // slash command, the previous item's wrap-up) → `other`, never billed to
    // the item. Decided before release/completion below changes the state.
    if (hasUsage(usage)) {
      const kind = !loop.isAutonomous ? "pairing" : loop.ownsCurrentRun ? "work" : "other";
      const workItemId = kind === "other" ? undefined : loop.currentTask ?? undefined;
      await client.reportUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        model: usage.model,
        costUsd: usage.costUsd,
        kind,
        workItemId,
      }).catch(() => {});
    }

    if (lastText) lastAssistantText = lastText;

    // A web-pairing release that arrived mid-run lands now that the run is over
    // (see TeammateLoop.releasePairing) — and this run is not a completion.
    if (loop.hasPendingRelease) {
      debug(`${debugPrefix} applying deferred pairing release`);
      await loop.applyPendingRelease(lastAssistantText);
      return;
    }

    if (!loop.isAutonomous || !loop.currentTask) {
      debug(`${debugPrefix} skipping — guard failed`);
      return;
    }

    debug(`${debugPrefix} lastText length=${lastText.length}, tokens in=${usage.inputTokens} out=${usage.outputTokens} cacheR=${usage.cacheReadTokens} cacheW=${usage.cacheWriteTokens}, cost=${usage.costUsd}, model=${usage.model}`);

    await loop.handleAgentComplete(lastText);
  });

  // ─── Live transcript (web UI watch view) ─────────────────────────
  // Mirrors this session to the daemon only while someone has the teammate's
  // view open (see transcript.ts). Its own pi.on registrations, separate from
  // the work loop's, so the two concerns never share a handler.
  const { TranscriptMirror } = await import("./transcript.js");
  const transcript = new TranscriptMirror(client);
  pi.on("input", async (event) => { transcript.onInput(event.text, event.source, event.streamingBehavior); });
  pi.on("agent_start", async () => { transcript.onAgentStart(); });
  pi.on("agent_end", async () => { transcript.onAgentEnd(); });
  pi.on("message_start", async (event) => { transcript.onMessageStart(event.message as any); });
  pi.on("message_update", async (event) => { transcript.onMessageUpdate(event.message as any); });
  pi.on("message_end", async (event) => { transcript.onMessageEnd(event.message as any); });
  pi.on("tool_execution_start", async (event) => { transcript.onToolStart(event.toolCallId, event.toolName, event.args); });
  pi.on("tool_execution_end", async (event) => {
    transcript.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
  });
  transcript.start().catch(() => {});

  // ─── Web pairing (talk to this teammate from the browser) ────────
  // Pairing pauses the work loop (like typing in this pane, but permissions
  // stay autonomous — nobody is at this terminal to answer a prompt); messages
  // are handed to Pi, queued behind a run in flight unless sent as "steer";
  // release hands the held work item back (see pairing.ts, teammate.ts).
  const { WebPairing } = await import("./pairing.js");
  const pairing = new WebPairing(client, {
    onPair: () => {
      loop.pause();
      if (ctx.hasUI) {
        ctx.ui.setWidget("pi-pizza-team", ["🍕 paired from the web UI — autonomous work paused"]);
        ctx.ui.notify("🍕 Paired from the web UI — autonomous work paused until released there.", "info");
      }
    },
    onMessage: (text, mode) => {
      transcript.expectWebInput(text);
      pi.sendUserMessage(text, loop.isAgentRunning ? { deliverAs: mode === "steer" ? "steer" : "followUp" } : undefined);
    },
    onRelease: async (action) => {
      await loop.releasePairing(action, lastAssistantText);
      if (ctx.hasUI) ctx.ui.notify(`🍕 Released from web pairing (${action}).`, "info");
    },
  }, () => transcript.isWatched);
  pairing.start();

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
    // expandPromptTemplates must be true: pi.sendUserMessage() defaults to
    // false, which delivers "/ppt-fresh-session" to the LLM as *literal text*
    // instead of dispatching the registered extension command. That silently
    // skipped the reset (teammates would narrate the slash command back at the
    // lead and keep their stale context) — see DESIGN.md "Fresh session".
    pi.sendUserMessage("/ppt-fresh-session", { deliverAs: "followUp", expandPromptTemplates: true });
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

  // Re-register when the daemon reports it doesn't know us (restart/upgrade),
  // so an `mpt upgrade` or daemon restart doesn't shut down a running teammate.
  loop.reregister = async () => {
    await client.register({ name: memberId, directory: cwd, metadata: readTmuxMetadata(pi) }).catch(() => {});
    if (ctx.hasUI) ctx.ui.notify("🍕 Reconnected to daemon (it had restarted).", "info");
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
    transcript.stop();
    pairing.stop();
    // Drop our lease; the last agent out restores the directory's config. A
    // fresh-session reset re-acquires in the new instance moments later.
    permissions.release();
    // Self-reset between work items: keep the daemon registration alive so
    // the member doesn't flicker offline; the fresh instance re-registers.
    if (resettingForFreshSession) return;
    await client.deregister().catch(() => {});
  });
}


// Leader role: daemon registration, LLM tools, slash commands, and the team chat
//
// The leader is the Pi-specific host coordinator *and* the agent you talk to.
// There is no separate assistant process: the leader already runs per host, its
// session holds no human work, and chat v2's mirror is role-agnostic — so it
// doubles as the chat participant (see chat.ts and DESIGN.md "One agent to talk
// to"). The daemon designates one leader as the chat agent so a multi-host team
// can't answer twice.
//
// It doesn't own state — the daemon does. And it never touches tmux: the daemon
// is the only thing that does (my-pizza-team docs/DESIGN.md "The Daemon Is the
// Supervisor"), so spawning, dismissing and switching windows are asks to the
// daemon. The leader's responsibilities are:
//   1. Register with daemon as { name: "leader", harness: "pi", + handshake }
//   2. Register LLM tools for planning work, active only for the work-item
//      kinds the team has on (features.ts; re-checked on every status read)
//   3. Provide /ppt-spawn, /ppt-dismiss, /ppt-hop, /ppt-status — each a daemon
//      call (a spawn directive, a dismiss, POST /api/agents/:id/focus, status)
//   4. Show status widget with team progress
//   5. Mirror the daemon's chat into this Pi session and back (ChatMirror),
//      including its own new-session/resume-session self-directives

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./runtime/client.js";
import { ALL_FEATURES_ON, type Features, featuresFromStatus } from "./shared/agent-protocol.js";
import { registerLeaderTools } from "./tools.js";
import { applyFeatureTools, featurePromptNote } from "./features.js";
import { summarizeRun, hasUsage } from "./runtime/usage.js";
import { LEADER_WINDOW } from "./shared/types.js";

const WIDGET_UPDATE_INTERVAL_MS = 10000;

/** This leader's tmux location, when it was told (see `mpt lead`). */
function readLeaderTmuxMetadata(pi: ExtensionAPI): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const window = ((pi.getFlag("ppt-tmux-window") as string) || "").trim();
  const session = ((pi.getFlag("ppt-tmux-session") as string) || "").trim();
  if (window) metadata.tmuxWindow = window;
  if (session) metadata.tmuxSession = session;
  return metadata;
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
  // Registration is retryable, not a one-shot at startup: the leader may start
  // while the daemon is down, or the daemon may restart and forget us, so the
  // heartbeat re-registers until it succeeds (registered).
  let registered = false;

  /**
   * Register with the daemon. Safe to call repeatedly; throws if the daemon is
   * unreachable so callers can retry later.
   */
  async function registerWithDaemon(): Promise<void> {
    // Report where this leader lives in tmux, as opaque metadata: the daemon relays
    // it verbatim and uses it to address the right window. `mpt lead` passes these
    // flags; a hand-started `pi` simply reports nothing. The leader itself never
    // reads them back — it doesn't touch tmux (docs/DESIGN.md "The Daemon Is the
    // Supervisor").
    await client.register({
      name: "leader",
      directory: cwd,
      metadata: readLeaderTmuxMetadata(pi),
    });
    registered = true;
  }

  // Register with daemon
  try {
    await registerWithDaemon();
  } catch {
    if (ctx.hasUI) {
      ctx.ui.notify(`🍕 Failed to register with daemon — will retry via heartbeat`, "warning");
    }
  }

  // Register LLM tools (stories, tasks, queue, search)
  registerLeaderTools(pi, client);

  // ─── Feature toggles ───────────────────────────────────────────────
  // Every tool is registered above; the ones owned by a switched-off kind are
  // kept out of the active set. Re-checked from /api/status now, before every
  // run, and on the widget poll, so a Config change applies without a restart
  // (features.ts). Until the daemon answers, nothing is hidden: the daemon's 403
  // is the backstop.
  let features: Features = ALL_FEATURES_ON;
  const adoptFeatures = (next: Features) => {
    features = next;
    applyFeatureTools(pi, features);
  };
  const syncFeatures = async () => {
    try { adoptFeatures(featuresFromStatus(await client.getStatus())); } catch { /* keep the last known */ }
  };
  await syncFeatures();

  // ─── Leader Heartbeat ──────────────────────────────────────────────
  // Send periodic heartbeats so the daemon knows the leader is alive.
  // Without this, the daemon's reaper marks the leader as offline.
  // The heartbeat also doubles as the registration retry loop: if the initial
  // registration failed (daemon not up yet) or the daemon restarted and no
  // longer knows us (heartbeat reports dismissed), re-register.
  //
  // The readiness probe is the *daemon's* job now (P3-2). While it lived here, a
  // machine too wedged for the leader to start was reported as healthy — nothing
  // reported means ready — so work kept being scheduled into it. The daemon runs
  // whenever it matters and answers with no agents connected.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTick = async () => {
    if (!registered) {
      try { await registerWithDaemon(); } catch { /* daemon still unreachable */ }
    }
    const res = await client.heartbeat("idle");
    if (res.dismissed || res.reregister) {
      // The daemon doesn't know us (it restarted, or forgot us) — re-register.
      registered = false;
      try { await registerWithDaemon(); } catch { /* retry next beat */ }
    }
  };
  const heartbeatTimer = setInterval(() => { heartbeatTick().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  // Send an initial heartbeat immediately
  heartbeatTick().catch(() => {});

  // There is no leader-directive poll. The daemon realizes `spawn` and `dismiss`
  // itself (daemon/spawner.ts) and a reset goes to the agent it is for — this
  // leader's own new-session/resume-session arrive through the chat mirror's
  // self-directive poll (chat.ts). Nothing is left in the queue for a leader.

  // ─── Slash Commands ────────────────────────────────────────────────
  //
  // Every one goes through the daemon, which is the only thing that touches tmux
  // (docs/DESIGN.md "The Daemon Is the Supervisor"). The leader asks; it never
  // runs tmux itself.

  pi.registerCommand("ppt-spawn", {
    description: "Hire a new teammate: /ppt-spawn [name] [cwd]",
    handler: async (args, cmdCtx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const userProvidedName = parts[0] || undefined;
      const spawnCwd = parts[1] || cwd;
      const resolvedCwd = resolvePath(spawnCwd);

      // Validate up front so an accidental/half-typed path gives immediate
      // feedback and never creates a directive that can't be realized.
      const cwdError = validateSpawnCwd(resolvedCwd);
      if (cwdError) { cmdCtx.ui.notify(`Cannot spawn: ${cwdError}`, "error"); return; }

      try {
        // A `spawn` directive, like the UI's Add teammate: the daemon names it
        // (unless a name was given) and opens its window, or fails it with a reason.
        const params: Record<string, unknown> = { cwd: resolvedCwd };
        if (userProvidedName) params.name = userProvidedName;
        const res = await client.createLeaderDirective("spawn", { params });
        if (!res.directive) throw new Error(res.error || "the daemon created no spawn directive");
        const name = (res.directive.params?.name as string) || userProvidedName || "the new teammate";

        const outcome = await awaitSpawn(client, res.directive.id, res.directive.status);
        if (outcome.state === "failed") cmdCtx.ui.notify(`Failed to spawn ${name}: ${outcome.error}`, "error");
        else if (outcome.state === "pending") cmdCtx.ui.notify(`${name} is still waiting to be spawned — see the Team tab`, "warning");
        else cmdCtx.ui.notify(`✓ ${name} has joined the team working in ${spawnCwd} 🍕`, "info");
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

      if (name === LEADER_WINDOW) { cmdCtx.ui.notify("The leader can't dismiss itself", "warning"); return; }

      // The same path as the UI's dismiss: the daemon tombstones the teammate so it
      // exits by itself, and its `dismiss` directive closes the window once it has
      // (daemon/spawner.ts realizeDismiss).
      try {
        const member = await findAgent(client, name);
        if (!member) { cmdCtx.ui.notify(`"${name}" is not a registered teammate`, "error"); return; }
        await client.dismissAgent(member.id);
        cmdCtx.ui.notify(`✓ ${name} is leaving the team (its window closes once it exits)`, "info");
      } catch (err: any) {
        cmdCtx.ui.notify(`Failed to dismiss ${name}: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("ppt-hop", {
    description: "Jump to a teammate's tmux window: /ppt-hop <name>",
    handler: async (args, cmdCtx) => {
      const name = args?.trim();
      if (!name) { cmdCtx.ui.notify("Usage: /ppt-hop <name>", "warning"); return; }
      // The daemon selects the window (POST /api/agents/:id/focus).
      try {
        const member = await findAgent(client, name);
        if (!member) { cmdCtx.ui.notify(`"${name}" is not a registered teammate`, "error"); return; }
        await client.focusAgent(member.id);
        cmdCtx.ui.notify(`→ Switching to ${name}'s window`, "info");
      } catch (err: any) {
        cmdCtx.ui.notify(`Cannot switch to ${name}: ${err.message}`, "error");
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
        if (featuresFromStatus(status).stories) output += `  Stories: ${status.stories.open} open, ${status.stories.done} done\n`;
        output += `  Tasks: ${status.tasks.total} total`;
        const byStatus = Object.entries(status.tasks.byStatus).map(([s, n]) => `${n} ${s}`).join(", ");
        if (byStatus) output += ` (${byStatus})`;
        output += `\n  Team: ${status.members.total} members (${status.members.working} working, ${status.members.idle} idle)\n`;

        // The teammates, as the daemon knows them (not tmux's window list); the
        // leader registers as "leader", the same name as its window.
        const teammates = (await client.listAgents()).agents.filter((a) => a.name !== LEADER_WINDOW);
        output += `\n  Teammates: ${teammates.length > 0 ? teammates.map((a) => `${a.name} (${a.status})`).join(", ") : "none"}\n`;

        cmdCtx.ui.notify(output, "info");
      } catch {
        cmdCtx.ui.notify("Cannot reach daemon", "error");
      }
    },
  });

  // ─── Chat mirror (the leader is the agent you talk to) ─────────────
  //
  // Everything below only *reports* what Pi did; the daemon decides nothing about
  // behavior. The mirror stays quiet unless the daemon designated us as the chat
  // agent (see ChatMirror + /api/assistant/inbox).

  const { ChatMirror } = await import("./chat.js");
  const { registerChatAgentPermissions, registerAutonomousAuthorizer } = await import("./permissions.js");
  const chat = new ChatMirror(pi, client);

  // A web-driven run has nobody at the terminal, so a permission prompt would
  // hang the chat with no visible cause. Turn on yoloMode while the run was
  // triggered remotely, and register the chain link that answers the fail-closed
  // asks yolo can't rewrite (the bash indirection-wrapper floor).
  const chatPermissions = registerChatAgentPermissions(pi, cwd);
  const disposeAuthorizer = registerAutonomousAuthorizer(
    pi.events,
    ctx.sessionManager?.getSessionId?.(),
    chatPermissions.isRemoteDriven,
  );
  pi.on("session_shutdown", async () => { disposeAuthorizer(); });

  // Persona: the daemon vends the chat-mode framing (assistant.chatMode) + the
  // selected persona (or its default), injected as the system prompt on every
  // run. Refetched here, before the prompt is built, so a Config change applies
  // to the next run with no restart or session reset.
  // Also the per-run feature refresh: the tool set and a note naming the kinds
  // that are off (features.ts featurePromptNote).
  pi.on("before_agent_start", async (event) => {
    await chat.refreshPersona();
    await syncFeatures();
    const extra = [chat.persona, featurePromptNote(features)].filter(Boolean);
    if (extra.length === 0) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${extra.join("\n\n")}` };
  });

  // Report the Pi session backing the chat so a conversation can be resumed.
  await chat.reportSession(ctx.sessionManager?.getSessionFile?.() ?? null);

  // Anything typed in this window is part of the same conversation.
  pi.on("input", async (event) => {
    if (event.source !== "interactive") return;
    await chat.mirrorTerminalInput(event.text);
  });

  pi.on("agent_start", async () => { await chat.handleAgentStart(); });

  // Reasoning deltas feed the ephemeral "peek behind the …" buffer.
  pi.on("message_update", (event) => {
    const message = event.message as { role?: string; content?: Array<{ type: string; thinking?: string }> };
    if (message?.role !== "assistant") return;
    for (const part of message.content || []) {
      if (part.type === "thinking" && typeof part.thinking === "string") chat.handleReasoning(part.thinking);
    }
  });

  // Each finished assistant message becomes chat bubbles. This fires for
  // intermediate messages too, so prose emitted before tool calls arrives live.
  // Always call through (even with no text): the mirror resets its per-message
  // reasoning offset on this boundary.
  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; content?: Array<{ type: string; text?: string }> };
    if (message?.role !== "assistant") return;
    const text = (message.content || [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n\n");
    await chat.handleAssistantMessageEnd(text);
  });

  pi.on("agent_settled", async () => { await chat.handleAgentSettled(); });

  // Usage ledger: the leader's runs are the chat (web or its own pane), so
  // they're reported as `chat` — the part of the spend that used to go
  // uncounted (usage.ts; my-pizza-team daemon/routes/usage.ts).
  pi.on("agent_end", async (event) => {
    const usage = summarizeRun((event as { messages?: unknown[] }).messages as any);
    if (!hasUsage(usage)) return;
    await client.reportUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      model: usage.model,
      costUsd: usage.costUsd,
      kind: "chat",
    }).catch(() => {});
  });

  // Session control: "New chat" / "Resume" from the web UI. newSession() and
  // switchSession() only exist on COMMAND contexts, so the daemon's directives
  // are realized by queueing these commands (same pattern as the teammate's
  // /ppt-fresh-session). Post-switch work must use the withSession ctx — captured
  // pi/ctx objects are stale after a session is replaced.
  const reportReplacement = async (replacementCtx: any) => {
    await client.reportPiSession(replacementCtx.sessionManager?.getSessionFile?.() ?? "").catch(() => {});
  };

  pi.registerCommand("ppt-chat-new-session", {
    description: "Start a fresh chat session (queued by the chat's New chat action)",
    handler: async (_args: unknown, cmdCtx: any) => {
      await cmdCtx.newSession({
        parentSession: cmdCtx.sessionManager?.getSessionFile?.(),
        withSession: reportReplacement,
      });
    },
  });

  pi.registerCommand("ppt-chat-resume", {
    description: "Resume an earlier chat session: /ppt-chat-resume <pi-session-file>",
    handler: async (args: unknown, cmdCtx: any) => {
      const file = String(args ?? "").trim();
      if (!file || !fs.existsSync(file)) {
        cmdCtx.ui?.notify?.(`Cannot resume: no such Pi session file (${file || "none given"})`, "error");
        return;
      }
      await cmdCtx.switchSession(file, { withSession: reportReplacement });
    },
  });

  // expandPromptTemplates must be true: pi.sendUserMessage() defaults to false,
  // which hands the slash command to the LLM as *literal text* instead of
  // dispatching the registered command — the session never rolls and the
  // assistant narrates the command back (same bug as the teammate's
  // /ppt-fresh-session; see DESIGN.md "Fresh session").
  chat.onSessionDirective = async (action, params) => {
    if (action === "new-session") {
      pi.sendUserMessage("/ppt-chat-new-session", { deliverAs: "followUp", expandPromptTemplates: true });
      return;
    }
    if (action === "resume-session") {
      const file = typeof params.piSessionPath === "string" ? params.piSessionPath : "";
      if (!file) throw new Error("resume-session directive carried no piSessionPath");
      pi.sendUserMessage(`/ppt-chat-resume ${file}`, { deliverAs: "followUp", expandPromptTemplates: true });
    }
  };

  // ─── Live transcript (the assistant's terminal mode) ──────────────
  // Exactly a teammate's watch view: the same mirror, wired by the same function
  // (session-transcript.ts), streaming only while the dock's terminal view is
  // open (assistant.chatMode: "terminal"). It runs in both modes — unwatched it
  // costs nothing — so switching modes needs no restart. Inbox messages are
  // handed to Pi through the same delivery as a teammate's web pairing, so they
  // are tagged `web` and keep the composer's queue/steer choice.
  const { TranscriptMirror } = await import("./runtime/transcript.js");
  const { attachTranscriptMirror, deliverWebMessage } = await import("./session-transcript.js");
  const transcript = attachTranscriptMirror(pi, new TranscriptMirror(client));
  chat.onDeliver = (text, mode) => { deliverWebMessage(pi, transcript, text, mode, chat.isAgentRunning); };

  await chat.start();

  // ─── Widget (and the idle feature-toggle refresh) ───────────────────

  const updateWidget = async () => {
    try {
      const status = await client.getStatus();
      // Runs headless too: this poll is what keeps the tool set current between runs.
      adoptFeatures(featuresFromStatus(status));
      if (!ctx.hasUI) return;
      const done = status.tasks.byStatus.done || 0;
      const parts = [`🍕 ${done}/${status.tasks.total} tasks done`];
      if (status.members.working > 0) parts.push(`${status.members.working} working`);
      ctx.ui.setWidget("pi-pizza-team", [parts.join(" • ")]);
    } catch {
      if (ctx.hasUI) ctx.ui.setWidget("pi-pizza-team", ["🍕 daemon unreachable"]);
    }
  };

  updateWidget();
  const widgetInterval = setInterval(updateWidget, WIDGET_UPDATE_INTERVAL_MS);

  // ─── Cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    clearInterval(heartbeatTimer);
    clearInterval(widgetInterval);
    chat.stop();
    // A chat-driven session roll (New chat / Resume) shuts this session down and
    // immediately starts another that re-registers under the same name. Skipping
    // deregistration keeps the leader from flickering offline — and keeps the
    // chat-agent designation from hopping to another host mid-conversation.
    if (chat.isRollingSession) return;
    await client.deregister().catch(() => {});
  });

  if (ctx.hasUI) {
    ctx.ui.notify(`🍕 pi-pizza-team lead connected to daemon at ${client.url}`, "info");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SLASH-COMMAND HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** How long /ppt-spawn waits for the daemon to realize its spawn before reporting it pending. */
const SPAWN_WAIT_MS = 15_000;
const SPAWN_WAIT_POLL_MS = 500;

/** Resolve ~ and relative paths */
function resolvePath(p: string): string {
  if (p.startsWith("~")) return p.replace("~", process.env.HOME || "");
  return path.resolve(p);
}

/** A registered agent by name (the daemon's member list), or null. */
async function findAgent(client: DaemonClient, name: string): Promise<{ id: string; name: string } | null> {
  const { agents } = await client.listAgents();
  return agents.find((a) => a.name === name) ?? null;
}

/**
 * Wait briefly for the daemon to realize a spawn directive: `done` once it has
 * left the pending list without failing, `failed` with the daemon's reason, or
 * `pending` if it's still queued after SPAWN_WAIT_MS. The daemon's spawner runs
 * every couple of seconds, so a healthy spawn settles well inside the wait.
 */
async function awaitSpawn(
  client: DaemonClient,
  directiveId: string,
  initialStatus: string,
): Promise<{ state: "done" | "pending" } | { state: "failed"; error: string }> {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  for (;;) {
    const { requests, failed } = await client.getSpawnRequests();
    const failure = failed.find((f) => f.id === directiveId);
    if (failure) return { state: "failed", error: failure.error || "the daemon could not spawn it" };
    // Created failed but already gone from the failed list (e.g. cleared): still a failure.
    if (initialStatus === "failed") return { state: "failed", error: "the daemon could not spawn it" };
    if (!requests.some((r) => r.id === directiveId)) return { state: "done" };
    if (Date.now() >= deadline) return { state: "pending" };
    await new Promise((r) => setTimeout(r, SPAWN_WAIT_POLL_MS));
  }
}

/**
 * Validate a spawn working directory. Returns an error message if the path is
 * unusable, or null if it's a real directory.
 *
 * Guards against accidental spawns (e.g. a half-typed path submitted early):
 * the daemon would fail the directive anyway, but this answers at once, before
 * any directive exists.
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

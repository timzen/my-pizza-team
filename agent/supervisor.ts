/**
 * agent/supervisor.ts — `mpt agent`: run a non-Pi coding agent as a teammate.
 *
 * The Pi extension does a teammate's supervision *inside* Pi. An ACP agent has no
 * extension, so this does it from outside: it runs in the teammate's tmux window,
 * starts the agent as a child speaking ACP (agent/acp.ts), and speaks the daemon's
 * agent protocol through the same harness-agnostic client the Pi extension uses
 * (harnesses/pi/src/runtime/). Living in the tmux window rather than in the daemon
 * keeps the property Pi teammates have: a daemon restart or upgrade doesn't kill
 * them — they re-register.
 *
 * Per work item, the same shape as the Pi teammate loop:
 *   poll → claim → a fresh ACP session (a fresh context) → the daemon's prompt →
 *   `end_turn` = COMPLETE with the last reply as the summary comment.
 * Giving up is explicit: the prompt tells the agent to run `mpt agent fail "<why>"`,
 * which fails the item through the daemon; the supervisor then finds it FAILED and
 * doesn't complete it. Any other stop reason, or the agent dying, fails the item
 * with the reason — nothing is left hanging.
 *
 * Also: permission requests are answered "allow once" (it's autonomous), usage is
 * reported when the agent gives it (tokens, and cost in USD — never credits), and
 * the session is mirrored to the web watch view while someone is watching.
 * Not yet: pairing from the web UI (TODO.md).
 */

import { AcpConnection, AcpError, permissionOutcome, type AcpIncoming, type PromptResult } from "./acp.ts";
import { DaemonError, type DaemonClient } from "../harnesses/pi/src/runtime/client.ts";
import { TranscriptMirror } from "../harnesses/pi/src/runtime/transcript.ts";

export interface SupervisorOptions {
  client: DaemonClient;
  /** The member name (the daemon assigns it at spawn). */
  name: string;
  cwd: string;
  harness: { name: string; title: string; mode?: string };
  launch: { command: string[]; env?: Record<string, string> };
  /** The shell command (quoted) the agent runs to give up, before its reason argument. */
  failCommand: string;
  /** Environment the agent's own shell tools inherit, so `failCommand` reaches the daemon. */
  agentEnv: Record<string, string>;
  metadata?: Record<string, unknown>;
  /** Where readable progress goes (the tmux window). */
  out?: (text: string) => void;
  pollMs?: number;
  heartbeatMs?: number;
}

/** Appended to the daemon's prompt — the one piece of framing a harness adds (DESIGN.md "The Daemon Owns the Prompt"). */
export function failInstructions(failCommand: string): string {
  return [
    "## If You Cannot Proceed",
    "",
    "If you genuinely cannot make progress (missing information, no access, prerequisites not met), give up",
    "on this work item by running this shell command, with your reason in place of the placeholder, then stop:",
    "",
    `\`${failCommand} "<what is blocking you, and what you need>"\``,
    "",
    "Do not run it for finished work. When you're done, end your turn with a short summary of what you did —",
    "that summary is how the work is recorded.",
  ].join("\n");
}

/** One turn's worth of what the agent said, split at tool calls (the summary is the last segment). */
interface Turn {
  segments: string[];
  thinking: string;
  costUsd: number | null;
  model: string | null;
  tools: Map<string, string>;
}

export class AgentSupervisor {
  private acp!: AcpConnection;
  private mirror: TranscriptMirror;
  private running = false;
  private currentItem: string | null = null;
  private sessionId: string | null = null;
  private turn: Turn | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private exitCode = 0;
  private stopped!: () => void;
  private readonly done = new Promise<void>((r) => { this.stopped = r; });
  private readonly out: (text: string) => void;

  constructor(private opts: SupervisorOptions) {
    this.out = opts.out ?? ((t) => { Deno.stdout.writeSync(new TextEncoder().encode(t)); });
    this.mirror = new TranscriptMirror(opts.client, { instance: `${opts.harness.name}-${Date.now()}` });
  }

  /** Run until dismissed, stopped, or the agent dies. Resolves with an exit code. */
  async run(): Promise<number> {
    const { client, harness, launch, cwd } = this.opts;
    this.line(`🍕 ${this.opts.name} — ${harness.title} teammate (experimental), in ${cwd}`);

    this.acp = AcpConnection.spawn(launch.command, {
      cwd,
      env: { ...Deno.env.toObject(), ...launch.env, ...this.opts.agentEnv },
      onStderr: () => {},
    });
    this.acp.onNotification((m) => this.onNotification(m));
    this.acp.onRequest((m) => this.onRequest(m));
    void this.acp.exited.then((code) => {
      if (this.running) void this.agentDied(code);
    });

    try {
      const init = await this.acp.initialize();
      this.line(`   agent: ${init.agentInfo?.name ?? harness.name} ${init.agentInfo?.version ?? ""}`.trimEnd());
    } catch (e) {
      this.line(`❌ The agent didn't start: ${(e as Error).message}`);
      this.acp.close();
      return 1;
    }

    // Register, retrying while the daemon is unreachable (as a Pi teammate does);
    // a refusal (protocol, or the experimental gate) is final, and said plainly.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.register();
        break;
      } catch (e) {
        if (isRegistrationRefusal(e)) {
          this.line(`❌ The daemon refused this teammate: ${(e as Error).message}`);
          this.acp.close();
          return 2;
        }
        if (attempt === 0) this.line(`   daemon unreachable (${(e as Error).message}) — retrying…`);
        await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 5_000));
      }
    }

    this.running = true;
    await this.mirror.start();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.opts.heartbeatMs ?? 30_000);
    void this.workLoop();
    await this.done;
    return this.exitCode;
  }

  /** Stop: fail any item in hand (a deregistered member's item would hang), deregister, end the agent. */
  async stop(reason = "the teammate was stopped", code = 0): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.heartbeatTimer);
    const item = this.currentItem;
    if (item) {
      if (this.sessionId) await this.acp.cancel(this.sessionId).catch(() => {});
      await this.failItem(item, `[failed] ${reason} before finishing this.`);
    }
    this.mirror.stop();
    await this.opts.client.deregister().catch(() => {});
    this.acp.close();
    this.exitCode = code;
    this.stopped();
  }

  // ─── Daemon side ─────────────────────────────────────────────────────

  private async register(): Promise<void> {
    await this.opts.client.register({ name: this.opts.name, directory: this.opts.cwd, metadata: this.opts.metadata });
  }

  private async heartbeat(): Promise<void> {
    const res = await this.opts.client.heartbeat(this.currentItem ? "working" : "idle", this.currentItem ?? undefined).catch(() => ({} as { dismissed?: boolean; reregister?: boolean }));
    if (res.dismissed) {
      this.line("👋 Dismissed.");
      await this.stop("the teammate was dismissed");
    } else if (res.reregister) {
      await this.register().catch(() => {});
    }
  }

  private async workLoop(): Promise<void> {
    const pollMs = this.opts.pollMs ?? 5_000;
    while (this.running) {
      try {
        const next = await this.opts.client.getNextWork();
        if (next.workItem && this.running) {
          const claim = await this.opts.client.claimWorkItem(next.workItem.id);
          if (claim.success && claim.prompt) {
            await this.doItem(next.workItem.id, next.workItem.title ?? next.workItem.id, claim.prompt);
            continue;
          }
        }
      } catch { /* daemon unreachable: try again */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async doItem(id: string, title: string, prompt: string): Promise<void> {
    const { client, cwd, harness } = this.opts;
    this.currentItem = id;
    this.line(`\n▶ ${title}  (${id})`);
    void client.heartbeat("working", id).catch(() => {});
    await client.postComment(id, "[status] Started working on this.").catch(() => {});

    let result: PromptResult;
    try {
      // A fresh session per item: context hygiene, as Pi teammates do.
      const session = await this.acp.newSession(cwd);
      this.sessionId = session.sessionId;
      if (harness.mode) await this.acp.setMode(session.sessionId, harness.mode).catch((e) => this.line(`   (couldn't set mode ${harness.mode}: ${(e as Error).message})`));
      const full = `${prompt}\n\n${failInstructions(this.opts.failCommand)}`;
      this.turn = { segments: [""], thinking: "", costUsd: null, model: null, tools: new Map() };
      this.mirror.onInput(full, "extension");
      this.mirror.onAgentStart();
      result = await this.acp.prompt(session.sessionId, full);
    } catch (e) {
      // Stopping, or the agent died: the exit handler fails the item, once.
      if (!this.running || /agent exited/.test((e as Error).message)) return;
      const why = e instanceof AcpError ? e.message : (e as Error).message;
      this.line(`\n❌ ${why}`);
      await this.failItem(id, `[failed] The agent errored: ${why}`);
      this.endItem();
      return;
    }
    this.mirror.onMessageEnd(this.messageLike());
    this.mirror.onAgentEnd();
    const turn = this.turn!;
    await this.reportUsage(id, result, turn);

    // Already failed (the agent ran `mpt agent fail`) or canceled by a human: leave it.
    const state = await client.getWorkItemState(id).catch(() => null);
    if (state && state !== "IN_PROGRESS" && state !== "MORIBUND") {
      this.line(`\n■ ${state.toLowerCase()} — not completing it`);
    } else if (result.stopReason === "end_turn") {
      const summary = lastNonEmpty(turn.segments);
      await client.postComment(id, `[done] Work complete. Summary:\n${summary}`).catch(() => {});
      await client.setWorkItemState(id, "COMPLETE").catch(() => {});
      this.line(`\n✓ complete`);
    } else {
      await this.failItem(id, `[failed] The agent stopped without finishing (${result.stopReason}).`);
      this.line(`\n✗ stopped: ${result.stopReason}`);
    }
    this.endItem();
  }

  private endItem(): void {
    this.currentItem = null;
    this.sessionId = null;
    this.turn = null;
  }

  private async failItem(id: string, comment: string): Promise<void> {
    await this.opts.client.postComment(id, comment).catch(() => {});
    await this.opts.client.setWorkItemState(id, "FAILED").catch(() => {});
  }

  private async agentDied(code: number): Promise<void> {
    this.line(`\n❌ The agent process exited (code ${code}).`);
    await this.stop(`the agent process exited (code ${code})`, 1);
  }

  /** Tokens and USD cost, when the agent reports them. Kiro's credits are deliberately not recorded. */
  private async reportUsage(id: string, result: PromptResult, turn: Turn): Promise<void> {
    const u = result.usage;
    if (!u && turn.costUsd === null) return;
    const quota = (result._meta?.quota as { model_usage?: Array<{ model?: string }> } | undefined)?.model_usage?.[0]?.model;
    await this.opts.client.reportUsage({
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cachedReadTokens ?? 0,
      cacheWriteTokens: u?.cachedWriteTokens ?? 0,
      model: turn.model ?? quota ?? this.opts.harness.name,
      costUsd: turn.costUsd ?? 0,
      kind: "work",
      workItemId: id,
    }).catch(() => {});
  }

  // ─── Agent side ──────────────────────────────────────────────────────

  private async onRequest(m: AcpIncoming): Promise<unknown> {
    if (m.method !== "session/request_permission") return undefined; // "not supported"
    const title = (m.params.toolCall as { title?: string } | undefined)?.title ?? "a tool";
    // Autonomous, so allow — once, never "always". (Forwarding to the web UI while
    // pairing comes with pairing support.)
    this.line(`\n   ✓ allowed: ${title}`);
    return permissionOutcome(m.params, true);
  }

  private onNotification(m: AcpIncoming): void {
    if (m.method !== "session/update" || !this.turn || m.params.sessionId !== this.sessionId) return;
    const u = m.params.update as Record<string, unknown> & { sessionUpdate?: string };
    const turn = this.turn;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = (u.content as { text?: string } | undefined)?.text ?? "";
        turn.segments[turn.segments.length - 1] += text;
        this.out(text);
        this.mirror.onMessageUpdate(this.messageLike());
        break;
      }
      case "agent_thought_chunk":
        turn.thinking += (u.content as { text?: string } | undefined)?.text ?? "";
        this.mirror.onMessageUpdate(this.messageLike());
        break;
      case "tool_call": {
        const toolId = String(u.toolCallId ?? "");
        if (turn.tools.has(toolId)) break; // a repeat (Claude re-sends as the input fills in)
        const name = String(u.title ?? u.kind ?? "tool");
        turn.tools.set(toolId, name);
        // Prose before a tool call is its own message; the summary is what comes after the last one.
        if (turn.segments[turn.segments.length - 1]) {
          this.mirror.onMessageEnd(this.messageLike());
          turn.segments.push("");
          turn.thinking = "";
        }
        this.line(`\n⏺ ${name}`);
        this.mirror.onToolStart(toolId, name, u.rawInput ?? {});
        break;
      }
      case "tool_call_update": {
        const status = u.status as string | undefined;
        if (status !== "completed" && status !== "failed") break;
        const toolId = String(u.toolCallId ?? "");
        const text = contentText(u.content) || String(u.rawOutput ?? "");
        this.mirror.onToolEnd(toolId, turn.tools.get(toolId) ?? "tool", { content: [{ type: "text", text }] }, status === "failed");
        break;
      }
      case "notice": {
        // Kept out of the reply (and so out of the summary): shown as its own line.
        const desc = u.description ? `: ${u.description}` : "";
        this.line(`\n   ⚠ ${String(u.title ?? "notice")}${desc}`);
        break;
      }
      case "usage_update": {
        const cost = u.cost as { amount?: number; currency?: string } | undefined;
        if (cost?.currency === "USD" && typeof cost.amount === "number") turn.costUsd = cost.amount;
        const model = (u._meta as Record<string, unknown> | undefined)?.["_claude/model"];
        if (typeof model === "string") turn.model = model;
        break;
      }
    }
  }

  /** The current segment as a Pi-shaped assistant message, for the transcript mirror. */
  private messageLike() {
    const t = this.turn!;
    return {
      role: "assistant",
      content: [
        ...(t.thinking ? [{ type: "thinking", thinking: t.thinking }] : []),
        { type: "text", text: t.segments[t.segments.length - 1] ?? "" },
      ],
    };
  }

  private line(text: string): void {
    this.out(`${text}\n`);
  }
}

function lastNonEmpty(segments: string[]): string {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i]!.trim()) return segments[i]!.trim();
  return "(no summary)";
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c as { content?: { text?: string } })?.content?.text ?? "").join("");
}

/** A refusal at registration (409: protocol, or the experimental gate) — final, not retryable. */
export function isRegistrationRefusal(e: unknown): boolean {
  return e instanceof DaemonError && e.statusCode === 409;
}

/**
 * agent/acp.ts — A client for the Agent Client Protocol, over a child process's stdio.
 *
 * ACP is JSON-RPC 2.0, one JSON object per line, between a *client* (us) and a coding
 * agent (Kiro's `kiro-cli acp`, Claude Code's `claude-agent-acp` adapter, …). The
 * agent streams `session/update` notifications while a `session/prompt` request is
 * open, and asks the client things — above all `session/request_permission`.
 *
 * This module knows nothing about the daemon: it's the transport plus the handful of
 * methods `mpt agent` uses. Unknown notifications are ignored and unknown requests
 * are answered "method not found", because agents send extension methods of their
 * own (Kiro's `_kiro.dev/*`). Verified against both agents; see TODO.md "Next:
 * other harnesses".
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Readable } from "node:stream";

/** Anything the agent sends that isn't a response to one of our requests. */
export interface AcpIncoming {
  method: string;
  params: Record<string, unknown>;
}

/** Answers an agent → client request, or `undefined` for "not supported". */
export type AcpRequestHandler = (msg: AcpIncoming) => Promise<unknown> | unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** An error the agent returned for one of our requests. */
export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(data !== undefined ? `${message}: ${typeof data === "string" ? data : JSON.stringify(data)}` : message);
    this.code = code;
    this.data = data;
  }
}

/** One stop reason per prompt turn (ACP's `session/prompt` result). */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

export interface PromptResult {
  stopReason: StopReason;
  /** Token usage, when the agent reports it (Claude's adapter does; Kiro doesn't). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    totalTokens?: number;
  };
  _meta?: Record<string, unknown>;
}

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers: Array<(msg: AcpIncoming) => void> = [];
  private requestHandler: AcpRequestHandler = () => undefined;
  private closedError: Error | null = null;

  /** Resolves with the exit code when the agent process ends. */
  readonly exited: Promise<number>;

  private child: ChildProcessWithoutNullStreams;
  private onStderr: (line: string) => void;

  private constructor(child: ChildProcessWithoutNullStreams, onStderr: (line: string) => void) {
    this.child = child;
    this.onStderr = onStderr;
    // A write to an agent that has gone away fails that send (see `send`); the
    // stream's own error event must not crash the process too.
    child.stdin.on("error", () => {});
    this.exited = new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number, err: Error) => {
        if (settled) return;
        settled = true;
        this.failAll(err);
        resolve(code);
      };
      // "error" without "exit": the command couldn't be started at all.
      child.once("error", (e) => finish(-1, new Error(`agent failed to start: ${e.message}`)));
      child.once("exit", (code, signal) => {
        // A signal death reports as 128 + signal number, as a shell would.
        const c = code ?? 128 + (signal ? osConstants.signals[signal] ?? 0 : 0);
        finish(c, new Error(`agent exited (code ${c})`));
      });
    });
    void this.readLines(child.stdout, (line) => this.handleLine(line));
    void this.readLines(child.stderr, (line) => this.onStderr(line));
  }

  /** Start an agent process and speak ACP to it. */
  static spawn(
    command: string[],
    opts: { cwd: string; env?: Record<string, string>; onStderr?: (line: string) => void },
  ): AcpConnection {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error("no agent command");
    // `env` adds to (and overrides) the inherited environment rather than replacing it.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AcpConnection(child, opts.onStderr ?? (() => {}));
  }

  /** Receive every notification (`session/update`, and agent-specific ones). */
  onNotification(handler: (msg: AcpIncoming) => void): void {
    this.notificationHandlers.push(handler);
  }

  /** Answer agent → client requests (e.g. `session/request_permission`). */
  onRequest(handler: AcpRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Send a request and await its result. Rejects with AcpError on an error response. */
  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  /** Send a notification (no response), e.g. `session/cancel`. */
  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  // ─── The methods `mpt agent` uses ────────────────────────────────────

  /**
   * Protocol handshake. We offer no filesystem or terminal: agents use their own
   * tools. We do accept `notice` updates — without that, Claude's adapter writes
   * notices (e.g. "Auto mode unavailable…") into the agent's reply text, where
   * they'd end up in a work item's summary.
   */
  initialize(): Promise<{ protocolVersion: number; agentCapabilities?: Record<string, unknown>; agentInfo?: { name?: string; version?: string } }> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } },
    }, 60_000);
  }

  /** A fresh session (a fresh context) in `cwd`, with the given MCP servers. */
  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<{ sessionId: string; modes?: { availableModes?: Array<{ id: string }> } }> {
    return await this.request("session/new", { cwd, mcpServers }, 120_000);
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId }, 30_000);
  }

  /** Run one turn. Resolves when the agent ends it (or it's cancelled). */
  prompt(sessionId: string, text: string): Promise<PromptResult> {
    return this.request<PromptResult>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  /** End the agent process. */
  close(): void {
    this.failAll(new Error("connection closed"));
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
  }

  // ─── Transport ───────────────────────────────────────────────────────

  private async send(msg: Record<string, unknown>): Promise<void> {
    const stdin = this.child.stdin;
    await new Promise<void>((resolve, reject) => {
      if (!stdin.writable) return reject(new Error("agent stdin is closed"));
      stdin.write(JSON.stringify(msg) + "\n", (err) => (err ? reject(err) : resolve()));
    });
  }

  private async readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
      }
    } catch { /* stream closed */ }
    if (buf.trim()) onLine(buf.trim());
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { this.onStderr(`(non-JSON on stdout) ${line}`); return; }

    // A response to one of ours.
    if (typeof msg.id === "number" && !msg.method && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (err) p.reject(new AcpError(err.code ?? -1, err.message ?? "error", err.data));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== "string") return;
    const incoming: AcpIncoming = { method: msg.method, params: (msg.params as Record<string, unknown>) ?? {} };

    // A request from the agent: answer it, whatever it is.
    if (msg.id !== undefined) {
      const id = msg.id;
      Promise.resolve()
        .then(() => this.requestHandler(incoming))
        .then((result) =>
          result === undefined
            ? this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${incoming.method}` } })
            : this.send({ jsonrpc: "2.0", id, result })
        )
        .catch((e) => this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: (e as Error).message } }).catch(() => {}));
      return;
    }

    for (const h of this.notificationHandlers) {
      try { h(incoming); } catch { /* a handler's bug must not break the stream */ }
    }
  }

  private failAll(err: Error): void {
    this.closedError ??= err;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Pick the option to answer a permission request with. ACP offers options by
 * `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`); we never
 * pick an "always", so a later pairing session isn't pre-approved by an autonomous one.
 */
export function permissionOutcome(params: Record<string, unknown>, allow: boolean): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const options = (params.options as Array<{ optionId: string; kind?: string }> | undefined) ?? [];
  const want = allow ? "allow_once" : "reject_once";
  const pick = options.find((o) => o.kind === want) ?? (allow ? undefined : options.find((o) => o.kind === "reject_always"));
  return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
}

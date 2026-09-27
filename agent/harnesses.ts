/**
 * agent/harnesses.ts — The ACP harnesses `mpt agent` can supervise, and how to start each.
 *
 * Experimental: non-Pi harnesses are gated behind `experimental.harnesses` in team
 * config until they're better vetted (TODO.md "Next: other harnesses"). Pi is not in
 * this list: it runs natively, through its own extension.
 *
 * Every entry was verified against the real agent over ACP (the spike recorded in
 * TODO.md); a stand-in speaking the same protocol drives the tests.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";

export interface AcpHarness {
  name: string;
  /** Human-facing name, for the supervisor's own output. */
  title: string;
  /**
   * The command that starts the agent in ACP mode, plus any environment it needs.
   * Throws with an actionable message when a prerequisite is missing.
   */
  launch(): { command: string[]; env?: Record<string, string> };
  /**
   * The session mode to set right after `session/new`. Set explicitly because an
   * agent otherwise takes the user's own defaults — with Claude's
   * `defaultMode: "auto"` that wrote a notice *into the agent's reply*, which would
   * have become the work item's summary. `undefined` keeps the agent's default.
   */
  mode?: string;
}

/** The pinned Claude Code ACP adapter `mpt setup --harness claude` installs. */
export const CLAUDE_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_ADAPTER_VERSION = "0.81.2";

/** Where `mpt setup` installs ACP adapters (beside the managed Pi extension). */
export function acpAdapterDir(name: string, env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const home = env("MPT_HOME") ?? env("HOME") ?? env("USERPROFILE") ?? ".";
  return path.join(home, ".my-pizza-team", "acp", name);
}

/** The installed Claude adapter's entry point, or null if `mpt setup --harness claude` hasn't run. */
export function claudeAdapterEntry(): string | null {
  const entry = path.join(acpAdapterDir("claude"), "node_modules", ...CLAUDE_ADAPTER_PACKAGE.split("/"), "dist", "index.js");
  return existsSync(entry) ? entry : null;
}

/** Find an executable on PATH. */
export function which(cmd: string): string | null {
  for (const dir of (Deno.env.get("PATH") ?? "").split(path.DELIMITER)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { if (Deno.statSync(p).isFile) return p; } catch { /* not here */ }
  }
  return null;
}

export const ACP_HARNESSES: Record<string, AcpHarness> = {
  kiro: {
    name: "kiro",
    title: "Kiro",
    launch() {
      if (!which("kiro-cli")) throw new Error("kiro-cli is not on PATH — install Kiro CLI and log in (kiro-cli login)");
      // No -a: permission requests come to us, and we answer them (allow while
      // autonomous), which keeps the door open for forwarding them while pairing.
      return { command: ["kiro-cli", "acp"] };
    },
  },
  claude: {
    name: "claude",
    title: "Claude Code",
    launch() {
      const entry = claudeAdapterEntry();
      if (!entry) throw new Error("the Claude Code ACP adapter is not installed — run: mpt setup --harness claude");
      const node = which("node");
      if (!node) throw new Error("node is not on PATH (the Claude Code ACP adapter runs on Node.js)");
      const claude = which("claude");
      if (!claude) throw new Error("claude is not on PATH — install Claude Code and log in");
      // The user's own `claude`, so their login (Bedrock included) and version apply,
      // rather than the copy bundled inside the adapter's SDK.
      return { command: [node, entry], env: { CLAUDE_CODE_EXECUTABLE: claude } };
    },
    // Every tool that needs permission asks us; we answer (see the supervisor).
    mode: "default",
  },
};

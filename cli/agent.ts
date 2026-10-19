/**
 * cli/agent.ts — `mpt agent`: run an experimental non-Pi teammate, and let it give up.
 *
 *   mpt agent --harness <kiro|claude> [--daemon URL] [--name NAME]
 *             [--tmux-session S --tmux-window W] [--acp-command '["cmd","arg"]']
 *   mpt agent fail "<reason>"
 *
 * The first is what the daemon's spawn template runs in a teammate's tmux window
 * (agent/supervisor.ts). The second is what that teammate's *agent* runs, through its
 * own shell tool, to give up on the item in hand: the supervisor's environment carries
 * MPT_DAEMON_URL / MPT_AGENT_ID through to it. Experimental — behind
 * `experimental.harnesses` (TODO.md "Next: other harnesses").
 */

import { ACP_HARNESSES, acpAdapterDir, CLAUDE_ADAPTER_PACKAGE, CLAUDE_ADAPTER_VERSION, claudeAdapterEntry, which } from "../agent/harnesses.ts";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { AgentSupervisor } from "../agent/supervisor.ts";
import { DaemonClient } from "../harnesses/pi/src/runtime/client.ts";
import { mptInvocation } from "../daemon/self.ts";
import { shellQuote } from "../daemon/tmux.ts";
import { DEFAULT_DAEMON_URL } from "../shared/types.ts";
import { packageVersion } from "../shared/paths.ts";

/** `--flag value` or `--flag=value`. */
function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
}

export async function cmdAgent(args: string[]): Promise<void> {
  if (args[0] === "fail") return await cmdAgentFail(args.slice(1));

  const harnessName = flag(args, "harness");
  const harness = harnessName ? ACP_HARNESSES[harnessName] : undefined;
  if (!harness) {
    console.error(`Usage: mpt agent --harness <${Object.keys(ACP_HARNESSES).join("|")}> [--daemon URL] [--name NAME]`);
    process.exit(2);
  }

  let launch: { command: string[]; env?: Record<string, string> };
  const override = flag(args, "acp-command");
  try {
    launch = override ? { command: JSON.parse(override) as string[] } : harness.launch();
  } catch (e) {
    console.error(`❌ Can't start ${harness.title}: ${(e as Error).message}`);
    process.exit(2);
  }

  const daemonUrl = (flag(args, "daemon") || process.env["MPT_DAEMON_URL"] || DEFAULT_DAEMON_URL).replace(/\/$/, "");
  const name = flag(args, "name") || `${harness.name}-${Date.now().toString(36)}`;
  const authToken = process.env["MPT_API_TOKEN"] || undefined;
  const client = new DaemonClient(daemonUrl, name, { authToken, harness: harness.name, harnessVersion: packageVersion() });

  const metadata: Record<string, unknown> = {};
  const session = flag(args, "tmux-session"), window = flag(args, "tmux-window");
  if (session) metadata.tmuxSession = session;
  if (window) metadata.tmuxWindow = window;

  const supervisor = new AgentSupervisor({
    client,
    name,
    cwd: process.cwd(),
    harness,
    launch,
    failCommand: [...mptInvocation(), "agent", "fail"].map(shellQuote).join(" "),
    agentEnv: { MPT_DAEMON_URL: daemonUrl, MPT_AGENT_ID: name, ...(authToken ? { MPT_API_TOKEN: authToken } : {}) },
    metadata,
    pollMs: Number(process.env["MPT_AGENT_POLL_MS"] ?? 5_000),
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { void supervisor.stop("the teammate was stopped").then(() => process.exit(0)); });
  }
  process.exit(await supervisor.run());
}

/**
 * Fail the work item this agent holds, with a reason. Finds it by asking the daemon
 * which IN_PROGRESS item belongs to MPT_AGENT_ID, so the agent needn't know its id.
 */
async function cmdAgentFail(args: string[]): Promise<void> {
  const reason = args.join(" ").trim();
  const daemonUrl = (process.env["MPT_DAEMON_URL"] || "").replace(/\/$/, "");
  const agentId = process.env["MPT_AGENT_ID"] || "";
  if (!reason || !daemonUrl || !agentId) {
    console.error(
      !reason
        ? 'Usage: mpt agent fail "<what is blocking you, and what you need>"'
        : "mpt agent fail only works inside an mpt teammate (MPT_DAEMON_URL / MPT_AGENT_ID aren't set).",
    );
    process.exit(2);
  }
  const token = process.env["MPT_API_TOKEN"];
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  const list = await fetch(`${daemonUrl}/api/work-items?state=IN_PROGRESS,MORIBUND`, { headers }).then((r) => r.json()) as { items?: Array<{ id: string; memberId?: string; title?: string }> };
  const item = list.items?.find((i) => i.memberId === agentId);
  if (!item) {
    console.error(`No work item is in progress for ${agentId} — nothing to fail.`);
    process.exit(1);
  }
  await fetch(`${daemonUrl}/api/agents/comments/${encodeURIComponent(item.id)}`, {
    method: "POST", headers, body: JSON.stringify({ agentId, body: `[failed] ${reason}` }),
  });
  const res = await fetch(`${daemonUrl}/api/agents/work-items/${encodeURIComponent(item.id)}/state`, {
    method: "POST", headers, body: JSON.stringify({ agentId, state: "FAILED" }),
  }).then((r) => r.json()) as { success?: boolean; error?: string };
  if (!res.success) {
    console.error(`Couldn't fail ${item.id}: ${res.error ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`Work item ${item.id} marked failed. Stop working on it.`);
}

/**
 * `mpt setup --harness <kiro|claude> [--dry-run] [--uninstall]` — prepare this
 * machine for an experimental ACP teammate. Kiro needs nothing installed (it speaks
 * ACP natively) beyond `kiro-cli`; Claude Code needs its ACP adapter, which this
 * installs, pinned, beside the managed Pi extension — rather than trusting `npx` to
 * fetch whatever is newest at spawn time. Says how to enable the experimental flag;
 * doesn't flip it, since that's the team's decision.
 */
export async function cmdSetupHarness(args: string[], teamConfigPath: string, experimentalOn: boolean): Promise<void> {
  const name = flag(args, "harness") ?? "";
  const harness = ACP_HARNESSES[name];
  if (!harness) {
    console.error(`Unknown harness "${name}". Experimental harnesses: ${Object.keys(ACP_HARNESSES).join(", ")}`);
    process.exit(2);
  }
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const say = (s: string) => console.log(dryRun ? `(dry run) ${s}` : s);
  let ok = true;
  const need = (cmd: string, fix: string) => {
    const at = which(cmd);
    console.log(at ? `  ✓ ${cmd}: ${at}` : `  ✗ ${cmd} not found — ${fix}`);
    if (!at) ok = false;
  };

  console.log(`${harness.title} (experimental)`);
  if (name === "kiro") {
    need("kiro-cli", "install Kiro CLI, then `kiro-cli login`");
  } else if (name === "claude") {
    need("claude", "install Claude Code and log in");
    need("node", "install Node.js (the adapter runs on it)");
    need("npm", "install npm (it installs the adapter)");
    const dir = acpAdapterDir("claude");
    const spec = `${CLAUDE_ADAPTER_PACKAGE}@${CLAUDE_ADAPTER_VERSION}`;
    if (args.includes("--uninstall")) {
      say(`Remove the Claude Code ACP adapter: ${dir}`);
      if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    const installed = claudeAdapterEntry();
    if (installed && installedAdapterVersion() === CLAUDE_ADAPTER_VERSION) {
      console.log(`  ✓ adapter: ${spec} (${dir})`);
    } else if (ok) {
      say(`Install ${spec} into ${dir}`);
      if (!dryRun) {
        fs.mkdirSync(dir, { recursive: true });
        const res = spawnSync("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "--silent", spec], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        if (res.status !== 0) {
          console.error(`❌ npm install failed (${res.error ? res.error.message : `exit ${res.status}`})`);
          process.exit(1);
        }
        console.log(`  ✓ adapter: ${spec}`);
      }
    }
  }

  if (!ok) {
    console.error("\nFix the above, then re-run this.");
    process.exit(1);
  }
  console.log(
    experimentalOn
      ? `\nReady. Spawn one from the Team tab's Spawn dialog (harness: ${name}).`
      : `\nReady — but experimental harnesses are off for this team. To enable them, add\n  "experimental": { "harnesses": true }\nto ${teamConfigPath} and restart the daemon.`,
  );
}

/** The installed Claude adapter's version, or null. */
function installedAdapterVersion(): string | null {
  try {
    const pkg = path.join(acpAdapterDir("claude"), "node_modules", ...CLAUDE_ADAPTER_PACKAGE.split("/"), "package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

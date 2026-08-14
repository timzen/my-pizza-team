// Permission system integration for autonomous agents
//
// Uses @gotgenes/pi-permission-system's project-local config with dynamic
// yoloMode toggling. The permission system re-reads config at prompt time,
// so we can flip yoloMode on/off based on the agent's current state:
//   - Autonomous (working on task) → yoloMode: true (no prompts)
//   - Pairing (human hopped in)    → yoloMode: false (normal permissions)
//
// The **leader** (the chat agent) needs the same treatment for a different
// reason: a message sent from the web UI has nobody at the terminal to answer a
// prompt, so an `ask` doesn't just slow things down — it hangs the chat with no
// visible cause. See `registerChatAgentPermissions`.
//
// yoloMode alone is not enough as of pi-permission-system v24: its fail-closed
// bash wrapper floor clamps any `allow` (yolo-rewritten included) back to `ask`
// for indirection wrappers (`timeout`, `nohup`, `sudo`, `env`, `xargs`, ...) —
// "there is no way to auto-allow a wrapper" via policy. The sanctioned escape
// hatch is the authorizer chain: we register a live-authority link that
// answers those asks with `allow` while the agent is autonomous and `defer`
// (normal prompting) while pairing. The link is activated by naming it in the
// `authorizerChain` of the config we write; the chain owner caps its authority
// (an allow on the `path`/`external_directory` surfaces downgrades to defer).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PERMISSION_CONFIG_REL = ".pi/extensions/pi-permission-system/config.json";

/** Operator-facing name of our authorizer chain link (referenced in config). */
export const AUTONOMOUS_AUTHORIZER = "ppt-autonomous";

/**
 * The permission system's cross-extension service slot on globalThis
 * (Symbol.for is process-global, surviving pi's per-extension module
 * isolation). Reading the slot directly avoids a hard dependency on
 * @gotgenes/pi-permission-system — if it isn't installed, the slot is empty
 * and we degrade gracefully.
 */
const PERMISSIONS_SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

/** Minimal untyped view of the cross-extension PermissionsService. */
interface PermissionsServiceLike {
  registerAuthorizer?: (
    name: string,
    authorize: (details: Record<string, unknown>, query: unknown, log: {
      review?: (event: string, details?: Record<string, unknown>) => void;
    }) => Promise<{ kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" }>,
  ) => () => void;
}

/**
 * Register the `ppt-autonomous` authorizer chain link: auto-allows `ask`
 * escalations (e.g. the bash indirection-wrapper floor on `timeout`/`nohup`
 * commands) while the agent is autonomous; defers to the normal prompt flow
 * while pairing. Registration is re-attempted on every `permissions:ready`
 * broadcast so it survives /reload and load-order differences.
 */
export function registerAutonomousAuthorizer(pi: ExtensionAPI, getIsAutonomous: () => boolean): void {
  let dispose: (() => void) | null = null;

  const register = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cross-extension boundary
    const service = (globalThis as any)[PERMISSIONS_SERVICE_KEY] as PermissionsServiceLike | undefined;
    if (!service?.registerAuthorizer) return; // permission system not installed/published

    // A fresh service is published per session; drop any stale registration
    // before re-registering (duplicate names throw).
    try { dispose?.(); } catch { /* stale disposer from a torn-down session */ }
    dispose = null;
    try {
      dispose = service.registerAuthorizer(AUTONOMOUS_AUTHORIZER, async (details, _query, log) => {
        if (getIsAutonomous()) {
          // Durable audit trail: one review entry per auto-allowed ask.
          log?.review?.("ppt.autonomous_auto_allow", {
            toolName: details?.toolName,
            command: details?.command,
          });
          return { kind: "allow" };
        }
        return { kind: "defer" }; // pairing — let the human answer
      });
    } catch {
      dispose = null; // name already registered by a live instance — leave it
    }
  };

  // The service publishes at session_start and broadcasts permissions:ready
  // right after; also try immediately in case it's already up.
  pi.events?.on?.("permissions:ready", register);
  register();
}

export function registerPermissionBypass(pi: ExtensionAPI, getIsAutonomous: () => boolean, onPause: () => void, cwd: string): void {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);

  // Ensure the config directory exists
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Set initial state: start autonomous
  updatePermissionConfig(configPath, true);

  // When human types interactively, switch to restrictive permissions
  pi.on("input", async (event) => {
    if (event.source === "interactive" && getIsAutonomous()) {
      updatePermissionConfig(configPath, false);
      onPause();
    }
    return { action: "continue" as const };
  });
}

/** Update permission config on disk for the permission system to pick up */
export function updatePermissionConfig(configPath: string, autonomous: boolean): void {
  const config = autonomous
    ? {
        yoloMode: true,
        // Activate our chain link (registered by registerAutonomousAuthorizer).
        // A named-but-unregistered link is skipped fail-safe (more prompting,
        // never less), so it's harmless in sessions that don't register it.
        authorizerChain: [AUTONOMOUS_AUTHORIZER],
        permission: {
          "*": "allow",
          bash: { "*": "allow" },
          external_directory: "allow",
        },
      }
    : {
        yoloMode: false,
        // Keep the chain named while pairing: the link defers when not
        // autonomous, so prompts reach the human normally.
        authorizerChain: [AUTONOMOUS_AUTHORIZER],
        permission: {
          "*": "allow",
          path: {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
          },
          bash: {
            "rm -rf *": "deny",
            "sudo *": "ask",
            "*": "allow",
          },
          external_directory: "ask",
        },
      };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Set up permissive permission config at spawn time */
export function ensurePermissivePermissionConfig(cwd: string): void {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  updatePermissionConfig(configPath, true);
}


// ═══════════════════════════════════════════════════════════════════════
// CHAT AGENT (LEADER)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Keep the chat agent unblockable.
 *
 * The leader answers the chat, and a web-driven run has **no one at the
 * terminal**: a permission prompt hangs the conversation with no visible cause
 * (the web UI just shows a `…` forever). So while the current run was triggered
 * remotely we turn on `yoloMode` and let the `ppt-autonomous` link answer the
 * fail-closed asks yolo can't.
 *
 * It keys off who drove the run rather than being permanently permissive, which
 * is the same autonomous/pairing distinction teammates use:
 *   - `interactive` input (you typing in its tmux pane) → your normal permission
 *     rules, because you are right there and can answer
 *   - `extension`/`rpc` input (the chat mirror delivering a web message) → yolo
 *
 * In practice the leader is infrastructure nobody types in, so this is "yolo
 * whenever it matters" — but it stops the web UI from silently disarming the
 * prompts on a session you *are* sitting in.
 *
 * Politeness about the user's repo: the leader runs in a real project, so unlike
 * a spawned teammate we do **not** author a permission map here. We only flip
 * `yoloMode`, ensure our chain link is named, and restore the file exactly as we
 * found it on shutdown — otherwise a plain `pi` in that directory later would be
 * silently in yolo mode.
 */
export function registerChatAgentPermissions(
  pi: ExtensionAPI,
  cwd: string,
): { isRemoteDriven: () => boolean } {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);
  /** The file as we found it (null = it did not exist), restored on shutdown. */
  const original = readFileOrNull(configPath);
  let remoteDriven = false;

  const apply = (next: boolean) => {
    if (next === remoteDriven) return;
    remoteDriven = next;
    setYoloMode(configPath, next);
  };

  pi.on("input", async (event) => {
    // "interactive" means a human is at this pane and can answer a prompt;
    // anything else (the mirror's sendUserMessage, RPC) means they are not.
    apply(event.source !== "interactive");
    return { action: "continue" as const };
  });

  pi.on("session_shutdown", async () => {
    try {
      if (original === null) fs.rmSync(configPath, { force: true });
      else fs.writeFileSync(configPath, original);
    } catch { /* best effort: never block shutdown on this */ }
  });

  return { isRemoteDriven: () => remoteDriven };
}

/**
 * Flip `yoloMode` and ensure our authorizer link is named, preserving every other
 * key the user (or a previous run) put in the config.
 */
export function setYoloMode(configPath: string, yolo: boolean): void {
  let config: Record<string, unknown> = {};
  const raw = readFileOrNull(configPath);
  if (raw) {
    try { config = JSON.parse(raw) as Record<string, unknown>; } catch { config = {}; }
  }
  config.yoloMode = yolo;
  // The chain link is what answers the fail-closed bash wrapper floor that yolo
  // cannot rewrite. Naming it while not remote-driven is harmless: it defers.
  const chain = Array.isArray(config.authorizerChain) ? config.authorizerChain as unknown[] : [];
  if (!chain.includes(AUTONOMOUS_AUTHORIZER)) chain.push(AUTONOMOUS_AUTHORIZER);
  config.authorizerChain = chain;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function readFileOrNull(file: string): string | null {
  try { return fs.readFileSync(file, "utf-8"); } catch { return null; }
}

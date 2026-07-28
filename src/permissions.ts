// Permission system integration for autonomous agents
//
// Uses @gotgenes/pi-permission-system's project-local config with dynamic
// yoloMode toggling. The permission system re-reads config at prompt time,
// so we can flip yoloMode on/off based on the agent's current state:
//   - Autonomous (working on task) → yoloMode: true (no prompts)
//   - Pairing (human hopped in)    → yoloMode: false (normal permissions)
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

// Permission system integration for autonomous agents
//
// Uses @gotgenes/pi-permission-system's project-local config with dynamic
// yoloMode toggling. The permission system re-reads config at prompt time,
// so we can flip yoloMode on/off based on the agent's current state:
//   - Autonomous (working on task) → yoloMode: true (no prompts)
//   - Pairing (human hopped in)    → yoloMode: false (normal permissions)

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PERMISSION_CONFIG_REL = ".pi/extensions/pi-permission-system/config.json";

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
        permission: {
          "*": "allow",
          bash: { "*": "allow" },
          external_directory: "allow",
        },
      }
    : {
        yoloMode: false,
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

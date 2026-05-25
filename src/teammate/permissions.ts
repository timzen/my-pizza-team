// Permission system integration for teammates
//
// Uses @gotgenes/pi-permission-system's project-local config with dynamic
// yoloMode toggling. The permission system re-reads config at prompt time,
// so we can flip yoloMode on/off based on the teammate's current state:
//   - Autonomous (working on task) → yoloMode: true (no prompts)
//   - Pairing (human hopped in)    → yoloMode: false (normal permissions)

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkLoop } from "./loop.js";

const PERMISSION_CONFIG_REL = ".pi/extensions/pi-permission-system/config.json";

export function registerPermissionBypass(pi: ExtensionAPI, getLoop: () => WorkLoop, cwd: string): void {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);

  // Ensure the config directory exists
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Set initial state based on loop
  updatePermissionConfig(configPath, true); // start autonomous

  // When mode changes, update the config file
  const originalPause = getLoop().pause.bind(getLoop());
  const originalResume = getLoop().resume.bind(getLoop());

  // We'll hook into the loop's mode changes via events
  pi.on("input", async (event) => {
    if (event.source === "interactive") {
      // Human is typing — switch to restrictive permissions
      updatePermissionConfig(configPath, false);
    }
    return { action: "continue" as const };
  });

  // Export a helper the loop can call
  (getLoop() as any)._setAutonomousPermissions = (autonomous: boolean) => {
    updatePermissionConfig(configPath, autonomous);
  };
}

function updatePermissionConfig(configPath: string, autonomous: boolean): void {
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

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Called from tmux.ts at spawn time to set up initial config */
export function ensurePermissivePermissionConfig(cwd: string): void {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  updatePermissionConfig(configPath, true);
}

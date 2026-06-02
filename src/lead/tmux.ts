// tmux window management for the team lead
import { execSync } from "node:child_process";

/** Sanitize a string for safe use in shell commands (remove dangerous chars) */
function shellSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._~\/-]/g, "");
}

export interface TmuxOptions {
  session: string;
  leaderUrl: string;
}

export function ensureSession(session: string): boolean {
  const safeSession = shellSafe(session);
  try {
    execSync(`tmux has-session -t "${safeSession}" 2>/dev/null`, { stdio: "pipe" });
    return false; // already existed
  } catch {
    execSync(`tmux new-session -d -s "${safeSession}"`, { stdio: "pipe" });
    return true; // just created
  }
}

export function spawnTeammate(name: string, cwd: string, options: TmuxOptions): void {
  const { session, leaderUrl } = options;
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  const safeCwd = shellSafe(cwd);
  const safeUrl = shellSafe(leaderUrl);
  const justCreated = ensureSession(session);

  if (justCreated) {
    // Session was just created — rename its default window instead of making a new one
    execSync(`tmux rename-window -t "${safeSession}:0" "${safeName}"`, { stdio: "pipe" });
  } else {
    // Session existed — add a new window
    execSync(`tmux new-window -n "${safeName}" -t "${safeSession}"`, { stdio: "pipe" });
  }

  // Ensure permissive permission config exists in the teammate's cwd
  // so @gotgenes/pi-permission-system doesn't prompt during autonomous work
  const fs = require("node:fs");
  const path = require("node:path");
  const configDir = path.join(cwd, ".pi", "extensions", "pi-permission-system");
  const configFile = path.join(configDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(configDir, { recursive: true });
    const permissiveConfig = {
      yoloMode: true,
      permission: { "*": "allow", bash: { "*": "allow" }, external_directory: "allow" }
    };
    fs.writeFileSync(configFile, JSON.stringify(permissiveConfig, null, 2) + "\n");
  }

  // Send the pi command
  const cmd = `cd ${safeCwd} && pi --ppt-worker --ppt-lead=${safeUrl} --ppt-name=${safeName}`;
  execSync(`tmux send-keys -t "${safeSession}:${safeName}" '${cmd}' Enter`, { stdio: "pipe" });
}


export function spawnAssistant(cwd: string, options: TmuxOptions): void {
  const { session, leaderUrl } = options;
  const name = "assistant";
  const safeSession = shellSafe(session);
  const safeCwd = shellSafe(cwd);
  const safeUrl = shellSafe(leaderUrl);
  const justCreated = ensureSession(session);

  if (justCreated) {
    execSync(`tmux rename-window -t "${safeSession}:0" "${name}"`, { stdio: "pipe" });
  } else {
    // Check if assistant window already exists
    try {
      execSync(`tmux select-window -t "${safeSession}:${name}" 2>/dev/null`, { stdio: "pipe" });
      // Window exists — don't create another
      return;
    } catch {
      // Window doesn't exist, create it
      execSync(`tmux new-window -n "${name}" -t "${safeSession}"`, { stdio: "pipe" });
    }
  }

  // Ensure permissive permission config
  const fs = require("node:fs");
  const path = require("node:path");
  const configDir = path.join(cwd, ".pi", "extensions", "pi-permission-system");
  const configFile = path.join(configDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(configDir, { recursive: true });
    const permissiveConfig = {
      yoloMode: true,
      permission: { "*": "allow", bash: { "*": "allow" }, external_directory: "allow" }
    };
    fs.writeFileSync(configFile, JSON.stringify(permissiveConfig, null, 2) + "\n");
  }

  const cmd = `cd ${safeCwd} && pi --ppt-assistant --ppt-lead=${safeUrl}`;
  execSync(`tmux send-keys -t "${safeSession}:${name}" '${cmd}' Enter`, { stdio: "pipe" });
}


export function dismissTeammate(name: string, session: string): void {
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  try {
    // Send Ctrl+C then exit
    execSync(`tmux send-keys -t "${safeSession}:${safeName}" C-c`, { stdio: "pipe" });
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t "${safeSession}:${safeName}" 'exit' Enter`, { stdio: "pipe" });
      } catch {
        // Window may already be gone
      }
    }, 1000);
  } catch {
    // Window doesn't exist
  }
}

export function hopToTeammate(name: string, session: string): void {
  const safeName = shellSafe(name);
  const safeSession = shellSafe(session);
  try {
    execSync(`tmux select-window -t "${safeSession}:${safeName}"`, { stdio: "pipe" });
  } catch {
    throw new Error(`No tmux window named "${name}" in session "${session}"`);
  }
}

export function listWindows(session: string): string[] {
  const safeSession = shellSafe(session);
  try {
    const output = execSync(
      `tmux list-windows -t "${safeSession}" -F "#{window_name}"`,
      { stdio: "pipe" }
    ).toString();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

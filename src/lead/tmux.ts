// tmux window management for the team lead
import { execSync } from "node:child_process";

export interface TmuxOptions {
  session: string;
  leaderUrl: string;
}

export function ensureSession(session: string): boolean {
  try {
    execSync(`tmux has-session -t "${session}" 2>/dev/null`, { stdio: "pipe" });
    return false; // already existed
  } catch {
    execSync(`tmux new-session -d -s "${session}"`, { stdio: "pipe" });
    return true; // just created
  }
}

export function spawnTeammate(name: string, cwd: string, options: TmuxOptions): void {
  const { session, leaderUrl } = options;
  const justCreated = ensureSession(session);

  if (justCreated) {
    // Session was just created — rename its default window instead of making a new one
    execSync(`tmux rename-window -t "${session}:0" "${name}"`, { stdio: "pipe" });
  } else {
    // Session existed — add a new window
    execSync(`tmux new-window -n "${name}" -t "${session}"`, { stdio: "pipe" });
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
  const cmd = `cd ${cwd} && pi --team-worker --team-lead=${leaderUrl} --team-name=${name}`;
  execSync(`tmux send-keys -t "${session}:${name}" '${cmd}' Enter`, { stdio: "pipe" });
}


export function dismissTeammate(name: string, session: string): void {
  try {
    // Send Ctrl+C then exit
    execSync(`tmux send-keys -t "${session}:${name}" C-c`, { stdio: "pipe" });
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t "${session}:${name}" 'exit' Enter`, { stdio: "pipe" });
      } catch {
        // Window may already be gone
      }
    }, 1000);
  } catch {
    // Window doesn't exist
  }
}

export function hopToTeammate(name: string, session: string): void {
  try {
    execSync(`tmux select-window -t "${session}:${name}"`, { stdio: "pipe" });
  } catch {
    throw new Error(`No tmux window named "${name}" in session "${session}"`);
  }
}

export function listWindows(session: string): string[] {
  try {
    const output = execSync(
      `tmux list-windows -t "${session}" -F "#{window_name}"`,
      { stdio: "pipe" }
    ).toString();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

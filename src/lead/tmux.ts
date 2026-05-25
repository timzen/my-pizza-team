// tmux window management for the team lead
import { execSync, exec } from "node:child_process";

export interface TmuxOptions {
  session: string;
  leaderUrl: string;
}

export function ensureSession(session: string): void {
  try {
    execSync(`tmux has-session -t "${session}" 2>/dev/null`, { stdio: "pipe" });
  } catch {
    execSync(`tmux new-session -d -s "${session}"`, { stdio: "pipe" });
  }
}

export function spawnTeammate(name: string, cwd: string, options: TmuxOptions): void {
  const { session, leaderUrl } = options;
  ensureSession(session);

  // Create new window
  execSync(`tmux new-window -n "${name}" -t "${session}"`, { stdio: "pipe" });

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

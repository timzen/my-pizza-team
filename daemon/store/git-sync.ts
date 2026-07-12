/**
 * daemon/store/git-sync.ts — Optional git checkpointing of the team directory.
 *
 * Commits the team dir (and pushes if a remote exists) so a team's stories,
 * tasks, and notes are versioned. Self-contained: operates on a team directory
 * and the autosave config. All git failures are non-fatal (no repo, nothing to
 * commit, offline, auth) — this is a best-effort convenience.
 */

import * as path from "@std/path";
import type { AutosaveConfig } from "../../shared/types.ts";

function git(args: string[], cwd: string): string {
  const cmd = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
  return new TextDecoder().decode(cmd.outputSync().stdout);
}

/**
 * Commit the team directory if there are changes, then push to origin if a
 * remote is configured. `message` overrides the configured commit template.
 */
export function commitTeamDir(teamDir: string, autosave: AutosaveConfig, message?: string): void {
  const cwd = path.dirname(teamDir);
  try {
    git(["add", teamDir], cwd);

    const status = git(["status", "--porcelain"], cwd);
    if (!status.trim()) return; // nothing to commit

    const commitMsg = message || autosave.commitMessage.replace("{timestamp}", new Date().toISOString());
    git(["commit", "-m", commitMsg], cwd);

    // Auto-push if a remote is configured (non-fatal on failure).
    if (git(["remote"], cwd).trim()) {
      git(["push"], cwd);
    }
  } catch {
    // Ignore git errors (nothing to commit, not a repo, offline, etc.)
  }
}

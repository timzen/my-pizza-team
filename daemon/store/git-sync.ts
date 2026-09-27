/**
 * daemon/store/git-sync.ts — Optional git checkpointing of the team directory.
 *
 * Commits the team dir (and pushes if a remote exists) so a team's stories,
 * tasks, and notes are versioned. Self-contained: operates on a team directory
 * and the autosave config. All git failures are non-fatal (no repo, nothing to
 * commit, offline, auth) — this is a best-effort convenience.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { AutosaveConfig } from "../../shared/types.ts";

/**
 * Files in a team directory that are process state, not team content.
 *
 * The database is a *cache* of the JSON files beside it (rebuilt on load), the WAL and
 * shared-memory files are SQLite's own scratch space, and the pid/log files describe
 * one daemon run. Committing any of them is noise at best; committing `state.db` means
 * a binary that changes on every write, conflicting on every pull.
 */
export const RUNTIME_FILES = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "daemon.pid",
  "daemon.log",
  "daemon.log.1",
  "daemon.stdout.log",
  "daemon.stderr.log",
] as const;

const GITIGNORE_MARKER = "# Written by mpt — runtime state, not team content.";

/**
 * Ensure the team directory ignores its own runtime files.
 *
 * This used to be assumed rather than done — a comment claimed "state.db is
 * gitignored", but nothing wrote the ignore, so the protection existed only if the
 * user's own repo happened to provide it. This repository's history holds the result:
 * a "shutdown checkpoint" commit of `.my-pizza-team/daemon.pid`.
 *
 * Idempotent, and appends rather than overwrites so a user's own additions survive.
 */
export function ensureTeamGitignore(teamDir: string): void {
  const file = path.join(teamDir, ".gitignore");
  let current = "";
  if (existsSync(file)) {
    try { current = Deno.readTextFileSync(file); } catch { return; }
  }
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = RUNTIME_FILES.filter((f) => !have.has(f));
  if (missing.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const header = current.includes(GITIGNORE_MARKER) ? "" : `${GITIGNORE_MARKER}\n`;
  Deno.writeTextFileSync(file, `${current}${prefix}${header}${missing.join("\n")}\n`);
}

function git(args: string[], cwd: string): string {
  const cmd = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
  return new TextDecoder().decode(cmd.outputSync().stdout);
}

/**
 * Commit the team directory if there are changes, then push to origin if a
 * remote is configured. `message` overrides the configured commit template.
 *
 * **Every git call is scoped to the team directory with a pathspec**, and that is
 * load-bearing, not tidiness. The team directory normally lives inside the user's own
 * project repo, so an unscoped call operates on *their* repository:
 *
 *   - `git status --porcelain` would see their unrelated edits and decide there was
 *     something to commit;
 *   - `git commit -m …` with no pathspec commits **everything staged** — so a
 *     half-finished edit the user had `git add`-ed was swept into a commit authored
 *     "pi-pizza-team: autosave" and then **pushed**, silently, on a timer.
 *
 * `git commit -- <teamDir>` commits only that path and leaves the rest of the index
 * exactly as the user left it (tests/git-sync.test.ts reproduces the case).
 */
export function commitTeamDir(teamDir: string, autosave: AutosaveConfig, message?: string): void {
  const cwd = path.dirname(teamDir);
  try {
    // Before `add`, so runtime files are never staged in the first place.
    ensureTeamGitignore(teamDir);
    git(["add", "--", teamDir], cwd);

    const status = git(["status", "--porcelain", "--", teamDir], cwd);
    // Nothing to commit — including when the only change is the .gitignore we just
    // wrote. Committing solely to record our own bookkeeping would be noise; it rides
    // along with the next real change instead.
    const changed = status.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    const onlyOurIgnore = changed.length > 0 && changed.every((f) => f.endsWith(".gitignore"));
    if (changed.length === 0 || onlyOurIgnore) return;

    const commitMsg = message || autosave.commitMessage.replace("{timestamp}", new Date().toISOString());
    git(["commit", "-m", commitMsg, "--", teamDir], cwd);

    // Auto-push if a remote is configured (non-fatal on failure).
    if (git(["remote"], cwd).trim()) {
      git(["push"], cwd);
    }
  } catch {
    // Ignore git errors (nothing to commit, not a repo, offline, etc.)
  }
}

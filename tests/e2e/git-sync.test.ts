/**
 * tests/git-sync.test.ts — the team directory's autosave commits stay in their lane.
 *
 * Regression test for a data bug. The team directory normally lives inside the
 * user's own project repository, and autosave committed with an unscoped
 * `git commit -m …` — which commits **everything staged**. So a half-finished edit the
 * user had `git add`-ed was swept into a commit authored "pi-pizza-team: autosave" and
 * then pushed, silently, on a timer, with `autoCommit` on by default.
 *
 * Found while investigating why the test suite slowed from 4s to 12s under
 * `--allow-run`: that flag let every test's `Store.close()` actually reach git. Real
 * incidents already existed — this repository's own history holds a "pi-pizza-team:
 * shutdown checkpoint" commit of `.my-pizza-team/daemon.pid`, made by a daemon run
 * from inside the checkout.
 *
 * Each test builds a throwaway repository, so nothing here can touch a real one.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../_assert.ts";
import * as path from "node:path";
import { commitTeamDir, ensureTeamGitignore, RUNTIME_FILES } from "../../daemon/store/git-sync.ts";

const AUTOSAVE = {
  autoCommit: true,
  commitMessage: "pi-pizza-team: autosave {timestamp}",
  flushIntervalMinutes: 1,
  commitIntervalHours: 1,
};

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

/** A user's project repository with one committed file and a team directory inside. */
function userRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-gitsync-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "tim@example.com");
  git(root, "config", "user.name", "Tim");
  git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "my-work.ts"), "v1\n");
  git(root, "add", "my-work.ts");
  git(root, "commit", "-qm", "user's baseline");

  const teamDir = path.join(root, ".my-pizza-team");
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return {
    root,
    teamDir,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } },
  };
}

/**
 * Staged and unstaged paths, asked of git directly. Not parsed from `status
 * --porcelain`: its first column is a leading space for "unstaged", which a trimming
 * helper silently eats — making an unstaged file read as staged.
 */
const staged = (root: string) => git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
const unstaged = (root: string) => git(root, "diff", "--name-only").split("\n").filter(Boolean);

/** Files changed by the most recent commit. */
const filesInHead = (root: string) => git(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);

test("the user's staged work is NOT swept into an autosave commit", () => {
  // The bug: this commit used to contain my-work.ts too.
  const r = userRepo();
  try {
    fs.writeFileSync(path.join(r.root, "my-work.ts"), "HALF-FINISHED EDIT\n");
    git(r.root, "add", "my-work.ts");
    fs.writeFileSync(path.join(r.teamDir, "stories", "s.json"), "{}\n");

    commitTeamDir(r.teamDir, AUTOSAVE);

    const committed = filesInHead(r.root);
    assertEquals(committed.includes("my-work.ts"), false, "the user's staged work must not be committed");
    assertEquals(committed.every((f) => f.startsWith(".my-pizza-team/")), true, `only the team dir: ${committed}`);
    // And the user's work is still staged, exactly as they left it.
    assertEquals(staged(r.root), ["my-work.ts"]);
    assertEquals(fs.readFileSync(path.join(r.root, "my-work.ts"), "utf8"), "HALF-FINISHED EDIT\n");
  } finally { r.cleanup(); }
});

test("the user's unstaged edits are left unstaged and uncommitted", () => {
  const r = userRepo();
  try {
    fs.writeFileSync(path.join(r.root, "my-work.ts"), "unstaged edit\n");
    fs.writeFileSync(path.join(r.teamDir, "stories", "s.json"), "{}\n");

    commitTeamDir(r.teamDir, AUTOSAVE);

    assertEquals(filesInHead(r.root).includes("my-work.ts"), false);
    assertEquals(unstaged(r.root), ["my-work.ts"], "still unstaged");
    assertEquals(staged(r.root), [], "and not staged by us");
  } finally { r.cleanup(); }
});

test("unrelated changes alone never produce an autosave commit", () => {
  // Unscoped `git status` saw the user's edits and decided there was work to commit.
  // Also covers our own side effect: writing the team .gitignore must not, by itself,
  // produce a commit.
  const r = userRepo();
  try {
    const before = git(r.root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(r.root, "my-work.ts"), "edited, staged\n");
    git(r.root, "add", "my-work.ts");

    commitTeamDir(r.teamDir, AUTOSAVE);

    assertEquals(git(r.root, "rev-parse", "HEAD"), before, "no commit should have been made");
  } finally { r.cleanup(); }
});

test("team directory changes are committed with the configured message", () => {
  const r = userRepo();
  try {
    fs.writeFileSync(path.join(r.teamDir, "stories", "s.json"), "{}\n");
    commitTeamDir(r.teamDir, AUTOSAVE, "pi-pizza-team: shutdown checkpoint");
    assertEquals(git(r.root, "log", "-1", "--format=%s"), "pi-pizza-team: shutdown checkpoint");
  } finally { r.cleanup(); }
});

test("nothing changed means no commit", () => {
  const r = userRepo();
  try {
    fs.writeFileSync(path.join(r.teamDir, "stories", "s.json"), "{}\n");
    commitTeamDir(r.teamDir, AUTOSAVE);
    const head = git(r.root, "rev-parse", "HEAD");
    commitTeamDir(r.teamDir, AUTOSAVE);
    assertEquals(git(r.root, "rev-parse", "HEAD"), head);
  } finally { r.cleanup(); }
});

test("a team directory outside any repository is a quiet no-op", () => {
  // Best-effort by design: no repo, no commit, no error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-gitsync-norepo-"));
  try {
    const teamDir = path.join(dir, ".my-pizza-team");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "x.json"), "{}\n");
    commitTeamDir(teamDir, AUTOSAVE); // must not throw
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Runtime files ───────────────────────────────────────────────────

test("runtime files are never committed — the June daemon.pid incident", () => {
  // A comment claimed state.db was gitignored, but nothing wrote the ignore; the
  // protection existed only if the user's own repo happened to provide it.
  const r = userRepo();
  try {
    fs.writeFileSync(path.join(r.teamDir, "stories", "s.json"), "{}\n");
    for (const f of RUNTIME_FILES) fs.writeFileSync(path.join(r.teamDir, f), "runtime\n");

    commitTeamDir(r.teamDir, AUTOSAVE);

    const committed = filesInHead(r.root);
    for (const f of RUNTIME_FILES) {
      assertEquals(committed.includes(`.my-pizza-team/${f}`), false, `${f} must not be committed`);
    }
    assertEquals(committed.includes(".my-pizza-team/stories/s.json"), true, "team content still is");
    assertEquals(committed.includes(".my-pizza-team/.gitignore"), true, "and the ignore travels with it");
  } finally { r.cleanup(); }
});

test("the ignore is idempotent and preserves a user's own entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-gitignore-"));
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "my-own-scratch/");
    ensureTeamGitignore(dir);
    ensureTeamGitignore(dir);
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assertStringIncludes(content, "my-own-scratch/");
    for (const f of RUNTIME_FILES) {
      assertEquals(content.split("\n").filter((l) => l.trim() === f).length, 1, `${f} exactly once`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

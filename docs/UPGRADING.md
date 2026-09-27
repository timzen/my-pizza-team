# Upgrading — steps for Tim

Everything on this machine that needs a human, from the work in
[BATTERIES_INCLUDED.md](BATTERIES_INCLUDED.md). Kept current as phases land, so it
should be accurate rather than reconstructed.

**Nothing here has been done for you.** All of this work was developed and verified
in throwaway sandboxes (`MPT_HOME` + `PI_CODING_AGENT_DIR`); your real
`~/.pi/agent/settings.json`, your team directories, and your data were never
touched.

Status of this guide: **Phases 0–3 and 5 complete.** Phase 4 pending.

---

## 1. The one thing that will bite if you skip it

**The agent protocol moved 1 → 5.** Any agent still running the old extension is
**refused at registration** with a message naming the fix.

That is the version handshake (P1b) working as designed — the alternative was the old
behaviour where a stale extension kept running while silently streaming no transcript
and recording no usage. But it means:

> **After upgrading, restart your leader and every teammate.** They will not
> reconnect on their own.

Breaking changes behind that version bump, for reference:

| Was | Now |
| --- | --- |
| `/api/hosts/:hostId/leader/directives` | `/api/leader/directives` |
| `POST /api/hosts/:hostId/readiness` | `POST /api/readiness` |
| `GET /api/hosts/:hostId` | gone — use `GET /api/config` |
| `register` accepted `hostId` | no longer sent or stored |
| `GET /api/assistant/inbox` returned `chat` | gone (one leader, nothing to designate) |

---

## 2. On your dev desktop

Run in the project folder where you normally start a team.

```bash
cd <your project folder>

# 1. Get the new binary. From a checkout:
cd /path/to/my-pizza-team && git pull && deno task compile
#    …or, once a release is cut: mpt upgrade

# 2. See what setup would change. Changes nothing.
mpt setup --dry-run

# 3. Apply it.
mpt setup

# 4. Confirm.
mpt doctor
```

### What `mpt setup` will do on your machine

Based on what `mpt doctor` actually reported on the laptop, expect roughly:

- **Unregister the archived `pi-pizza-team` path.** `pi-pizza-team` was merged into
  this repo at `harnesses/pi/` and the standalone repo is archived, so that
  registration points at code that no longer receives changes.
- **Write the extension** to `~/.my-pizza-team/pi-extension/` and register it. It
  ships inside the `mpt` binary now, so the daemon and the extension share one
  version and cannot drift.
- **Write `config.json`** into your team directory if it has none. Existing data is
  never overwritten.
- **Mark the folder trusted** by Pi, if it isn't already.

Preserved, and asserted by tests: your `defaultModel`, `theme`, and every other
package in Pi's settings.

### If you develop against a checkout

If you have `…/harnesses/pi` registered with Pi, `mpt setup` **steps aside** — it
removes its own managed registration instead of replacing your checkout, and tells
you it did. Your edits keep taking effect. (Replacing a checkout you're editing is
the kind of silent breakage this whole plan is about.)

### Undo

```bash
mpt setup --uninstall     # or --uninstall --dry-run first
```

Unregisters the managed extension and deletes it. **Leaves your team directory and
all its data alone.** It also leaves project trust in place (other tools may rely on
it) and does *not* restore registrations it removed — restoring them would re-create
the broken state; it names them instead, with the command to re-add one.

---

## 3. Optional cleanup

None of this is required; it is leftovers the work identified.

```bash
# The pre-rename team directory — predates .my-pizza-team and holds no current data.
# Check it first if you're unsure: it has no assistant tables at all.
rm -rf /path/to/my-pizza-team/.pi-pizza-team

# Stale build output: the committed `mpt` binary and dist/* predate every change
# in Phases 0–2 (dist/ is ~537M, and gitignored).
rm -rf /path/to/my-pizza-team/dist /path/to/my-pizza-team/mpt

# The archived standalone extension checkout, once `mpt setup` has unregistered it.
# History is preserved in GitHub (tag archive/pi-pizza-team) and in this repo
# (tag premerge/pi-pizza-team).
rm -rf /path/to/mpt-dev/pi-pizza-team
```

The `mpt-mcp-server` working directory was already removed. Its history is on GitHub
at tag `archive/mpt-mcp-server`, with the Claude/Codex/Kiro runners intact and the
uncommitted pivot preserved on branch `wip/mcp-tmux-tools`.

---

## 4. Things worth knowing, not doing

- **`mpt doctor` is the dry-run for everything.** It is read-only and prints the
  command that fixes each problem. Start there whenever something seems off.
- **`mpt lead` starts the leader for you** — it opens a tmux window in the project
  folder and attaches. Running it again attaches to the existing leader rather than
  starting a second one.
- **The daemon spawns teammates now, not the leader.** So a teammate can start with no
  leader connected, and adding a harness is a config entry (`harnesses.<name>.teammate`)
  rather than an extension release. If the daemon can't reach tmux — likely when it runs
  as a launchd/systemd service, which may have no `tmux` on `PATH` — it falls back to
  the leader realizing spawns, exactly as before. `mpt doctor` says which path is live,
  and a spawn that fails now shows in the Team tab with its reason instead of vanishing.
- **`mpt upgrade` now moves both halves** — it replaces the binary *and* rewrites the
  managed extension (by re-invoking the new binary, since the old process still
  carries the old embedded copy). Running agents still need restarting; the Team tab
  banner offers a one-click "restart all" for exactly the agents that are behind.
- **The permission system is not auto-installed.** `@gotgenes/pi-permission-system`
  stays your choice — coupling `mpt setup` to a third party's publishing would mean
  their bad release breaks our setup. Without it, a teammate now **warns loudly at
  start** instead of silently stalling on the first permission prompt. `doctor`
  reports it and gives the install command.
- **A bug fix you'll feel:** session ids were minted from `Date.now()` and used as a
  primary key, but "new chat" ends and starts a session in the same tick. Same
  millisecond meant a collision, a 500, and **the chat silently keeping its old
  context**. Fixed.

---

## 4a. A data bug that affected you, now fixed

**If autosave was on (it is by default), mpt could commit your own work.** The team
directory normally lives inside your project repository, and autosave ran an unscoped
`git commit` — which commits *everything staged*. So anything you had `git add`-ed was
swept into a commit authored "pi-pizza-team: autosave" and then **pushed**, on a timer.

Worth checking your project repos:

```bash
git log --oneline --author="$(git config user.name)" --grep="pi-pizza-team:" | head -20
```

For each such commit, `git show --stat <sha>` shows whether anything outside
`.my-pizza-team/` got in. This repository has one example — a
"pi-pizza-team: shutdown checkpoint" commit of `.my-pizza-team/daemon.pid` from June,
made by a daemon run inside the checkout; it is harmless (just a PID) and is left in
history rather than rewriting pushed commits.

Now fixed: every git call is scoped to the team directory, so your staged and
unstaged work is left exactly as you left it. mpt also writes a `.gitignore` into the
team directory so `state.db`, `daemon.pid`, and the logs are never committed — that
protection used to be assumed but was never actually created.

One limit: that `.gitignore` stops runtime files from being *added*. If one is already
tracked in a repo, it stays tracked — mpt won't `git rm --cached` in your repository
without asking. To untrack one yourself:

```bash
git rm --cached .my-pizza-team/state.db .my-pizza-team/daemon.pid 2>/dev/null; git commit -m "untrack mpt runtime state"
```

## 4b. One config change, if you use a readiness probe

The probe moved from the leader to the daemon (P3-2), so:

- `--ppt-readiness-probe` and `PPT_READINESS_PROBE` **are gone.** The extension no
  longer probes.
- Set `readinessProbe` in your team's `config.json` instead (the daemon reads it, and
  the Config page edits it).

If you never used one, nothing changes — the common case, and "no probe" still means
"always ready".

Worth knowing *why* it moved: while an agent reported readiness, an unreported team
counted as ready — it has to, since a freshly booted daemon knows nothing — so a
machine too wedged for the leader to even start was treated as **healthy** and work
kept being scheduled into it. The daemon runs whenever it matters, so it now answers
with zero agents connected.

## 5. Still to come (Phases 5 and 4)

Listed so you know what is *not* yet true:

- **Phase 4** — a second harness at Tier 0.

Phase 5 (end-to-end tests) is done and needs nothing from you — but if you run the
suites yourself: `deno task test` is the fast one (~5s), `deno task test:e2e` the slow
one (~21s, real git/tmux/shell). The e2e suite runs on a **private** tmux server, so it
can't disturb your sessions.

This file gets updated as those land.

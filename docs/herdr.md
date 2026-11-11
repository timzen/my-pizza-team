# herdr as a terminal backend — spike findings

Status: **implemented** in `daemon/terminal/herdr.ts` (story "herdr as an alternative
terminal backend", task 4): with `"terminal": "herdr"` the daemon spawns, focuses and
dismisses teammates in herdr, in the session `herdrSession` names (default: herdr's
default session). Task 5 added the user-facing paths: the assistant start (the web
UI's button and `mpt assistant`), `mpt assistant`'s attach / focus / print-instead-of-nest
(`cli/lead-attach.ts`, per "Ensuring a server, attaching, and 'inside herdr'" below),
`/health` `terminalStatus` and `mpt doctor`'s herdr checks (version, session, server,
same socket). The systemd placement below is not done yet (TODO.md).
[`tests/e2e/herdr-backend.test.ts`](../tests/e2e/herdr-backend.test.ts)
drives spawn/dismiss through the daemon on an isolated herdr, and
[`tests/e2e/herdr-assistant.test.ts`](../tests/e2e/herdr-assistant.test.ts) the assistant. This page records what herdr 0.9.5 was verified to do
(task 1's spike) and the decisions the backend follows. The proof is
[`tests/e2e/herdr-contract.test.ts`](../tests/e2e/herdr-contract.test.ts), run against an
isolated server ([`tests/e2e/_herdr.ts`](../tests/e2e/_herdr.ts)), with every JSON
response recorded in [`tests/fixtures/herdr/`](../tests/fixtures/herdr/).

[herdr](https://herdr.dev) is a terminal workspace manager: a background server owns
**workspaces → tabs → panes** (real terminals), and a CLI prints JSON over the server's
socket. tmux stays the default backend; herdr is to be an option a team picks.

## Operation mapping

What `daemon/terminal/tmux.ts` does today, and the herdr call that does the same. All of these
are argv-only CLI calls (`herdr --session <s> …`), like `TmuxExec`.

| mpt (daemon/terminal/tmux.ts) | herdr 0.9.5 | Notes |
|---|---|---|
| `tmuxAvailable` / `tmux -V` | `herdr --version` → `herdr 0.9.5`; `herdr status --json` | `status` works with no server and never starts one |
| server running? | `status server --json` → `.running` | API calls with no server fail with `server_not_running`; nothing auto-starts |
| `ensureSession(session)` | `workspace create --label <session> --cwd <dir> [--env K=V…] --no-focus` | Also opens a first tab, label `"1"`, and its root pane |
| `listWindows` / `windowExists` | `tab list --workspace <ws>` → `.result.tabs[].label` | Workspace found by `workspace list` → label |
| `spawnWindow` (fresh session) | `tab rename <first tab> <window>` then `pane run` | Reuses the first tab, as tmux renames the first window |
| `spawnWindow` | `tab create --workspace <ws> --label <window> --cwd <dir> --env K=V… --no-focus` → `.result.tab.tab_id`, `.result.root_pane.pane_id`; then `pane run <pane> <command>` | No command argument on create; `--cwd` replaces the typed `cd` |
| `sendKeys(line)` | `pane send-text <pane> <line>` + `pane send-keys <pane> enter`, or `pane run <pane> <line>` | `pane run` = text + Enter atomically (bracketed paste aware); prints nothing |
| `sendControl("C-c")` | `pane send-keys <pane> ctrl+c` | `C-c` accepted as an alias |
| `selectWindow` / `switchClient` / `focusClient` | `tab focus <tab>` | An attached client follows (verified with a real client) |
| `killWindow` | `tab close <tab>` | Closing the workspace's last tab closes the workspace |
| `kill-server` (tests only) | `server stop` / `session stop <name> --json` | Pane processes die with the server |
| (readiness, later) | `pane wait-output <pane> --match <text> --timeout <ms>`, `pane read`, `pane process-info` | `pane read` prints plain text, not JSON |

Errors: exit status 1, **nothing on stdout**, `{"error":{"code","message"}}` JSON on
stderr (`tab_not_found`, `pane_not_found`, `server_not_running`, …). Usage errors exit 2.
JSON clients are told to ignore unknown fields; the contract test checks only that the
fields mpt reads are still there with the same types.

## Decisions

### (session, window) → herdr: one workspace per team, one tab per agent

- **Server/session:** herdr's **default session** by default — the daemon passes
  `--session default` explicitly on every call (it beats an inherited
  `HERDR_SOCKET_PATH`, which herdr injects into every pane; verified). A team may name
  another session in config for isolation (`herdrSession`). *Why:* it is the tmux mapping — one
  user-level server that plain `herdr` attaches to, each team a named container in it
  — and one server process serves every team. A named session per team would also
  work (verified: each is a separate server and socket under
  `~/.config/herdr/sessions/<name>/`), but the user would have to know to run
  `herdr session attach <name>`, and every team would cost a server.
- **Team container:** one **workspace** labelled with the team's session name (today's
  `tmuxSession`, e.g. `mpt` — the key keeps its name for both backends; see
  docs/DESIGN.md "The Daemon Is the Supervisor"). Found by label in `workspace list`; created on demand.
- **Agent window:** one **tab** labelled with the window name (`leader`, the teammate's
  name), whose **root pane** runs the command. Tabs, not panes: a tab is what the user
  switches between, has a label, and maps 1:1 to a tmux window.
- Session names are limited to `[A-Za-z0-9._-]` by herdr; labels are free text. mpt's
  `assertSafeName` rules are stricter than both, so no new validation is needed.

### Finding a window again: by label, every time

herdr IDs (`w1`, `w1:t2`, `w1:p2`) are server-assigned and can change: `pane move`
re-qualifies a pane's ID, and a user can close and re-create a tab. Labels are what the
user sees and what mpt already reports (`{terminalSession}`/`{terminalWindow}`, formerly
`{session}`/`{window}`, as `terminalSession`/`terminalWindow` metadata). So mpt **resolves
`(workspace label, tab label)` to IDs on each operation** (`workspace list`, then
`tab list --workspace`), exactly as tmux addresses `session:window` by name. IDs are never
stored as the source of truth; an agent's metadata may carry `HERDR_PANE_ID` as a
display/debug hint only — the `terminalHandle` metadata (template placeholder
`{terminalHandle}`, empty when the backend doesn't know an ID before the command runs).

Two consequences:

- **Labels are not unique** in herdr: a second `tab create --label worker-one` succeeds
  (verified). mpt must check `tab list` before creating — `spawnWindow`'s idempotency
  check already does this for tmux — and the daemon, as the only creator, serialises
  it. Duplicate workspace labels likewise: use the first, and doctor can warn.
- A user renaming a tab in the TUI breaks the lookup, as renaming a tmux window does
  today. Accepted.

### Ensuring a server, attaching, and "inside herdr"

- **Ensure:** `herdr --session <s> status server --json`; if `.running` is false, spawn
  `herdr --session <s> server` **detached** (it stays in the foreground —
  `capabilities.detached_server_daemon` is `false` — and survives its parent exiting;
  verified), then poll `status server` until running (≤ ~10s). The daemon never stops the
  server: agents should outlive a daemon restart, as with tmux.
- **Socket location** comes from `$XDG_CONFIG_HOME` (else `$HOME/.config`) +
  `/herdr/[sessions/<name>/]herdr.sock` — *not* from `HERDR_CONFIG_PATH`, which only moves
  `config.toml` (verified). A launchd/systemd daemon with the user's `HOME` therefore
  finds the same server; `/health` reports `status --json` `.server.socket` as
  `terminalStatus.identity` (as it reports `tmuxSocket`), and doctor compares it with its own.
- **systemd:** a server the daemon spawns lives in the unit's cgroup, so
  `systemctl --user stop|restart` (default `KillMode=control-group`) would take every
  agent with it. tmux started by the daemon has the same exposure today. Recommended
  (not yet implemented; TODO.md): under systemd (`$INVOCATION_ID` set), start it outside the unit with
  `systemd-run --user --collect --unit=herdr-<session> herdr --session <s> server`,
  falling back to a plain detached spawn; or tell the user to start herdr themselves
  (attaching with `herdr` starts the server).
- **Attach:** `herdr` (default session) or `herdr session attach <name>` /
  `herdr --session <name>`. To land on the leader, `tab focus <leader tab>` first, then
  hand over the terminal. Attaching needs a real terminal with a size (a bare pty is
  refused: "terminal reported a zero-sized grid"). Detach is `ctrl+b q`.
- **Inside herdr:** panes get `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`,
  `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH` and `TERM_PROGRAM=herdr` (verified). Inside
  herdr on the team's server (`HERDR_SOCKET_PATH` equals the target's `.socket`), `mpt
  lead` must **not** run `herdr` — nested launch is refused unless
  `experimental.allow_nested` — and only `tab focus`es, as it `switch-client`s inside tmux.
  Inside a pane of a *different* herdr server it should print the attach command.

### Environment

A pane's environment is **the server's environment plus `--env`**; the environment of
the CLI process that ran `tab create` is *not* passed (verified: a variable set only for
the CLI call is unset in the pane, and `--env` overrides the server's value). So, as with
tmux `-e`, the agent env file's variables (and anything else an agent needs) must go in
`--env` on `workspace create` / `tab create`, never be assumed from the daemon. `--env`
values are passed verbatim (spaces and quotes intact). herdr strips inherited tmux,
screen and other terminals' session markers from new panes, and keeps its own
`HERDR_*` variables authoritative (verified: `--env HERDR_ENV=0` still gives the pane
`HERDR_ENV=1`). `--env` lasts only for the pane's first life: a pane a server restart
restores has the server's environment, not its tab's `--env` (verified; see "Restart").

### Version gating

Require **herdr ≥ 0.9.5** (the version this contract was verified on; protocol 22,
`endpoint_protocol_generation` 1). Read it from `herdr status --json` — `.client.version`
works with no server running; with one running also check `.server.version`,
`.server.compatible` (false → refuse with "restart herdr") and `.server.restart_needed` /
`.server.server_binary_stale` (→ doctor ⚠). `herdr --version` (`herdr X.Y.Z`) is the fallback
for a build whose `status --json` fails. `herdr api schema --json` (protocol and
schema version, 270 KB) is for debugging, not gating. The protocol number is herdr's
binary client protocol, so it is reported, not gated on.

### Restart: a label is not a live agent

A server restart (or a host reboot) restores the layout — same workspace and tab IDs,
same labels, cwds — but **not processes**: each pane comes back as a fresh shell with a
new `terminal_id` (verified). tmux has no equivalent: there, a window that exists has
its agent (or the shell it exited to). So for herdr, "window exists" is not enough for
`startLeader`'s `already-running` or `spawnWindow`'s idempotency: also check
`pane process-info` — a pane whose only foreground process is its shell
(`foreground_process_group_id == shell_pid`) has no agent, and mpt should `pane run` the
command into it rather than report it running. The restored pane's `--env` variables
are gone (verified), so a command mpt re-runs there has the server's environment
without the agent env file's variables.

**herdr's native agent-session restore is kept off mpt's panes.** herdr's official
agent integrations — Pi's `~/.pi/agent/extensions/herdr-agent-state.ts`, Claude's,
Copilot's hooks, installed with `herdr integration install` — report the pane's agent
session (`pane.report_agent_session`, with the Pi session file). herdr saves it in
`session.json`, and on restart, with `[session] resume_agents_on_restore` (default
true), types the agent's resume command into the restored pane itself: for Pi,
`pi --session <file>` (verified). That drops mpt's flags (`--ppt-teammate`,
`--ppt-name`, …), and a bare Pi in the team directory comes up as the *leader*. After
a reboot that once gave a team three ghost leaders answering every chat message,
while the real teammates never came back. herdr 0.9.5 has no per-pane opt-out (the
API has only `report_agent_session`, `release_agent` and `clear_agent_authority`; no
"don't resume" flag), and clearing a report after the fact loses a race, because the
integration reports again on every agent turn. But every integration reports only when
`HERDR_ENV` is `1` (with `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`). So mpt runs each
command it opens (teammates and the leader, fresh and restored tabs alike) as
`export HERDR_ENV=0; [cd <cwd> && ]<command>` (`herdrLaunchLine`). It goes on the
command line because herdr overrides `--env HERDR_ENV`. `export …;` works in sh, bash,
zsh and fish, and a shell without `export` still runs the command. The agent's
integrations then stay silent, herdr records no session for the pane, and mpt's
own restore (above) is the only one. The integration doesn't have to be installed;
with it, the cost is that herdr's sidebar falls back to its own process-based
detection for mpt's agents rather than their reported working/idle state. tmux is
unaffected. A pane that reported a session *before* this, saved in an existing
`session.json`, can still be resumed natively once; after that the agent runs with
`HERDR_ENV=0` and the report isn't renewed.

Safety nets for whatever still slips through: a pane mpt didn't open, a session saved
before the opt-out, or a user-run `pi` in the team's workspace:

- **One live leader** (ARCHITECTURE.md "Only one live leader"). A second Pi that
  comes up as leader while another is live is refused registration (409
  `leader_already_connected`), sets up nothing, and doesn't mirror or answer the chat.
- **Inbound spawns count toward the pool** (DESIGN.md "Team Size: Declared, not
  Clicked"). A spawn realized in the last 60s whose teammate hasn't registered yet
  counts, so the reconciler doesn't queue a second batch while the first is starting.
- **Unmanaged windows** (DESIGN.md "Unmanaged Windows Are Shown, Never Reaped"). A
  tab in the team's workspace that no online member, the leader or a starting spawn
  accounts for is listed in the Team tab with what runs in it, and closed only when
  the user asks.

## What doesn't map cleanly

| Gap | What to do |
|---|---|
| No command argument on `tab create` | Create, then `pane run`. Verified to work immediately after create, with no wait for the shell. |
| `workspace create` always opens a first tab (`"1"`) | Rename it to the first agent's window (as tmux's first window is renamed). |
| Closing the last tab closes the workspace | Never cache the workspace; ensure it on every spawn. |
| Duplicate labels allowed | List before create; the daemon serialises creation. |
| IDs server-assigned, may change (`pane move`) | Resolve by label each time (above). |
| Restart keeps tabs, not processes | Check `pane process-info` (above). |
| Restart drops a tab's `--env` | Accept; a re-run command has the server's env (above). |
| Native agent-session restore relaunches panes without mpt's flags | Run every command with `HERDR_ENV=0`, so integrations don't report (above). |
| A command's exit closes its tab | Same as tmux; `pane run` into the shell keeps the shell, so dismiss still sends Ctrl-C then closes the tab. |
| `herdr server` doesn't daemonize | Spawn it detached (above). |
| Multiple attached clients can each view a different tab | `tab focus` moved the one attached client in the test; with several clients herdr decides which follow. Accept; document. |
| No "which client called me" (tmux's `$TMUX` → `switch-client`) | `tab focus` is server-wide, which is what `/ppt-hop` wants anyway. |
| Background network calls (version and agent-manifest checks) | herdr's config (`[update] version_check`, `manifest_check`); the user's choice, not mpt's. The test sandbox turns them off. |

## The contract test

`tests/e2e/herdr-contract.test.ts` (in `npm run test:e2e`; skips only where herdr isn't
installed, and a probe test fails if it can't even be probed) covers: status and
version with no server; starting a headless server; the workspace (team container) and
its first tab reused by rename; a labelled tab with cwd and env, running a command;
the env precedence; listing tabs and panes by label; duplicate labels; send-text +
Enter; Ctrl-C; wait-output and read; focus; the error shapes; a command's exit closing its
tab; the last tab closing the workspace; stopping the server; a restart restoring layout
but not processes nor `--env`; herdr's native restore typing `pi --session <file>` into
a restored pane that reported a session, and `--env HERDR_ENV=0` not overriding
herdr's own; and a real client (in a private tmux window) following `tab focus`.

Isolation (`tests/e2e/_herdr.ts`): `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and
`HERDR_CONFIG_PATH` all point into a temp dir, every call passes a random
`--session mpt-xxxxxxxx`, inherited `HERDR_*`/`TMUX` are stripped, and teardown stops the
server (then kills it if needed) and removes the directory. The user's default session
and real tmux server are never addressed.

Fixtures: re-record with `MPT_HERDR_RECORD=1 node --test tests/e2e/herdr-contract.test.ts`
(sandbox paths become `/tmp/herdr-sandbox`, the session `mpt-sandbox`, the binary
`/usr/local/bin/herdr`, pids `4242`).

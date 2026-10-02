# my-pizza-team 🍕

> A **π pizza team** (3.14 pizzas, the perfect size) — a daemon for multi-agent team coordination.

Manages stories, tasks, workflows, and agent lifecycle, and runs a team of
autonomous coding agents against them — each in its own tmux window you can watch.
Agents run on [Pi](https://pi.mariozechner.at/) today; see
[Other harnesses](#other-harnesses) for what that means for anything else.

```
┌──────────────────────────────────────────────────────────────┐
│                     mpt (one binary)                         │
│   stories & board · work queue · workflows · chat · usage    │
│   spawns teammates in tmux · web UI · HTTP API · Pi extension│
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                ▼                              ▼
         ┌─────────────┐              ┌───────────────────┐
         │  Pi leader  │              │  Pi teammates     │
         │ (you chat   │              │ (autonomous, one  │
         │  with it)   │              │  tmux window each)│
         └─────────────┘              └───────────────────┘
```

- **You** create stories, tasks, and scheduled jobs in the web UI (or ask the leader to)
- **Teammates** poll for work, claim it, do it, and report COMPLETE or FAILED
- **The daemon** admits work (one task in flight per story), advances completed
  work, keeps the team at its declared size, and tracks everything

📖 **New here?** [QUICKSTART.md](QUICKSTART.md) gets a team running in about five
minutes: install `mpt` and Pi, then `mpt setup`, `mpt start --daemon`, `mpt lead`.
The in-app **Help** page is the user guide ([GUIDE.md](GUIDE.md)).

---

## CLI Reference

```
mpt <command> [options]

Commands:
  setup [--dry-run]     Install the Pi extension, create the team dir, trust the folder
  setup --uninstall     Undo what setup did (leaves the team directory and its data)
  doctor                Read-only checklist of prerequisites, with a fix for each problem
  start [--daemon|-d]   Start the daemon (foreground, or background with -d)
  lead [--no-attach]    Start the leader in tmux and attach to it
  stop                  Stop the running daemon
  status                Check if the daemon is running + show a summary
  upgrade [--check]     Update mpt *and* its Pi extension (--check only reports)
  install               Install as a user service (launchd/systemd; starts on login)
  uninstall             Remove the service
  rotate-token          Generate a new API token (saved to config.json)
  setup --harness <h>   Prepare an experimental harness (kiro, claude)
  agent --harness <h>   Run an experimental teammate (the daemon starts these)
  --version, --help
```

`mpt setup` prints every change before making it and records what it did, so
`--uninstall` undoes exactly that. It won't replace a registered development
checkout of the extension (it steps aside and says so), and uninstall never revokes
Pi project trust. `mpt doctor` is read-only — also the dry run for setup — and exits
non-zero only for real breakage.

`mpt lead` opens a `leader` window in the project directory running the harness's
`leader` command. Running it again attaches to the existing leader rather than
starting a second one.

### Upgrading

`mpt upgrade` downloads the latest GitHub release for your platform, verifies its
checksum, replaces the binary in place, rewrites the managed Pi extension to match,
and restarts the service if one is installed. **Restart running agents afterwards**
— they keep the old extension until their Pi restarts; the Team tab flags them and
can restart them for you.

The version check uses the GitHub API, which allows **60 unauthenticated requests
per hour per IP** — easily exhausted on a shared-egress machine (`HTTP 403`). When
the API fails, `mpt upgrade` falls back to plain `github.com` release links, which
aren't rate limited, so the upgrade still completes (checksum included). Setting a
token skips the fallback:

```bash
export GITHUB_TOKEN=ghp_xxxx   # or MPT_GITHUB_TOKEN / GH_TOKEN
```

A **no-scope** Personal Access Token is enough (public repo, read-only). It is only
ever sent to `api.github.com`.

---

## Configuration

The daemon reads `.my-pizza-team/config.json`, merged over built-in defaults, and
most of it is editable on the **Config** page. Minimal:

```json
{
  "port": 7437,
  "defaultWorkflow": "default"
}
```

### Full Reference

```jsonc
{
  // ─── Server ────────────────────────────────────────────────────
  "port": 7437,
  "apiToken": "your-secret-token",       // Required to bind anything but localhost

  // ─── Workflow ──────────────────────────────────────────────────
  "defaultWorkflow": "default",          // Workflows themselves live in workflows/

  // ─── Team ──────────────────────────────────────────────────────
  "tmuxSession": "my-pizza-team",        // Where teammate windows are created
  "maxTeammates": 4,
  "minTeammates": 2,                     // Declared team size (omit = half of maxTeammates; 0 = none)
  "agentTimeoutSeconds": 90,             // Silence before an agent is reaped
  "teammates": {
    "nouns": ["ripley", "deckard", "neo"] // Name generation (adjective-noun)
  },

  // ─── Harnesses ─────────────────────────────────────────────────
  // Start commands the daemon types into a fresh tmux window. Omit for the
  // built-in Pi templates. Placeholders: {name} {url} {cwd} {session} {window}.
  "defaultHarness": "pi",
  "harnesses": {
    "pi": {
      "teammate": "pi -a --ppt-worker --ppt-daemon={url} --ppt-name={name} --ppt-tmux-session={session} --ppt-tmux-window={window}",
      "leader": "pi --ppt-lead --ppt-daemon={url} --ppt-tmux-session={session} --ppt-tmux-window={window}"
    }
  },

  // ─── Scheduling ────────────────────────────────────────────────
  // Optional: a shell command the daemon runs every 30s. Exit 0 = ready; otherwise
  // cron jobs are held (not failed) until it recovers, then fire once.
  "readinessProbe": "my-credentials-check",

  // ─── Auto triage ───────────────────────────────────────────────
  // A teammate reads each note you've changed and comments with an analysis.
  // On by default. intervalMinutes re-arms on daemon restart.
  "triage": { "enabled": true, "intervalMinutes": 60, "quietMinutes": 10 },

  // ─── Experimental ──────────────────────────────────────────────
  "experimental": { "harnesses": true }, // allow Kiro / Claude Code teammates (mpt agent)

  // ─── Autosave ──────────────────────────────────────────────────
  "autosave": {
    "flushIntervalMinutes": 30,
    "commitIntervalHours": 24,
    "commitMessage": "my-pizza-team: checkpoint {timestamp}",
    "autoCommit": true                   // Commit the team dir (only) into your git repo
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAM_DIR` | `./.my-pizza-team` | Team directory, or its parent |
| `PORT` | `7437` | Daemon HTTP port |
| `HOST` | `127.0.0.1` | Bind address (anything else requires an API token) |
| `MPT_API_TOKEN` | — | Overrides `config.apiToken` |
| `MPT_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` | — | Authenticates `mpt upgrade`'s GitHub API call |
| `MPT_HOME` | `$HOME` | Where the managed extension lives (`$MPT_HOME/.my-pizza-team/pi-extension/`) |
| `MPT_PI_EXTENSION` | — | Use this extension source instead of the embedded one |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's settings directory (setup/doctor read and write it) |
| `UI_DIST` | — | Serve the web UI from this directory |

### Team Directory Layout

```
.my-pizza-team/
├── config.json
├── .gitignore           # written by mpt: excludes the runtime files below
├── state.db             # SQLite runtime index (rebuilt from the files; not committed)
├── daemon.pid           # while the daemon runs
├── daemon.log           # a background daemon's output (daemon.log.1: the run before)
├── workflows/
│   └── default/
│       ├── workflow.json
│       └── in_progress.md   # persona for each agent state
├── stories/             # one file per story: order + status of its tasks
│   └── my-story.json    #   tasks: [{id, status}]
├── tasks/               # EVERY unit of work is a WorkDef
│   └── my-story-1/
│       ├── workdef.md   #   Goal / Acceptance Criteria / Additional Context + parent
│       ├── comments.jsonl
│       └── attachments/
├── schedules/           # cron parents (fire their child WorkDefs)
│   └── nightly.json
├── templates/           # reusable molds for Solitary tasks (never enqueued)
│   └── investigate-ticket/template.md
├── archived/            # archived stories (with a synopsis)
├── backlog/             # backlogged stories
├── context/             # context library: reusable prompt/context markdown
├── assistant/
│   └── sessions/        # one markdown transcript per chat session
├── triage.md            # Auto-triage instructions (optional; absent = built-in)
├── thoughts/            # Thoughts board notes (thoughts/<id>.md)
├── groups.json          # Thought groups
└── usage/               # token-usage ledger, one JSON line per agent run
    └── 2026-09.jsonl
```

Everything but the runtime files is plain text meant to be committed. If the team
dir is inside a git repo, autosave commits **only that directory** (never your own
staged work) and pushes if there's a remote. Turn it off with
`autosave.autoCommit: false`.

---

## Workflows

A workflow is an **ordered pipeline of active states** between the implicit `todo`
and `done` buckets. There is no transition matrix: the daemon admits one task per
story into the pipeline (CONWIP), advances completed agent work automatically, and
you can move any card anywhere. See
[docs/DESIGN.md](docs/DESIGN.md#the-work-model).

```json
{
  "states": [
    { "name": "in_progress", "type": "agent" },
    { "name": "review", "type": "manual" }
  ]
}
```

| Type | Who works it | How it completes |
|------|--------------|------------------|
| `"agent"` | Teammates (claim → work → COMPLETE) | The daemon advances it automatically |
| `"manual"` | You (or the leader) | You move the card onward |

When a task lands in an agent state the daemon enqueues a `READY` WorkItem for it;
a teammate claims it and, on COMPLETE, the task advances. On FAILED it stays put
until you move it (moving it back into an agent state enqueues a fresh attempt).

**Personas.** A markdown file named after an agent state
(`workflows/<name>/<state>.md`) is role framing injected into that state's prompt:

```markdown
You are a careful implementer. Write the code the task describes,
add tests, and keep the change minimal. Summarize what you did when
you finish — the task advances automatically.
```

Manual states need no persona. Create workflows, edit their states, and edit
personas on the **Workflows** tab (under Board); every story names its workflow at
creation. With no workflows on disk, a built-in `default` (`in_progress` →
`review`) is used.

---

## Assistant Chat

The assistant is a live chat — and it is **your leader**. There is no separate
assistant to start: the chat works whenever the leader is up (`mpt lead`). The web
UI and the leader's tmux window are **two views of one conversation**: the daemon
mirrors that Pi session in both directions. See
[docs/DESIGN.md](docs/DESIGN.md#one-agent-to-talk-to).

It lives in the **left dock** on every page, as the **Assistant** tab beside
**Team**. The dock collapses to an icon rail (with an unread badge) or resizes by
dragging its edge; in a narrow desktop window it becomes a floating button. On a
phone, the chat is a tab of the [phone view](#phone-view).

- **Send whenever you like.** The composer never locks; a message sent while the
  assistant is working is steered into its current run.
- **A real editor for long prompts.** The Edit button, Ctrl+G, or `/editor` opens
  the message full-screen in CodeMirror, vim keys on by default (one click to turn
  off). Notes and story/task descriptions are written in it directly, inline.
- **Real receipts.** ⧗ queued → ✓ delivered → ✓✓ read.
- **Bubbles from prose.** Each paragraph becomes a bubble (code blocks and lists are
  never split); markdown is rendered; any bubble can be expanded or copied.
- **Reply to a bubble** — the quote travels with your message.
- **Peek at its thinking** — click the `…`. Ephemeral: never saved.
- **Terminal parity.** Type in the leader's tmux window and it appears in the web
  chat (with a terminal glyph), and vice versa.
- **Personas.** Any context-library entry tagged `persona` becomes a selectable
  assistant. Swapping starts a new chat as that persona; nothing is deleted.
- **Sessions: nothing is lost.** New chat, a persona swap, or resuming another
  session snapshots the current transcript to `assistant/sessions/<id>.md`.
  **History** lists every session; **Resume** switches the leader back to that Pi
  session, context included.

The leader also has tools for the team's data — creating stories, tasks, and
schedules, and reading and writing the Thoughts board.

## Phone View

`/m` is a phone-sized UI for checking in: **Team** (teammates and the queue, with
its recovery buttons; tap a teammate to watch or pair), **Chat**, **Thoughts** (a
list; read, check off, and write notes), and **Inbox** (open a row to read the run's
summary in place). A phone that opens the home page is sent there automatically; 🖥
switches that device to the full UI. Boards, workflows, and config stay on the
desktop. See [docs/DESIGN.md](docs/DESIGN.md#a-phone-is-a-peek).

The daemon only listens on localhost, so reaching it from a phone needs a tunnel in
front of it that handles login: an SSO-protected tunnel service that forwards to
`localhost:7437`, limited to you. A tunnel makes a localhost daemon reachable from
elsewhere, so also set an API token (`mpt rotate-token`): the browser asks for it
once.

---

## Agent Protocol

Agents work the **WorkItem queue** in a poll → claim → work → set-state loop.
Workers never move tasks: the daemon reacts to the terminal state (COMPLETE
advances a board task; FAILED leaves it for a human). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#agent-lifecycle).

```
1. POST /api/agents/register              → register (name, directory, protocol version)
2. GET  /api/agents/next-work?agentId=    → { workItem: { id, title } | null }
3. POST /api/agents/claim/:workItemId     → lease (→ IN_PROGRESS) + the daemon's prompt
   (the agent does the work in the ref's directory and posts a comment)
4. POST /api/agents/work-items/:id/state  → { state: "COMPLETE" } or { state: "FAILED" }
5. POST /api/agents/heartbeat             → keep-alive (restores this agent's MORIBUND items)
   POST /api/agents/:id/session-stats     → optional, after each turn: context fill + session cost
```

**Registration** carries a name, a working `directory` (the only work-selection
signal), and the version handshake (`protocolVersion`, `harness`,
`harnessVersion`). A protocol version the daemon can't serve is refused with 409
and the fix named; build-version differences are only reported, and shown in the
Team tab.

**Matching is directory affinity** — there are no capabilities or skills; every
teammate is a generalist. `getNextWorkItem()` offers, oldest first:

1. items whose directory is the agent's directory,
2. then items with no directory,
3. then another directory's items — only if *no online agent* is homed there.

**On claim** the agent gets `workItem: { id }` and a `prompt`: the complete,
daemon-assembled message (state persona, story, working-directory instruction, the
task's goal/criteria/context, attached reference context, lead comments,
completion guidance). Harnesses deliver it verbatim.

---

## Harness Guides

### Pi (native)

The Pi extension (`harnesses/pi/` in this repo) provides the leader and teammate
integration. It ships **inside the `mpt` binary** and `mpt setup` installs it to
`~/.my-pizza-team/pi-extension/`, so the daemon and the extension always match
versions — `mpt upgrade` moves both together.

The **leader** is the Pi you chat with; `mpt lead` starts it. **Teammates** are
started by the daemon in their own tmux windows and run an autonomous loop: poll →
claim → execute → set state → repeat. If the daemon can't reach tmux (possible when
it runs as a login service), the leader starts them instead; `mpt doctor` says which
path is live.

Recommended: `@gotgenes/pi-permission-system`, which lets teammates work
autonomously. Without it they stop at the first permission prompt (the extension
warns when it's missing).

Working on the extension itself? Register your checkout, and `mpt setup` will step
aside rather than replace it:

```bash
pi install ./harnesses/pi
```

### Other harnesses

**Pi is the only fully supported harness.** Kiro and Claude Code can run as
**experimental teammates**, over the [Agent Client Protocol](https://agentclientprotocol.com):
`mpt agent` runs in the teammate's tmux window, starts the agent as a child speaking
ACP, and speaks the daemon's protocol for it. See
[docs/DESIGN.md](docs/DESIGN.md#harness-tiers-and-why-not-mcp).

```bash
mpt setup --harness kiro     # checks for kiro-cli (Kiro speaks ACP natively)
mpt setup --harness claude   # installs the pinned Claude Code ACP adapter
```

Then opt the team in — `"experimental": { "harnesses": true }` in `config.json`,
and restart the daemon — and pick the harness in the Team tab's **Spawn** dialog.
Without the flag the daemon refuses to spawn or register them.

What they do: claim work, run it in a fresh session per item, complete it with the
agent's summary or give up through `mpt agent fail "<why>"`, answer permission
prompts (allow once), stream to the watch view, and record usage — tokens and USD
cost for Claude; Kiro reports only credits, which aren't recorded. Not yet: pairing
from the web UI, or leading. Any other agent can still speak the HTTP protocol
directly (below).

### Any CLI agent (HTTP protocol)

```bash
#!/bin/bash
DAEMON_URL="http://localhost:7437"
AGENT_NAME="codex-1"

# Register (name + working directory + protocol version)
curl -s -X POST "$DAEMON_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$AGENT_NAME\", \"name\": \"$AGENT_NAME\", \"directory\": \"$(pwd)\", \"protocolVersion\": 5, \"harness\": \"shell\"}"

while true; do
  curl -s -X POST "$DAEMON_URL/api/agents/heartbeat" -H "Content-Type: application/json" \
    -d "{\"id\": \"$AGENT_NAME\", \"status\": \"idle\"}" > /dev/null

  WI=$(curl -s "$DAEMON_URL/api/agents/next-work?agentId=$AGENT_NAME" | jq -r '.workItem.id // empty')
  [ -z "$WI" ] && sleep 5 && continue

  # Claim: the daemon leases the WorkItem and returns the prompt
  PROMPT=$(curl -s -X POST "$DAEMON_URL/api/agents/claim/$WI" \
    -H "Content-Type: application/json" -d "{\"agentId\": \"$AGENT_NAME\"}" | jq -r '.prompt')

  # ... run your agent on "$PROMPT", then leave a summary comment
  curl -s -X POST "$DAEMON_URL/api/agents/comments/$WI" -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\", \"body\": \"Work completed\"}"

  # Complete (the daemon advances the task). Use "FAILED" to give up.
  curl -s -X POST "$DAEMON_URL/api/agents/work-items/$WI/state" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\", \"state\": \"COMPLETE\"}"
done
```

The current protocol version is `PROTOCOL_VERSION` in `shared/protocol.ts`.

---

## API Overview

| Group | Key Endpoints | Purpose |
|-------|-----------|---------|
| Health | `GET /health` | Uptime, agents, queue depth, leader presence, readiness, spawn capability (unauthenticated) |
| Status / control | `GET /api/status`, `POST /api/control/pause\|resume` | Summary; pause/resume work distribution |
| Config | `GET/PUT /api/config`, `GET/PUT /api/teammate-pool` | Config and workflows; the declared team size |
| Readiness | `GET/POST /api/readiness` | Team readiness (the daemon probes; a harness may report) |
| Stories | `/api/stories/*`, `/api/archived`, `/api/backlog/*` | CRUD, archive, backlog |
| Board tasks | `/api/stories/:id/tasks[/reorder]`, `/api/tasks/:id/move`, `DELETE /api/tasks/:id` | Story-parent operations |
| WorkDefs | `/api/work-defs/*` | Every unit of work: CRUD, enqueue, archive, comments, attachments, usage |
| Schedules | `/api/schedules/*` | Cron parents |
| Templates | `/api/templates/*` | Reusable molds for Solitary tasks (never enqueue) |
| WorkItems | `GET /api/work-items[/:id]`, `POST .../cancel\|force-fail\|read`, `POST /api/work-items/re-enqueue` | The queue and its recovery actions |
| Agents | `/api/agents/*` | Register, heartbeat, next-work, claim, state, comments, directives |
| Directives | `/api/leader/directives`, `/api/spawn-requests` | Spawn/dismiss/reset asks; pending and failed spawns |
| Teammate transcript | `/api/agents/:id/transcript[/stream\|/watch]` | Watch-only live view (streams only while watched) |
| Teammate pairing | `POST /api/agents/:id/pair\|messages\|release`, `GET .../pairing[/state]` | Talk to a paused teammate from the browser |
| Usage | `POST /api/agents/:id/usage`, `GET /api/usage/daily\|day` | Token and cost ledger; dashboard rollups |
| Assistant | `/api/assistant/*` | The chat: messages, SSE stream, receipts, thoughts peek, sessions, persona |
| Context | `/api/context/*` | Reusable prompt/context library |
| Thoughts | `/api/thoughts/*`, `/api/thought-groups/*` | Markdown sticky-note board |
| Workflows | `GET /api/workflows[/:name]`, `GET/PUT .../instructions/:state` | Workflows and their personas |

Full route table: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#api-routes)

---

## Project Structure

```
my-pizza-team/
├── main.ts            # Entry point of the compiled binary (→ cli/main.ts)
├── daemon/            # HTTP server (Hono on Deno.serve), Store, tmux supervisor
│   ├── server.ts      # Route orchestrator
│   ├── store.ts       # SQLite index + file sync (self-contained parts in store/)
│   └── routes/        # Route modules
├── cli/               # The mpt command (start, setup, doctor, lead, upgrade, service)
├── ui/                # Web UI (React + Vite + shadcn/ui)
├── shared/            # Types, protocol contracts, constants
├── harnesses/pi/      # The Pi extension (its own package.json; embedded in mpt)
├── agent/             # mpt agent: the ACP supervisor for experimental harnesses
├── desktop/           # Tray/menu-bar apps (macOS, Windows)
├── scripts/           # Build, packaging, release, code generation
├── tests/             # Fast suite; tests/e2e/ is the slow suite
└── docs/              # ARCHITECTURE.md (the map), DESIGN.md (the why)
```

---

## Development

```bash
deno task dev          # Auto-reload daemon (the same daemon `mpt start` runs)
deno task mpt <cmd>    # Run the CLI from source
deno task ui:dev       # Vite dev server for the UI
```

Gates — all must pass before a commit:

```bash
deno task check          # type-check daemon/, cli/, shared/, tests/
deno task test           # fast suite (seconds)
deno task test:e2e       # real git, tmux, and shell — run before pushing
deno task typecheck:ext  # the Pi extension
deno task test:ext       # the Pi extension's suites
(cd ui && npx tsc -b)    # the web UI
```

The extension's version is generated from `deno.json` (`deno task sync-version`)
and its shared constants from `shared/types.ts` (`deno task sync-shared`); CI fails
if either is out of step.

## Building

```bash
deno task compile              # ./mpt for this platform, with the UI and Pi extension embedded
deno task compile:all          # all platforms → dist/
./scripts/publish.sh [x.y.z]   # bump, tag, push — the tag triggers the release workflow
```

---

## License

MIT

# my-pizza-team 🍕

> A **π pizza team** (3.14 pizzas, the perfect size) — a daemon for multi-agent team coordination.

Manages stories, tasks, workflows, and agent lifecycle, and runs a team of
autonomous coding agents against them — each in its own tmux window you can watch.
Agents run on [Pi](https://pi.mariozechner.at/) today; see
[Other harnesses](#other-harnesses) for what that means for anything else.

```
┌──────────────────────────────────────────────────────────────┐
│                     mpt (npm package)                        │
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
  upgrade [--check]     Update mpt (npm) *and* its Pi extension, restart the service
                        (--check only reports)
  install               Install as a user service (launchd/systemd; starts on login)
  uninstall             Remove the service
  rotate-token          Generate a new API token (saved to config.json)
  plugins <cmd>         Manage the team's plugin packages (see "Plugin packages" below):
                        add <spec> [--config '<json>'], list, remove <spec|identity>,
                        update [<spec|identity>]; restart the daemon afterwards
  setup --harness <h>   Prepare an experimental harness (kiro, claude)
  agent --harness <h>   Run an experimental teammate (the daemon starts these)
  --version, --help

Options:
  --node <path>         The Node that runs mpt (saved by setup/install/upgrade)
  --yes, -y             setup/install/upgrade: don't ask which Node, use the current one
```

`mpt setup` prints every change before making it and records what it did, so
`--uninstall` undoes exactly that. It won't replace a registered development
checkout of the extension (it steps aside and says so), and uninstall never revokes
Pi project trust. `mpt doctor` is read-only — also the dry run for setup — and exits
non-zero only for real breakage.

### Plugin packages

A team can pull work from outside sources through **plugin packages** — npm
packages, git repositories, or local folders whose `package.json` declares
`"mpt": { "sources": ["./dist/index.js"] }`. They are listed in the team's
`config.json` `packages` and managed with `mpt plugins`:

```
mpt plugins add npm:@acme/mpt-jira@1.2.0 --config '{"tokenEnv":"JIRA_TOKEN"}'
mpt plugins add git:github.com/acme/mpt-tracker@main   # @ref: branch, tag or commit
mpt plugins add ./my-plugin                            # local: loads in place, never copied
mpt plugins list                                       # kind, identity, ref, installed?, load status
mpt plugins update [<spec|identity>]                   # re-fetch unpinned npm/git packages
mpt plugins remove <spec|identity>                     # deletes the install (never a local path)
mpt plugins doctor [<path|spec>] [--config '<json>']   # check it loads; with --config, a live init + sync
```

npm and git packages are installed under `<teamDir>/packages/` (npm with
`--omit=peer`, so the plugin uses this mpt's copy of `my-pizza-team`; a git clone
also gets `npm install` and `npm run build` when it has dependencies / a build
script). `add` validates the manifest before touching config.json. A version (npm)
or a tag/commit (git) pins a package, and `update` skips it; a branch or no ref
follows upstream. Relative local paths resolve from the current directory. The
daemon loads plugins at startup, so restart it after any change
(`mpt stop && mpt start --daemon`, or restart the service); `mpt doctor` reports
a package that failed to load. To write one, see GUIDE.md "Writing a Work Source
plugin".

`mpt lead` opens a `leader` window in the project directory running the harness's
`leader` command. Running it again attaches to the existing leader rather than
starting a second one.

`mpt status` respects the [feature toggles](#feature-toggles): a switched-off kind's
count is left out and a `Turned off: …` line names what's off. The CLI has no
commands that create or edit stories, tasks, or schedules (that's the web UI and
the assistant); a daemon refusal it does meet is shown as "Stories are disabled —
enable them in Config (features.stories)".

### Which Node runs mpt

mpt is an npm package (`npm i -g my-pizza-team`, Node >=24), so "mpt" is really
`<node> <package>/dist/main.js`. The service, teammate callbacks and `mpt upgrade`
all need a Node that is still there after this shell closes, so `mpt setup`,
`mpt install` and `mpt upgrade` ask once and save it to
`~/.config/mpt/runtime.json` (`$XDG_CONFIG_HOME/mpt/` on Linux if set):

```json
{ "node": "/opt/homebrew/bin/node", "chosenAt": "2025-06-01T12:00:00.000Z" }
```

- The suggestion is the Node you're running, spelled the stable way when there is
  one (e.g. `/opt/homebrew/bin/node` rather than its versioned Cellar path). Press
  Enter to accept or type another path; it must run and be >=24.
- The path is saved **as typed, never symlink-resolved**, so `/opt/homebrew/bin/node`
  keeps working across `brew upgrade`.
- Version-manager paths (`~/.nvm/versions/…`, fnm, volta, asdf, mise) work but get a
  warning: the service breaks when that version is removed.
- No terminal, or `--yes`: the current Node is used without asking (and printed).
- Overrides, strongest first: `--node <path>` (any command), `MPT_NODE`, the file.
  `mpt setup --node /usr/local/bin/node` changes the saved choice.
- If the saved Node disappears or is too old, the next setup/install/upgrade asks
  again (or fails with a clear message when there's no terminal). `mpt doctor`
  reports the saved Node, its version and where the setting came from, and warns
  if the service or the running mpt uses a different Node.
- The macOS menu bar app reads the same file and runs `<node> <package entry>`; if
  it finds no mpt it says to `npm i -g my-pizza-team` and run `mpt setup`.

### Service

`mpt install` writes a user service that starts the daemon on login:

- **macOS:** `~/Library/LaunchAgents/com.my-pizza-team.daemon.plist` (launchd).
- **Linux:** `~/.config/systemd/user/my-pizza-team.service` (systemd, with lingering).

It runs `<saved node> <abs path to the installed package's dist/main.js> start`
(`cli/main.ts` when installed from a checkout), with `TEAM_DIR`, `PORT` and your
shell's `PATH` captured, since launchd/systemd start services with a bare PATH.
Re-run `mpt install` after changing the saved Node or moving the install — `mpt
doctor` warns when the service's Node or entry differs. `mpt uninstall` removes it.

### Upgrading

```bash
mpt upgrade --check   # is a newer version published?
mpt upgrade           # install it, refresh the Pi extension, restart the service
```

`mpt upgrade` reads the latest version from the npm registry (your `npm config get
registry`), then runs `npm install -g my-pizza-team@<latest>` with **the saved
Node's own npm** (`<dir of node>/npm`), so the copy the service runs is the one that
moves. If the mpt you ran isn't that copy, it says so. On a permission error it
prints the exact command to rerun (with `sudo`, or fix npm's global prefix) and
exits non-zero. After installing, the new copy rewrites the managed Pi extension and
the installed service is restarted. **Restart running agents afterwards** — they
keep the old extension until their Pi restarts; the Team tab flags them and can
restart them for you.

Running from source, `mpt upgrade` just points you at `git pull` (then `npm
install`, `mpt setup` to rewrite the managed extension, and restart the daemon).

### Migrating from the binary

Releases up to 0.27 shipped `mpt` as a single compiled binary (built with Deno).
From 0.28 mpt is the npm package `my-pizza-team` and runs on Node.js >=24. With
Node.js 24 or newer installed, the old binary's own `mpt upgrade` moves you
across: it installs a small bridge script in the binary's place, which installs
the npm package with your Node's npm, records that Node, re-points the service at
it, and from then on hands every `mpt` call to the package. Without a usable Node
(or if npm can't install), the bridge says why and puts the v0.27.0 binary back,
so `mpt` keeps working — install Node and run `mpt upgrade` again.

Afterwards `mpt doctor` points out the leftover: the bridge still sits at the old
binary's path ("mpt bridge"); delete it once npm's own `mpt` is on your PATH. On
Windows, or to do it by hand:

```bash
rm /usr/local/bin/mpt      # delete the old binary first, wherever it is (`which -a mpt`)
hash -r                    # so your shell forgets the old path
npm i -g my-pizza-team     # Node >=24
mpt setup                  # asks which Node runs mpt; rewrites the Pi extension
mpt install                # rewrites the service to run <node> <package>/dist/main.js
```

(Delete the old binary first: if it comes earlier on PATH than npm's `mpt`,
`mpt setup` and `mpt install` would otherwise run the old one.)

Your team directory, config and data are untouched. `mpt doctor` warns about
both leftovers: an `mpt` on PATH that is a native binary ("Old mpt binary"), and a
service that still launches the binary directly ("Service entry … an old
compiled-binary install").

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

  // Optional: when a teammate's model call fails (e.g. a Bedrock 503 or expired
  // credentials), the work item is retried automatically — after each backoff, and
  // once the readiness probe passes. Out of retries → FAILED in the Inbox.
  "retry": { "maxRetries": 3, "backoffMinutes": [1, 5, 15] },

  // ─── Auto triage ───────────────────────────────────────────────
  // A teammate reads each note you've changed and comments with an analysis.
  // On by default. intervalMinutes re-arms on daemon restart.
  "triage": { "enabled": true, "intervalMinutes": 60, "quietMinutes": 10 },

  // ─── Directory pickers ─────────────────────────────────────────
  // Offered first by every directory field in the UI (then recent dirs).
  // Stored normalized (~ expanded, symlinks resolved). Managed in Config →
  // General or by starring a directory in any picker (/api/directories/favorites).
  "favoriteDirectories": ["/path/to/project"],

  // ─── Assistant ─────────────────────────────────────────────────
  // How you talk to the assistant: "chat" (default, iMessage-style bubbles) or
  // "terminal" (the same transcript view as watching/pairing with a teammate).
  // Config → General; applies live from the assistant's next reply.
  "assistant": { "chatMode": "chat" },

  // ─── Work distribution ─────────────────────────────────────────
  // One teammate per directory (default true): overlapping work waits its turn.
  "exclusiveDirectories": true,

  // ─── Feature toggles ───────────────────────────────────────────
  // Which work-item kinds the team uses. Omitted = all on (existing teams);
  // `mpt setup` writes { tasks: true, stories: false, schedules: false } for a
  // new team. See "Feature toggles" below.
  "features": { "stories": true, "tasks": true, "schedules": true },

  // ─── Experimental ──────────────────────────────────────────────
  "experimental": { "harnesses": true }, // allow Kiro / Claude Code teammates (mpt agent); also Config → Teammates

  // ─── Autosave ──────────────────────────────────────────────────
  "autosave": {
    "flushIntervalMinutes": 30,
    "commitIntervalHours": 24,
    "commitMessage": "my-pizza-team: checkpoint {timestamp}",
    "autoCommit": true                   // Commit the team dir (only) into your git repo
  }
}
```

### Feature toggles

`features` switches whole work-item kinds on or off: **`stories`** (stories and their
board tasks, pending stories, archive), **`tasks`** (Solitary tasks *and* Task Templates — templates are hidden from the web UI), and
**`schedules`** (Scheduled tasks and their cron). Thoughts, Context, the Queue and the
Inbox are always on, so every kind can be off at once.

- **Defaults.** No `features` key — every team that predates the toggles — means
  everything on; a missing flag means that one is on. `mpt setup` gives a brand-new
  team `{ "tasks": true, "stories": false, "schedules": false }`.
- **Off means refused.** The daemon answers that kind's API routes with **403**
  `{ "success": false, "error": "feature 'stories' is disabled", "feature": "stories" }`,
  hides its WorkDefs from `GET /api/work-defs`, and refuses to accept a triage
  proposal of that kind. Work already queued or in flight still runs, completes,
  and lands in the Inbox, and every WorkDef's thread (comments, attachments) stays
  readable.
- **Turning one off needs it empty.** `PUT /api/config` refuses (409) to switch a
  kind off while it has active items — e.g. "Can't turn off stories: archive or
  delete 3 stories first". Pending stories and pending WorkDefs count; archived items
  don't. Turning a kind on is always allowed.
- `GET /api/status` and `GET /api/config` report the resolved toggles as `features`;
  `GET /api/config` also reports each kind's active items as `featureUsage`.
- **In the web UI** the toggles are **Config → General → Work items**. A kind that's
  off loses its Work sub-tab and its chip/rows on the mixed Pending and
  Archived lists (the Work nav item goes when all three are off) and quick-create entry, its pages show a "turned off" notice, and its triage proposals can only be rejected.
- **For the assistant** (the Pi leader) a kind that's off takes its tools out of
  the model's tool list — Stories: `create_story`, `edit_story`, `add_task`,
  `list_workflows`, `list_context`; Tasks: `create_task`; Schedules:
  `create_schedule`, `set_schedule_pending`; with all three off, `get_task` / `edit_task` / `activate_task`
  too — and the system prompt says what's off. The leader re-reads the toggles
  before every run and on its 10-second status poll, so a change applies without
  restarting Pi. A triage teammate's `propose_work` refuses proposals of a kind
  that's off. Anything that still reaches the daemon gets the same "… are disabled
  — enable them in Config (features.…)" message.
- **On the CLI** `mpt status` leaves out a switched-off kind's counts (see
  [CLI Reference](#cli-reference)).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAM_DIR` | `./.my-pizza-team` | Team directory, or its parent |
| `PORT` | `7437` | Daemon HTTP port |
| `HOST` | `127.0.0.1` | Bind address (anything else requires an API token) |
| `MPT_API_TOKEN` | — | Overrides `config.apiToken` |
| `MPT_NODE` | — | The Node that runs mpt; overrides `~/.config/mpt/runtime.json` (`--node <path>` overrides both) |
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

**Pending.** Any WorkDef can be created as pending (`pending: true`; **Save as
pending** in the UI; the assistant's `add_task` / `create_task` / `create_schedule`
take `pending` too). A pending WorkDef is editable and never gets a WorkItem — a
pending board task holds its place, so its story waits there.
`POST /api/work-defs/:id/activate` ends pending and locks the definition; from then
on revisions go through the thread plus a re-run. Existing WorkDefs are active, and
files with the old `draft: true` load as pending. For one release the API still
accepts the old `draft` request field and `POST …/publish` as deprecated aliases.
See [docs/DESIGN.md](docs/DESIGN.md#pending-write-review-activate).

**Pending stories.** A story is active or **pending**, and unlike a WorkDef it can go
back and forth (`pending: true` on create or `PUT /api/stories/:id`, or `POST
/api/stories/:id/pending` / `…/activate`; Work → **Pending**, the story
page's **Make pending** / **Activate**, and the assistant's `create_story` /
`edit_story` `pending`). A pending story hands out nothing new — a task already
running finishes, but no task is admitted and no READY item is offered — and stories
that `dependsOn` it wait. Activating resumes it where it was. Pending replaced the old
story `paused` flag and the `backlog/` directory: on load, `paused: true` becomes
`pending: true` and `backlog/<id>.json` moves back to `stories/` as pending
(`backloggedAt` dropped). For one release the API still accepts `paused` as an
alias of `pending`.

**Pending schedules.** A Schedule (a Scheduled job's cron parent) can also go
active ⇄ pending (`PUT /api/schedules/:id { pending }`, `POST
/api/schedules/:id/pending` / `…/activate`; **Make pending** on Work →
Schedule, **Activate** on Work → Pending, both on the job's page; the assistant's `set_schedule_pending`). A pending
Schedule never fires and is never held for readiness; reactivating resumes at its
next cron occurrence and never back-fills the runs it skipped. A job fires only when
both its Schedule and its WorkDef are active — creating a job "as pending" makes the
WorkDef pending (one-way, editable). See
[docs/DESIGN.md](docs/DESIGN.md#pending-schedules-reversible-no-catch-up).

**Run counts.** Every WorkDef view from `/api/work-defs` carries `executionCount`
(WorkItems created for it, CANCELED ones excluded) and `lastRunAt`, derived from the
WorkItem table on each read. Work → Tasks shows the count per row, sorts by it, and
filters to **Never run** (count 0) — the work you haven't started. See
[docs/DESIGN.md](docs/DESIGN.md#execution-count-derived-not-counted).

**Personas.** A markdown file named after an agent state
(`workflows/<name>/<state>.md`) is role framing injected into that state's prompt:

```markdown
You are a careful implementer. Write the code the task describes,
add tests, and keep the change minimal. Summarize what you did when
you finish — the task advances automatically.
```

Manual states need no persona. Create workflows, edit their states, and edit
personas under **Config → Workflows** (`/config/workflows`); every story names its workflow at
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

**One teammate per directory.** While a WorkItem with a directory is in flight
(`IN_PROGRESS`, or `MORIBUND` after a lost connection), no other item whose
directory is the same, a parent, or a child is handed out. It waits in the queue
("waiting — directory busy" on the Queue page). Items with no directory are exempt.
Release a stuck `MORIBUND` lease by force-failing the item. Turn this off with
`"exclusiveDirectories": false` or in Config → Teammates.

**On claim** the agent gets `workItem: { id }` and a `prompt`: the complete,
daemon-assembled message (state persona, story, working-directory instruction, the
task's goal/criteria/context, attached reference context, lead comments,
completion guidance). Harnesses deliver it verbatim.

---

## Harness Guides

### Pi (native)

The Pi extension (`harnesses/pi/` in this repo) provides the leader and teammate
integration. It ships **inside the `my-pizza-team` npm package** and `mpt setup` installs it to
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

Then opt the team in — **Config → Teammates → Experimental Harnesses** in the web UI
(applies on save, no restart), or `"experimental": { "harnesses": true }` in
`config.json` and restart the daemon — and pick the harness in the Team tab's **Spawn**
dialog. The same section sets `defaultHarness`; a non-Pi default requires the opt-in,
so `PUT /api/config` refuses that combination. Without the flag the daemon refuses to
spawn or register them.

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
| Stories | `/api/stories/*` (incl. `POST /:id/pending\|activate`), `/api/archived` | CRUD, pending ⇄ active, archive |
| Board tasks | `/api/stories/:id/tasks[/reorder]`, `/api/tasks/:id/move`, `DELETE /api/tasks/:id` | Story-parent operations |
| WorkDefs | `/api/work-defs/*` | Every unit of work: CRUD (edits only while pending), activate, enqueue, archive, comments, attachments, usage; each view carries its run count (`executionCount`, `lastRunAt`) |
| Schedules | `/api/schedules/*` | Cron parents (get/update/delete; `…/pending`, `…/activate`) |
| Templates | `/api/templates/*` | Reusable molds for Solitary tasks (never enqueue) |
| Directories | `GET /api/directories`, `POST/PUT/DELETE /api/directories/favorites` | Picker suggestions (favorites, then recent); edit favorites |
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
├── main.ts            # The npm package's `mpt` entry (→ cli/main.ts; dist/main.js once built)
├── plugin/            # `my-pizza-team/plugin`: the types and constants plugin authors import
├── daemon/            # HTTP server (Hono on @hono/node-server), Store, tmux supervisor
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
npm install            # Once (Node >=24): the daemon's npm dependencies
npm run dev            # Auto-reload daemon (the same daemon `mpt start` runs)
npm run mpt -- <cmd>   # Run the CLI from source
npm run ui:dev         # Vite dev server for the UI
```

There is no build step in development: Node runs the `.ts` sources directly
(type stripping). Only the npm package is compiled to `dist/` (see Building).

Gates — all must pass before a commit:

```bash
npm run check            # type-check daemon/, cli/, shared/, scripts/, tests/ + generated files in step
npm test                 # fast suite (seconds; node:test, Node >=24)
npm run test:e2e         # real git, tmux, and shell — run before pushing
npm run typecheck:ext    # the Pi extension
npm run test:ext         # the Pi extension's suites
(cd ui && npx tsc -b)    # the web UI
```

The root `package.json` owns the version; the extension's `package.json` and the lockfile
are generated from it (`npm run sync-version`), and its shared constants from `shared/types.ts` (`npm run sync-shared`); CI fails
if either is out of step.

## Building

```bash
npm run build                  # UI + tsc → dist/ (the npm package's JS; `npm pack` runs it via prepack)
npm pack                       # my-pizza-team-<version>.tgz; install with `npm i -g ./my-pizza-team-*.tgz`
./scripts/package-macos-menubar.sh   # macOS: the menu bar app → desktop/macos/dist/ (universal)
```

## Releasing

```bash
./scripts/publish.sh [MAJOR|MINOR|PATCH|x.y.z]   # bump the version, sync copies, commit, tag, push
```

The `v*` tag runs `.github/workflows/release.yml` on Node 24: it checks the tag
matches `package.json`, runs `npm ci`, `npm run check` and `npm test`, smoke-tests
the `npm pack` tarball (installs it into a scratch prefix and runs
`mpt setup --dry-run`), then `npm publish --provenance --access public` (skipped
if that version is already on npm, so re-running a tag only redoes the GitHub
Release). A best-effort job builds the macOS menu bar app, signs and notarizes it,
and the GitHub Release gets generated notes, the smoke-tested
`my-pizza-team-<version>.tgz`, the DMG, and `scripts/legacy-bridge.sh` under the
old binary asset names (`mpt-darwin-arm64`, … plus `checksums.sha256`), which is
what an old binary's `mpt upgrade` downloads (see "Migrating from the binary"). There are no per-platform binaries or
checksums any more; users install with `npm i -g my-pizza-team` and upgrade with
`mpt upgrade`.

npm publishing uses **Trusted Publishing** — no npm token. The package's trusted
publisher on npmjs.com (Settings → Trusted Publisher) is GitHub Actions,
`timzen/my-pizza-team`, workflow `release.yml`; the job's `id-token: write`
permission is the credential, and npm adds provenance itself.

Repository secrets:

- `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `MPT_SIGNATURE`,
  `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` — optional: Developer ID
  signing and notarization of the DMG (otherwise it is ad-hoc signed).

---

## License

MIT

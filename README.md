# pi-pizza-team 🍕

Because the industry has "two pizza teams" and "one pizza teams", but we're a **π pizza team** (3.14 pizzas, the perfect size).

A [Pi](https://pi.mariozechner.at/) extension for multi-agent task orchestration. Connects to the [my-pizza-team daemon](https://github.com/timzen/my-pizza-team) for state management and coordinates teammates via tmux.

## What It Does

- **Team Lead Pi** — connects to the daemon, polls its leader directives, manages tmux windows
- **Teammate Pis** — poll the daemon for tasks, execute autonomously, report back
- **Leader Pi** — manages tmux *and* chats with you live (web UI *or* its own terminal — same conversation)
- **You (the Mentor)** — review work via the daemon's web UI, or hop into any teammate's window to pair

## Install

```bash
pi install /path/to/pi-pizza-team
# or from git:
pi install git:github.com/timzen/pi-pizza-team
```

## Prerequisites

The [my-pizza-team daemon](https://github.com/timzen/my-pizza-team) must be running:

```bash
# Start the daemon (default: http://localhost:7437)
cd /path/to/my-pizza-team && deno task start
```

## Quick Start

```bash
# Leader mode (auto-detects if .my-pizza-team/ exists in cwd):
pi

# Or explicit leader mode with custom daemon URL:
pi --ppt-lead --ppt-daemon=http://localhost:7438

# Spawn a teammate (usually done by the leader via /ppt-spawn):
pi --ppt-worker --ppt-daemon=http://localhost:7437 --ppt-name=swift-ripley

# The leader IS the chat agent — nothing extra to run.
```

## Role Detection

The extension detects which role to activate:

1. `--ppt-worker` flag → **Teammate** (autonomous agent)
2. *(retired)* `--ppt-assistant` — the leader is the chat agent now; the flag only prints a notice
3. `--ppt-lead` flag OR `.my-pizza-team/config.json` in cwd → **Leader**
4. Otherwise → **Inactive** (only `/ppt-help` available)

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--ppt-lead` | boolean | false | Activate leader role |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | **Retired** — the leader answers the chat; kept so old spawn commands don't crash |
| `--ppt-daemon` | string | `http://localhost:7437` | Daemon URL |
| `--ppt-name` | string | (auto-generated) | Agent name |
| `--ppt-tmux-session` | string | (set by leader) | tmux session the agent runs in (reported as metadata) |
| `--ppt-tmux-window` | string | (set by leader) | tmux window the agent runs in (reported as metadata) |
| `--ppt-readiness-probe` | string | (none) | **Leader only.** Host readiness probe command (highest-priority override); exit 0 = ready, non-zero = not ready (stdout's first line is the reason). Also settable via the `PPT_READINESS_PROBE` env var or — the recommended way — via the daemon's **Config page** (`readinessProbe` in config.json, with optional per-host override at `hosts[hostId].readinessProbe`). A not-ready host makes the daemon **hold** scheduled work destined for it instead of failing it (e.g. while `mwinit` credentials are expired), firing it once on recovery. No probe = always ready. |

### Work selection: directory affinity

Teammates are **generalists** — there is no capability/skill or work-mode
configuration. A teammate registers its working directory (its pi cwd), and the
daemon biases work by directory: a teammate preferentially picks up WorkItems
whose story/WorkDef names its directory, falls back to un-homed work, and only
takes another directory's work when no online teammate is homed there (see the
daemon's `docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md`). If a teammate ends up on
work whose directory it can't reach, it just fails that item.

```bash
# A generalist teammate homed at the current repo
pi --ppt-worker
```

**Daemon URL resolution (priority order):**
1. `--ppt-daemon` flag
2. `.my-pizza-team/config.json` → `port` or `daemonUrl` field
3. Default: `http://localhost:7437`

## Commands

### Leader

| Command | Description |
|---------|-------------|
| `/ppt-help` | Shows setup instructions (install mpt, run `mpt start`) |
| `/ppt-spawn [name] [cwd]` | Spawn a teammate in a tmux window |
| `/ppt-dismiss <name>` | Stop a teammate |
| `/ppt-hop <name>` | Jump to teammate's tmux window |
| `/ppt-status` | Quick status summary from daemon |
| `/ppt-browse` | Show recently used directories for spawning |

### Teammate

| Command | Description |
|---------|-------------|
| `/ppt-worker-resume` | Resume autonomous work after pairing |
| `/ppt-worker-status` | Show current teammate status |

### Chat (leader)

| Command | Description |
|---------|-------------|
| `/ppt-chat-new-session` | Start a fresh chat session (queued by the chat's **New chat** / persona swap) |
| `/ppt-chat-resume <file>` | Switch to an earlier chat's Pi session (queued by **Resume**) |

Both are normally driven by the web UI rather than typed: Pi's session APIs exist
only on command contexts, so the daemon's `new-session`/`resume-session` directives
are realized by queueing these.

## LLM Tools

Tools are registered per-role (all proxy to the daemon API):

### Leader Tools
- **`create_story`** — Create a new story (id, title, description, directory?, skills?, paused?, workflow?, dependsOn?)
- **`edit_story`** — Edit an existing story's fields
- **`add_task`** — Add a task to a story
- **`team_status`** — Get current team status summary

### Teammate Tools
- **`upload_attachment`** — Upload a file to the current work item
- **`fail`** — Give up on the current work item: posts a comment and marks the WorkItem `FAILED`, leaving the task stuck for a human to re-enqueue/move/edit

### Leader Tools (the agent you chat with)

> The leader has **no tool for replying**. It answers in ordinary prose and the
> extension mirrors it into chat bubbles (splitting on blank lines), so the same
> reply reads naturally in the tmux pane *and* in the web chat. See
> [Chat mirror](#chat-mirror). There is also no `queue_request`: the leader *is*
> the chat, so it would be messaging itself.

- **`create_story`** — Create stories from prompts
- **`edit_story`** — Edit stories
- **`add_task`** — Add tasks to stories
- **`create_task`** — Create a standalone one-off task (Solitary WorkDef); enqueued, lands in the Inbox when done
- **`create_schedule`** — Create a recurring scheduled job (Scheduled WorkDef on a cron)
- **`queue_request`** — Delegate sub-requests
- **`list_thought_groups`** / **`list_thoughts`** / **`get_thought`** — Read the user's Thoughts board (markdown sticky notes), optionally by group, so the assistant can turn captured ideas into work; read-only
- **`create_thought`** / **`edit_thought`** / **`archive_thought`** / **`group_thoughts`** — Write to the board: capture a follow-up/summary note, annotate or append to a note, archive a note it has acted on, or organize notes into a group (closes the thoughts → tasks → inbox → new-thoughts loop)

> The context library is **vended by the daemon** where needed (e.g. the assistant's
> persona system prompt) — agents don't search or CRUD context through tools.

## Chat Mirror

The **leader** is the agent you chat with — there is no separate assistant process
(it already runs per host, and nobody types in its session). The Pi session is the
conversation; the daemon chat is a mirror of it, kept in sync both ways:

| Direction | What happens |
|-----------|--------------|
| daemon → Pi | Queued user messages are pulled from `/api/assistant/inbox` and handed to Pi with `sendUserMessage(…, { deliverAs: "steer" })` while a run is live, so you can interrupt mid-answer. Receipts advance `queued` → `delivered` → `read`. |
| Pi → daemon | The agent's own prose is split on blank lines into chat bubbles (`src/bubbles.ts` — never inside a code fence or list). Reasoning deltas feed an ephemeral "peek behind the `…`" buffer. |
| terminal → chat | Anything you type in the assistant's tmux pane (the `input` event, slash commands excluded) is mirrored into the web chat, so both surfaces show one conversation. |
| sessions | `new-session` / `resume-session` are realized in-process with `ctx.newSession()` / `ctx.switchSession()`, and the resulting Pi session path is reported so a chat can be snapshotted and resumed later. |
| designation | Leaders are per host, so the daemon designates one chat agent; the inbox poll answers `chat: true/false` and a non-designated leader stays silent. |

There is deliberately no polling of "turns", no composer lock, no `send_message`
tool, and nothing to spawn. See
[my-pizza-team/docs/ASSISTANT_CHAT_V2.md](../my-pizza-team/docs/ASSISTANT_CHAT_V2.md).


## Multi-Harness Spawning

The leader supports spawning agents with different harness types:

| Harness | Command Template |
|---------|-----------------|
| `pi` (default) | `pi --ppt-worker --ppt-daemon={url} --ppt-name={name}` |
| `claude-code` | `mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}` |
| `codex` | `mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}` |

Custom templates can be configured via the daemon's `harnessCommands` config field.

Every spawn is a **teammate**: the chat is answered by the leader itself, so there is no assistant to spawn (and no `pi-assistant` template). Identity stays daemon-owned — the daemon generates the name and `{name}` is threaded from the directive, which keeps the tmux window, the registered agent name, and the MPT web UI label consistent.

## Workflow

Teammates work the daemon's **WorkItem queue** — the unit of agent execution.
Workers never move tasks; the daemon reacts to a terminal WorkItem state (see the
daemon's `docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md`):

1. **Poll** — `next-work` returns a `READY` WorkItem (chosen by directory affinity)
2. **Claim** — leases it (→ `IN_PROGRESS`); gets the daemon-assembled prompt
3. **Execute** — works it (cd-ing to the ref's directory)
4. **Set state** — `COMPLETE` (the daemon advances the task) or, if blocked, a
   comment + `FAILED` via the `fail` tool (the task is left stuck for a human)

The teammate never hardcodes state names — the prompt tells it what to do. A
WorkItem only moves toward a terminal state; a reaped one becomes `MORIBUND` and
is restored if the teammate reconnects.

## Architecture

This extension is a **thin daemon client** (v0.2.0). It owns no state:

```
src/
├── index.ts          Entry point: flag registration, role detection, wiring
├── client.ts         DaemonClient: unified HTTP client for daemon API
├── leader.ts         Leader: tmux management, spawn polling, slash commands
├── teammate.ts       TeammateLoop: autonomous work loop (fresh session per work item)
├── chat.ts           ChatMirror: mirrors the daemon chat ⇄ the leader's Pi session
├── bubbles.ts        splitIntoBubbles: assistant prose → chat bubbles
├── tools.ts          LLM tool registration (role-specific)
├── permissions.ts    Dynamic yoloMode toggling
└── shared/
    └── types.ts      Minimal types (WorkflowConfig, constants)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed data flow and API routes.

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

**Teammates:**

- **Autonomous mode** — `yoloMode: true`, no permission prompts; a registered `ppt-autonomous` authorizer chain link also auto-approves fail-closed asks that yolo can't (e.g. the bash indirection-wrapper floor on `timeout`/`nohup`/`sudo` commands)
- **Pairing mode** — `yoloMode: false`, normal permission rules apply (the link defers to you)

The toggle is automatic: when you type in a teammate's window, it switches to pairing mode. Run `/ppt-worker-resume` to return to autonomous.

**The leader (chat agent):** a message sent from the web UI has nobody at the
terminal, so a permission prompt doesn't just slow things down — it hangs the chat
with no visible cause (the UI shows `…` forever). The leader therefore turns on
`yoloMode` while the current run was driven remotely, and reverts to your normal
rules when *you* type in its pane. Since nobody normally types at the leader, that
is "yolo whenever it matters" — but the web UI can never silently disarm prompts on
a session you're sitting in.

Unlike a spawned teammate, the leader runs in your real project, so it does **not**
author a permission map there: it only flips `yoloMode`, ensures the chain link is
named, and restores the config file exactly as it found it on shutdown (otherwise a
plain `pi` in that directory later would silently be in yolo mode).

## Upgrading from v0.1.0

v0.2.0 is a full rewrite. The extension no longer includes:
- HTTP server (moved to daemon)
- SQLite store (moved to daemon)
- Web UI (moved to daemon)
- BM25 search (moved to daemon)
- Git sync (moved to daemon)

**Migration:** Install and start the [my-pizza-team daemon](https://github.com/timzen/my-pizza-team), then update your Pi extension.

## License

MIT

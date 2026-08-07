# pi-pizza-team 🍕

Because the industry has "two pizza teams" and "one pizza teams", but we're a **π pizza team** (3.14 pizzas, the perfect size).

A [Pi](https://pi.mariozechner.at/) extension for multi-agent task orchestration. Connects to the [my-pizza-team daemon](https://github.com/timzen/my-pizza-team) for state management and coordinates teammates via tmux.

## What It Does

- **Team Lead Pi** — connects to the daemon, polls its leader directives, manages tmux windows
- **Teammate Pis** — poll the daemon for tasks, execute autonomously, report back
- **Assistant Pi** — answers messages in the assistant conversation
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

# Run the assistant:
pi --ppt-assistant --ppt-daemon=http://localhost:7437
```

## Role Detection

The extension detects which role to activate:

1. `--ppt-worker` flag → **Teammate** (autonomous agent)
2. `--ppt-assistant` flag → **Assistant** (conversation responder)
3. `--ppt-lead` flag OR `.my-pizza-team/config.json` in cwd → **Leader**
4. Otherwise → **Inactive** (only `/ppt-help` available)

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--ppt-lead` | boolean | false | Activate leader role |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | Run as assistant |
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

## LLM Tools

Tools are registered per-role (all proxy to the daemon API):

### Leader Tools
- **`create_story`** — Create a new story (id, title, description, directory?, skills?, paused?, workflow?, dependsOn?)
- **`edit_story`** — Edit an existing story's fields
- **`add_task`** — Add a task to a story
- **`queue_request`** — Queue a request for the assistant
- **`team_status`** — Get current team status summary

### Teammate Tools
- **`upload_attachment`** — Upload a file to the current work item
- **`fail`** — Give up on the current work item: posts a comment and marks the WorkItem `FAILED`, leaving the task stuck for a human to re-enqueue/move/edit

### Assistant Tools
- **`send_message`** — Send one chat bubble to the user; called once per bubble to deliver a batched, iMessage-style reply (the only thing the user sees)
- **`create_story`** — Create stories from prompts
- **`edit_story`** — Edit stories
- **`add_task`** — Add tasks to stories
- **`create_task`** — Create a standalone one-off task (Solitary WorkDef); enqueued, lands in the Inbox when done
- **`create_schedule`** — Create a recurring scheduled job (Scheduled WorkDef on a cron)
- **`queue_request`** — Delegate sub-requests
- **`list_thought_groups`** / **`list_thoughts`** / **`get_thought`** — Read the user's Thoughts board (markdown sticky notes), optionally by group, so the assistant can turn captured ideas into work; read-only

> The context library is **vended by the daemon** where needed (e.g. the assistant's
> persona system prompt) — agents don't search or CRUD context through tools.

## Multi-Harness Spawning

The leader supports spawning agents with different harness types:

| Harness | Command Template |
|---------|-----------------|
| `pi` (default) | `pi --ppt-worker --ppt-daemon={url} --ppt-name={name}` |
| `pi-assistant` | `pi --ppt-assistant --ppt-daemon={url} --ppt-name={name}` |
| `claude-code` | `mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}` |
| `codex` | `mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}` |

Custom templates can be configured via the daemon's `harnessCommands` config field.

The `pi-assistant` template selects the assistant **role** (`--ppt-assistant`) but does *not* choose a name: identity is daemon-owned, so `{name}` is threaded from the directive just like a worker. The daemon assigns the reserved singleton name `assistant` for assistant spawns, which keeps the tmux window, the registered agent name, and the MPT web UI label all consistent.

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
├── assistant.ts      AssistantLoop: works chat response turns (streams bubbles via send_message)
├── tools.ts          LLM tool registration (role-specific)
├── permissions.ts    Dynamic yoloMode toggling
└── shared/
    └── types.ts      Minimal types (WorkflowConfig, constants)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed data flow and API routes.

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

- **Autonomous mode** — `yoloMode: true`, no permission prompts; a registered `ppt-autonomous` authorizer chain link also auto-approves fail-closed asks that yolo can't (e.g. the bash indirection-wrapper floor on `timeout`/`nohup`/`sudo` commands)
- **Pairing mode** — `yoloMode: false`, normal permission rules apply (the link defers to you)

The toggle is automatic: when you type in a teammate's window, it switches to pairing mode. Run `/ppt-worker-resume` to return to autonomous.

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

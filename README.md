# pi-pizza-team 🍕

Because the industry has "two pizza teams" and "one pizza teams", but we're a **π pizza team** (3.14 pizzas, the perfect size).

A [Pi](https://pi.mariozechner.at/) extension for multi-agent task orchestration. Connects to the [my-pizza-team daemon](https://github.com/timzen/my-pizza-team) for state management and coordinates teammates via tmux.

## What It Does

- **Team Lead Pi** — connects to the daemon, polls for spawn requests, manages tmux windows
- **Teammate Pis** — poll the daemon for tasks, execute autonomously, report back
- **Assistant Pi** — processes free-form requests from the assistant queue
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
# Leader mode (auto-detects if .pi-pizza-team/ exists in cwd):
pi

# Or explicit leader mode with custom daemon URL:
pi --ppt-lead=http://localhost:7437

# Spawn a teammate (usually done by the leader via /ppt-spawn):
pi --ppt-worker --ppt-daemon=http://localhost:7437 --ppt-name=swift-ripley

# Run the assistant:
pi --ppt-assistant --ppt-daemon=http://localhost:7437
```

## Role Detection

The extension detects which role to activate:

1. `--ppt-worker` flag → **Teammate** (autonomous agent)
2. `--ppt-assistant` flag → **Assistant** (queue processor)
3. `--ppt-lead` flag OR `.pi-pizza-team/config.json` in cwd → **Leader**
4. Otherwise → **Inactive** (only `/ppt-init` available)

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--ppt-daemon` | string | `http://localhost:7437` | Daemon URL |
| `--ppt-lead` | string | (empty) | Activate leader role (value = daemon URL for backwards compat) |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | Run as assistant |
| `--ppt-name` | string | (auto-generated) | Agent name |

**Daemon URL resolution (priority order):**
1. `--ppt-daemon` flag
2. `--ppt-lead` flag (if it's a URL)
3. `.pi-pizza-team/config.json` → `daemonUrl` field
4. Default: `http://localhost:7437`

## Commands

### Leader

| Command | Description |
|---------|-------------|
| `/ppt-init` | Initialize `.pi-pizza-team/` in current directory |
| `/ppt-spawn [name] [cwd]` | Spawn a teammate in a tmux window |
| `/ppt-dismiss <name>` | Stop a teammate |
| `/ppt-hop <name>` | Jump to teammate's tmux window |
| `/ppt-status` | Quick status summary from daemon |
| `/ppt-browse` | Show favorite directories for spawning |

### Teammate

| Command | Description |
|---------|-------------|
| `/ppt-worker-resume` | Resume autonomous work after pairing |
| `/ppt-worker-status` | Show current teammate status |

## LLM Tools

Tools are registered per-role (all proxy to the daemon API):

### Leader Tools
- **`create_story`** — Create a new story (id, title, description, dir?, workflow?, dependsOn?)
- **`edit_story`** — Edit an existing story's fields
- **`add_task`** — Add a task to a story
- **`queue_request`** — Queue a request for the assistant
- **`save_memory`** — Save a note to the knowledge base
- **`search_memory`** — Search memories by keyword
- **`team_status`** — Get current team status summary

### Teammate Tools
- **`search_memory`** — Search memories for context
- **`upload_attachment`** — Upload a file to the current task

### Assistant Tools
- **`create_story`** — Create stories from prompts
- **`edit_story`** — Edit stories
- **`add_task`** — Add tasks to stories
- **`save_memory`** — Persist research and decisions
- **`search_memory`** — Find existing knowledge
- **`queue_request`** — Delegate sub-requests

## Multi-Harness Spawning

The leader supports spawning agents with different harness types:

| Harness | Command Template |
|---------|-----------------|
| `pi` (default) | `pi --ppt-worker --ppt-daemon={url} --ppt-name={name}` |
| `claude-code` | `mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}` |
| `codex` | `mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}` |

Custom templates can be configured via the daemon's `harnessCommands` config field.

## Workflow

Tasks follow configurable workflows managed by the daemon. The teammate uses the daemon's **multi-transition ownership** model:

1. **Poll** — finds unclaimed task with teammate-allowed transitions
2. **Claim** — takes ownership (no state change)
3. **Transition** — advances to first working state
4. **Execute** — works on the task
5. **Transition** — advances through consecutive teammate states
6. **Release** — when only lead-only transitions remain

The teammate never hardcodes state names — it's purely driven by `availableTransitions` from the daemon.

## Architecture

This extension is a **thin daemon client** (v0.2.0). It owns no state:

```
src/
├── index.ts          Entry point: flag registration, role detection, wiring
├── client.ts         DaemonClient: unified HTTP client for daemon API
├── leader.ts         Leader: tmux management, spawn polling, slash commands
├── teammate.ts       TeammateLoop: multi-transition autonomous work loop
├── assistant.ts      AssistantLoop: queue processing loop
├── tools.ts          LLM tool registration (role-specific)
├── permissions.ts    Dynamic yoloMode toggling
└── shared/
    └── types.ts      Minimal types (WorkflowConfig, constants)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed data flow and API routes.

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

- **Autonomous mode** — `yoloMode: true`, no permission prompts
- **Pairing mode** — `yoloMode: false`, normal permission rules apply

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

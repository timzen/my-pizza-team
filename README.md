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

The [my-pizza-team daemon](https://github.com/timzen/my-pizza-team) must be running (default: `http://localhost:7437`).

## Quick Start

```bash
# Start the daemon first (see my-pizza-team docs)

# Run as team lead:
pi --ppt-lead

# Or spawn a teammate:
pi --ppt-worker --ppt-name=swift-ripley

# Or run the assistant:
pi --ppt-assistant
```

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--ppt-lead` | boolean | false | Run as team leader |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | Run as assistant |
| `--ppt-daemon` | string | `http://localhost:7437` | Daemon URL |
| `--ppt-name` | string | (auto) | Agent name |

## Commands (Team Lead)

| Command | Description |
|---------|-------------|
| `/ppt-spawn [name] [cwd]` | Spawn a teammate in a tmux window |
| `/ppt-dismiss <name>` | Stop a teammate |
| `/ppt-hop <name>` | Jump to teammate's tmux window |
| `/ppt-status` | Quick status summary from daemon |

## Commands (Teammate)

| Command | Description |
|---------|-------------|
| `/ppt-worker-resume` | Resume autonomous work after pairing |
| `/ppt-worker-status` | Show current teammate status |

## LLM Tools

The extension registers LLM tools (all communicate with the daemon):

- **`team_add_story`** — Create a new story with id, title, description, optional dir and dependencies
- **`team_edit_story`** — Edit any field of an existing story
- **`team_add_task`** — Add a task to an existing story
- **`team_queue_request`** — Queue a free-form request for the assistant
- **`search_memory`** — Search the team's knowledge base by keyword
- **`save_memory`** — Save a memory note (assistant only)
- **`upload_attachment`** — Upload a file to the current task (teammate only)

## Workflow

Tasks follow configurable workflows managed by the daemon. The teammate is workflow-agnostic — it uses the daemon's agent protocol to claim tasks and transition states without hardcoding state names.

**Transition permissions:** `"any"` (anyone), `"teammate"` (only the assigned agent), `"lead"` (only you via the web UI or daemon API).

## Architecture

This extension is a **thin daemon client**. It owns no state:

```
src/
├── index.ts          # Entry point: flag registration, role detection
├── client.ts         # DaemonClient: unified HTTP client for daemon API
├── leader.ts         # Leader: tmux management, spawn polling, slash commands
├── teammate.ts       # TeammateLoop: autonomous work loop
├── assistant.ts      # AssistantLoop: queue processing loop
├── tools.ts          # LLM tool registration (all roles)
├── permissions.ts    # Dynamic yoloMode toggling
└── shared/
    └── types.ts      # Minimal types (WorkflowConfig, constants)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed data flow and API routes.

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

- **Autonomous mode** — `yoloMode: true`, no permission prompts (teammate works freely)
- **Pairing mode** — `yoloMode: false`, normal permission rules apply

The toggle is automatic: when you type in a teammate's window, it switches to pairing mode. Run `/ppt-worker-resume` to return to autonomous.

## License

MIT

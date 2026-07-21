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
| `--ppt-work-mode` | string | `eager-helper` | Teammate work selection: `eager-helper` or `assigned-story` |
| `--ppt-story` | string | (none) | Story ID to bind to (required for `--ppt-work-mode assigned-story`) |
| `--ppt-skills` | string | (none) | Comma-separated capabilities: `name` presence-only, `name:value` value-bound (e.g. `python,java:8`) |
| `--ppt-tmux-session` | string | (set by leader) | tmux session the agent runs in (reported as metadata) |
| `--ppt-tmux-window` | string | (set by leader) | tmux window the agent runs in (reported as metadata) |

### Work modes & capabilities

A teammate registers a **capability map** with the daemon from its
`--ppt-skills` entries: `name` is presence-only, `name:value` binds a value
(e.g. `java:8` satisfies a story requiring `java: 8` exactly, or `java` at any
value). The daemon only hands a teammate a story whose **requirements** it
satisfies (see my-pizza-team `docs/DESIGN.md` → *Capability-Based Work
Matching*). The working directory is not a capability — teammates cd to each
story's directory.

- `eager-helper` (default): picks up any story it's capable of.
- `assigned-story` (with `--ppt-story <id>`): works only that story; when its
  tasks are exhausted the daemon archives it and the teammate dismisses itself.

```bash
# Eager helper that can do design + python work, and advertises java 8
pi --ppt-worker --ppt-skills=design,python,java:8

# Dedicated agent for one story, exits when the story is finished
pi --ppt-worker --ppt-work-mode=assigned-story --ppt-story=add-user-auth
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
- **`upload_attachment`** — Upload a file to the current task
- **`return_task`** — Give the claimed task back to the queue with a comment when the agent can't proceed (back to `ready`; a human resolves the blocker)

### Assistant Tools
- **`send_message`** — Send one chat bubble to the user; called once per bubble to deliver a batched, iMessage-style reply (the only thing the user sees)
- **`create_story`** — Create stories from prompts
- **`edit_story`** — Edit stories
- **`add_task`** — Add tasks to stories
- **`queue_request`** — Delegate sub-requests
- **`read_scratchpad`** — Read the user's scratch pad (todos + notes) on request; read-only

> The context library is **vended by the daemon** where needed (e.g. the assistant's
> persona system prompt) — agents don't search or CRUD context through tools.

## Multi-Harness Spawning

The leader supports spawning agents with different harness types:

| Harness | Command Template |
|---------|-----------------|
| `pi` (default) | `pi --ppt-worker --ppt-daemon={url} --ppt-name={name}` |
| `claude-code` | `mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}` |
| `codex` | `mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}` |

Custom templates can be configured via the daemon's `harnessCommands` config field.

## Workflow

Tasks follow the daemon's work model (its docs/WORK-MODEL.md): an ordered
pipeline of states where **workers never move tasks**:

1. **Poll** — finds a task sitting `ready` in an agent state
2. **Claim** — leases it (substatus → `claimed`); gets the state-persona prompt
3. **Execute** — works the task (cd-ing to the story's directory)
4. **Done** — signals completion; the daemon advances the task mechanically
5. **Return** (escape hatch) — if blocked, `return_task` puts it back to `ready` with a comment

The teammate never hardcodes state names — the state persona in the prompt tells
it what role it plays (implementer, CR-writer, …).

## Architecture

This extension is a **thin daemon client** (v0.2.0). It owns no state:

```
src/
├── index.ts          Entry point: flag registration, role detection, wiring
├── client.ts         DaemonClient: unified HTTP client for daemon API
├── leader.ts         Leader: tmux management, spawn polling, slash commands
├── teammate.ts       TeammateLoop: multi-transition autonomous work loop
├── assistant.ts      AssistantLoop: works chat response turns (streams bubbles via send_message)
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

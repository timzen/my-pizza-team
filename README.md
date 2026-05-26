# pi-pizza-team 🍕

Because the industry has "two pizza teams" and "one pizza teams", but we're a **π pizza team** (3.14 pizzas, the perfect size).

A [Pi](https://pi.mariozechner.at/) extension for multi-agent task orchestration via tmux and a kanban-style task board backed by git.

## What It Does

- **Team Lead Pi** — runs in a git repo with `.pi-pizza-team/`, starts an HTTP API, manages the kanban board
- **Teammate Pis** — run in tmux windows, poll for tasks, execute autonomously, report back
- **You (the Mentor)** — review work, reply to questions async, or hop into any teammate's window to pair

## Install

```bash
pi install /path/to/pi-pizza-team
# or from git:
pi install git:github.com/timzen/pi-pizza-team
```

## Quick Start

```bash
# In your project repo:
pi
> /team-init
> /team-add-story my-feature
> # Now discuss the breakdown with Pi, or add tasks manually:
> /team-add-task my-feature
> # Or just ask Pi to break it down from a design doc!
> /team-spawn alice ~/projects/my-app
> /team-board
```

## Commands (Team Lead)

| Command | Description |
|---------|-------------|
| `/team-init` | Initialize kanban board |
| `/team-board` | Show board status |
| `/team-spawn <name> [cwd]` | Hire a teammate |
| `/team-add-story [id]` | Create a story (tasks added separately) |
| `/team-add-task <story-id>` | Add a task to a story interactively |
| `/team-move <task-id> [status]` | Move a task to a new status (with autocomplete) |
| `/team-inbox` | Messages needing your input |
| `/team-reply <task-id> <msg>` | Reply to a teammate |
| `/team-hop <name>` | Jump to teammate's tmux window |
| `/team-dismiss <name>` | Stop a teammate |
| `/team-pause` / `/team-resume` | Pause/resume task distribution |
| `/team-save` | Flush state to JSON files |
| `/team-commit [msg]` | Flush + git commit |

## Commands (Teammate)

| Command | Description |
|---------|-------------|
| `/team-worker-resume` | Resume autonomous work after pairing |

## LLM Tool

The extension registers a `team_add_task` tool that the LLM can call. This means you can:
- Paste a design doc and say "break this into tasks for story X"
- Discuss implementation with Pi and have it add tasks as you go
- Let Pi read existing code and propose a task breakdown

## Web UI

When the team lead is running, visit:
- **`http://localhost:7437/`** — landing page with status
- **`http://localhost:7437/board`** — kanban board with swimlanes per story (auto-refreshes)

## Workflow

Tasks follow a configurable workflow with permission-gated transitions:

```json
{
  "workflow": {
    "states": ["todo", "in_progress", "needs_input", "review", "done"],
    "transitions": {
      "todo":         { "in_progress": "any" },
      "in_progress":  { "needs_input": "teammate", "review": "teammate" },
      "needs_input":  { "in_progress": "lead" },
      "review":       { "done": "lead", "in_progress": "lead" }
    }
  }
}
```

**Transition permissions:** `"any"` (anyone), `"teammate"` (only the assigned agent), `"lead"` (only you).

## Directory Structure

```
.pi-pizza-team/
├── config.json                   # Workflow, port, tmux session name
├── state.db                      # SQLite runtime (gitignored)
└── stories/
    └── my-story/
        ├── story.json            # Story metadata + dependencies
        └── tasks/
            └── 01-first-task/
                ├── task.json     # Task definition + status + result
                └── messages.jsonl # Decision log (append-only)
```

## Autosave

- **Messages** — written to `messages.jsonl` immediately (never lost)
- **Task status** — flushed from SQLite to JSON files every 30 minutes + on shutdown
- **Git commits** — automatic daily checkpoint (configurable, never pushes)
- **Manual:** `/team-save` (flush) and `/team-commit` (flush + commit)

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

- **Autonomous mode** — `yoloMode: true`, no permission prompts (teammate works freely)
- **Pairing mode** — `yoloMode: false`, normal permission rules apply (you're protected when mentoring)

The toggle is automatic: when you type in a teammate's window, it switches to pairing mode. Run `/team-worker-resume` to return to autonomous.

## License

MIT

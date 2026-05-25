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
# or publish to npm and:
# pi install npm:pi-pizza-team
```

## Quick Start

```bash
# In your project repo:
pi
> /team-init
> /team-add-story
> /team-spawn alice ~/projects/my-app
> /team-board
```

## Commands (Team Lead)

| Command | Description |
|---------|-------------|
| `/team-init` | Initialize kanban board |
| `/team-board` | Show board status |
| `/team-spawn <name> [cwd]` | Hire a teammate |
| `/team-add-story` | Create a story interactively |
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

## Directory Structure

```
.pi-pizza-team/
├── config.json                   # Workflow, port, tmux session name
├── state.db                      # SQLite runtime (gitignored)
└── stories/
    └── my-story/
        ├── story.json            # Story metadata
        └── tasks/
            └── 01-first-task/
                ├── task.json     # Task definition + status
                └── messages.jsonl # Decision log (append-only)
```

## Permission System Integration

When a teammate is autonomously executing a task, `@gotgenes/pi-permission-system` prompts are bypassed. When you hop in to pair, permissions work normally.

## License

MIT

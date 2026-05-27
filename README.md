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
> /ppt-init
> /ppt-add-story my-feature
> # Now discuss the breakdown with Pi, or add tasks manually:
> /ppt-add-task my-feature
> # Or just ask Pi to break it down from a design doc!
> /ppt-spawn                     # prompts for directory, auto-names
> /ppt-spawn ~/projects/my-app   # spawns teammate in specific dir
> /ppt-board
```

## Commands (Team Lead)

| Command | Description |
|---------|-------------|
| `/ppt-init` | Initialize kanban board |
| `/ppt-board` | Show board status |
| `/ppt-spawn [cwd]` | Spawn a teammate (auto-generates name, selects from story dirs/favorites) |
| `/ppt-add-story [id]` | Create a story (prompts for title, description, dir, dependencies) |
| `/ppt-add-task <story-id>` | Add a task to a story interactively |
| `/ppt-delete-story <story-id>` | Permanently delete a story and all its tasks |
| `/ppt-move <task-id> [status]` | Move a task to a new status (autocomplete excludes done tasks) |
| `/ppt-inbox` | Messages needing your input |
| `/ppt-reply <task-id> <msg>` | Reply to a teammate |
| `/ppt-hop <name>` | Jump to teammate's tmux window |
| `/ppt-dismiss <name>` | Stop a teammate |
| `/ppt-pause` / `/ppt-resume` | Pause/resume task distribution |
| `/ppt-save` | Flush state to JSON files |
| `/ppt-commit [msg]` | Flush + git commit |

## Commands (Teammate)

| Command | Description |
|---------|-------------|
| `/ppt-worker-resume` | Resume autonomous work after pairing |

## LLM Tools

The extension registers two LLM tools:

- **`team_add_story`** — Create a new story with id, title, description, optional dir and dependencies
- **`team_add_task`** — Add a task to an existing story

This means you can:
- Paste a design doc and say "break this into tasks for story X"
- Discuss implementation with Pi and have it add stories + tasks as you go
- Let Pi read existing code and propose a task breakdown

## Web UI

When the team lead is running, visit:
- **`http://localhost:7437/`** — landing page with status
- **`http://localhost:7437/board`** — kanban board with swimlanes per story (auto-refreshes every 3s)

The board includes:
- **Search** — filter stories by title/description (real-time)
- **Filters** — All, Open, Done, Ready (dependencies met), Blocked
- **Sort** — Default, Name A-Z/Z-A, Progress, Most/Fewest tasks
- **Task management** — click to view details, edit ✏️, delete 🗑️, move status
- **Add tasks** — "+Task" button on each story
- **Add stories** — modal with title, description, dependencies, working directory, and inline tasks
- **Persistent controls** — filter/sort/search saved in localStorage

## Workflow

Tasks follow configurable workflows with permission-gated transitions. You can define multiple named workflows and assign them per-story:

```json
{
  "defaultWorkflow": "default",
  "workflows": {
    "default": {
      "states": ["todo", "in_progress", "needs_input", "review", "done"],
      "transitions": {
        "todo":         { "in_progress": "any" },
        "in_progress":  { "needs_input": "teammate", "review": "teammate" },
        "needs_input":  { "in_progress": "lead" },
        "review":       { "done": "lead", "in_progress": "lead" }
      }
    },
    "simple": {
      "states": ["todo", "in_progress", "done"],
      "transitions": {
        "todo":         { "in_progress": "any" },
        "in_progress":  { "done": "any" }
      }
    }
  }
}
```

**Transition permissions:** `"any"` (anyone), `"teammate"` (only the assigned agent), `"lead"` (only you).

To assign a non-default workflow to a story, add `"workflow": "simple"` in `story.json` or select it when creating a story via the board or `/ppt-add-story`.

## Directory Structure

```
.pi-pizza-team/
├── config.json                   # Workflow, port, tmux session name
├── state.db                      # SQLite runtime (gitignored)
├── on-enter-<status>.md          # Optional: instructions when entering a status
├── on-exit-<status>.md           # Optional: instructions when leaving a status
├── stories/
│   └── my-story/
│       ├── story.json            # Story metadata + dependencies + optional dir/workflow
│       └── tasks/
│           └── 01-first-task/
│               ├── task.json     # Task definition + status + result
│               └── messages.jsonl # Decision log (append-only)
└── archived/
    └── completed-story/
        ├── story.json            # Includes archivedAt timestamp
        ├── SYNOPSIS.md           # Auto-generated summary of completed work
        └── tasks/
            └── 01-first-task/
                ├── task.json
                └── messages.jsonl
```

### story.json

```json
{
  "id": "my-story",
  "title": "My Story",
  "description": "What this story delivers",
  "status": "open",
  "dependsOn": ["other-story"],
  "dir": "~/Workspace/my-project"
}
```

The `dir` field is optional — when present, it determines which teammates can pick up tasks from the story. A teammate only receives tasks from stories whose `dir` matches their own working directory. Stories with no `dir` are available to any teammate. Resolved at spawn time (supports `~`).

## Transition Instructions

You can add optional markdown files to `.pi-pizza-team/` that provide instructions when tasks enter or leave a workflow status:

- `on-enter-<status>.md` — injected when a task enters this status
- `on-exit-<status>.md` — injected when a task leaves this status

Example: `.pi-pizza-team/on-enter-in_progress.md`

```markdown
# Instructions for starting work

Before beginning this task:
1. Read the relevant source files mentioned in the description
2. Check for any existing tests related to this area
3. Create a branch named after the task slug
```

These instructions are returned in API responses and prepended to the teammate's prompt automatically. If no files exist, behavior is unchanged.

## Autosave

- **Messages** — written to `messages.jsonl` immediately (never lost)
- **Task status** — flushed from SQLite to JSON files every 30 minutes + on shutdown
- **Git commits** — automatic daily checkpoint (configurable, never pushes)
- **Manual:** `/ppt-save` (flush) and `/ppt-commit` (flush + commit)

## Archiving

When all tasks in a story are complete, it can be archived:

- **From the board:** click the 📦 Archive button on a completed story
- **Via API:** `POST /api/stories/:id/archive`

Archiving moves the story directory from `stories/` to `archived/`, generates a `SYNOPSIS.md` with a structured summary, adds an `archivedAt` timestamp to `story.json`, and removes it from the active SQLite database.

Archived stories are viewable at **`http://localhost:7437/archived`** — a dedicated page listing all archived stories with their synopsis content.

The `team_enrich_synopsis` LLM tool can optionally generate a richer AI-written summary for archived stories that warrant a more detailed historical record.

## Permission System Integration

Works with [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system):

- **Autonomous mode** — `yoloMode: true`, no permission prompts (teammate works freely)
- **Pairing mode** — `yoloMode: false`, normal permission rules apply (you're protected when mentoring)

The toggle is automatic: when you type in a teammate's window, it switches to pairing mode. Run `/ppt-worker-resume` to return to autonomous.

## License

MIT

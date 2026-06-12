# Pi Adapter Setup Guide

The [pi-pizza-team](https://github.com/timzen/pi-pizza-team) extension connects Pi to the my-pizza-team daemon. It provides three roles: **Leader**, **Teammate**, and **Assistant**.

## Prerequisites

- [Pi](https://pi.mariozechner.at/) installed
- my-pizza-team daemon running (`mpt start`)

## Install

```bash
pi install git:github.com/timzen/pi-pizza-team
```

## Roles

### Leader

The leader manages the team: spawns teammates in tmux, monitors progress, and acts as the human reviewer.

```bash
# Auto-detects leader role if .pi-pizza-team/ exists in cwd:
cd /path/to/your-project
pi

# Or explicit:
pi --ppt-lead=http://localhost:7437
```

The leader:
- Polls the daemon for spawn requests
- Opens tmux windows for new teammates
- Provides slash commands for story/task management
- Has LLM tools: `create_story`, `add_task`, `team_status`, etc.

### Teammate (Autonomous Agent)

Teammates poll the daemon for tasks and work autonomously.

```bash
# Usually spawned by the leader, but can run manually:
pi --ppt-worker --ppt-daemon=http://localhost:7437 --ppt-name=swift-ripley
```

The teammate loop:
1. Polls `GET /api/agents/next-work` for unclaimed tasks
2. Claims task with `POST /api/agents/claim/:id` (daemon transitions to working state)
3. Does the work
4. Releases with `POST /api/agents/release/:id` (daemon advances to next state)
5. On re-claim, loads comments for lead feedback

### Assistant

Processes free-form requests from the assistant queue.

```bash
pi --ppt-assistant --ppt-daemon=http://localhost:7437
```

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--ppt-daemon` | string | `http://localhost:7437` | Daemon URL |
| `--ppt-lead` | string | (auto) | Activate leader role |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | Run as assistant |
| `--ppt-name` | string | (generated) | Agent name |

## Configuration

The extension reads daemon URL from (priority order):
1. `--ppt-daemon` flag
2. `--ppt-lead` flag value (if it's a URL)
3. `.pi-pizza-team/config.json` → `leaderUrl` field
4. Default: `http://localhost:7437`

## Pairing Mode

When you type in a teammate's tmux window, it switches to **pairing mode** (permission prompts enabled). Run `/ppt-worker-resume` to return to autonomous mode.

## LLM Tools

### Leader Tools
- `create_story` — Create a story with tasks
- `edit_story` — Update story fields
- `add_task` — Add a task to a story
- `queue_request` — Queue work for the assistant
- `save_memory` / `search_memory` — Knowledge base
- `team_status` — Current team summary

### Teammate Tools
- `search_memory` — Find relevant context
- `upload_attachment` — Attach files to current task

### Assistant Tools
- `create_story`, `edit_story`, `add_task` — Story/task management
- `save_memory`, `search_memory` — Knowledge base
- `queue_request` — Delegate sub-requests

## Multi-Machine Setup

Configure per-host settings in the daemon's `config.json`:

```json
{
  "hosts": {
    "macbook": {
      "favoriteDirectories": ["/Users/you/projects"],
      "tmuxSession": "pizza-mac"
    }
  }
}
```

The leader uses `GET /api/hosts/:hostId` to get host-specific spawn configurations.

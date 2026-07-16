# my-pizza-team 🍕

> A **π pizza team** (3.14 pizzas, the perfect size) — a daemon for multi-agent team coordination.

Manages stories, tasks, workflows, and agent lifecycle. Connects to coding agent harnesses (Pi, Claude Code, Codex) to orchestrate autonomous teammates.

```
┌─────────────────────────────────────────────────────────────────┐
│                        mpt daemon                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │  Stories  │  │  Tasks   │  │ Workflow  │  │  Knowledge   │   │
│  │  & Board  │  │ & Claims │  │  Engine   │  │    Base      │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                         HTTP API                                 │
└─────────────────┬───────────────┬───────────────┬───────────────┘
                  │               │               │
         ┌────────┘        ┌──────┘        ┌──────┘
         ▼                 ▼               ▼
   ┌──────────┐      ┌──────────┐   ┌──────────┐
   │  Pi Lead │      │ Claude   │   │  Codex   │
   │  + Team  │      │  Code    │   │ Wrapper  │
   └──────────┘      └──────────┘   └──────────┘
```

- **You** create stories and tasks via the web UI or API
- **Agent harnesses** poll for work, claim tasks, do the work, and release
- **The daemon** enforces workflow rules, manages assignments, tracks progress

📖 **New here?** See [QUICKSTART.md](QUICKSTART.md) to get running in 5 minutes.

---

## CLI Reference

```
mpt <command> [options]

Commands:
  start [--daemon|-d]   Start the daemon (foreground, or background with -d)
  stop                  Stop the running daemon
  status                Check if daemon is running + show summary
  rotate-token          Generate a new API token
  install               Install as system service (auto-start on login)
  uninstall             Remove system service

Environment:
  TEAM_DIR    Team directory or its parent (default: ./.my-pizza-team)
  PORT        Daemon port (default: 7437)
  HOST        Bind address (default: 127.0.0.1)
```

---

## Configuration

The daemon reads `.my-pizza-team/config.json`. Minimal:

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

  // ─── Authentication ────────────────────────────────────────────
  "apiToken": "your-secret-token",       // Required if binding 0.0.0.0

  // ─── Workflow ──────────────────────────────────────────────────
  "defaultWorkflow": "default",

  // ─── Team ──────────────────────────────────────────────────────
  "tmuxSession": "my-pizza-team",
  "maxTeammates": 4,
  "agentTimeoutSeconds": 90,

  // ─── Autosave ─────────────────────────────────────────────────
  "autosave": {
    "flushIntervalMinutes": 30,
    "commitIntervalHours": 24,
    "commitMessage": "my-pizza-team: checkpoint {timestamp}",
    "autoCommit": true
  },


  // ─── Recently Used Capabilities (auto-maintained) ───────────────
  // Map of capability name → known values (most-recent-first). Auto-updated
  // when stories declare `requirements` and when agents register. Presence-only
  // capabilities map to []. Editable via the /api/capabilities endpoints.
  "recentCapabilities": {
    "directory": ["/path/to/project"],
    "python": ["3.11"],
    "design": []
  },

  // ─── Teammates ─────────────────────────────────────────────────
  "teammates": {
    "nouns": ["ripley", "deckard", "neo"]
  },

  // ─── Multi-Machine Hosts ──────────────────────────────────────
  "hosts": {
    "macbook": {
      "tmuxSession": "pizza-mac"
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAM_DIR` | `./.my-pizza-team` | Path to team dir (or parent) |
| `PORT` | `7437` | Daemon HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` requires apiToken) |
| `MPT_API_TOKEN` | — | Overrides config.apiToken |

### Team Directory Layout

```
.my-pizza-team/
├── config.json
├── store.db             # SQLite runtime index
├── workflows/
│   └── default/
│       ├── workflow.json
│       └── *.md         # Transition instructions per state
├── stories/
│   └── my-story/
│       ├── story.json
│       └── tasks/
│           └── 01-task-slug/
│               ├── task.json
│               ├── comments.jsonl
│               └── attachments/
├── archived/
├── backlog/
└── context/             # Context library: reusable prompt/context markdown entries
```

---

## Workflows

Workflows define the states tasks move through and who can trigger each transition.

### workflow.json

```json
{
  "states": ["todo", "in_progress", "leader_review", "done"],
  "transitions": {
    "todo": { "in_progress": "any" },
    "in_progress": { "leader_review": "teammate" },
    "leader_review": { "done": "lead", "in_progress": "lead" }
  }
}
```

**States**: Ordered list. First = initial state for new tasks, last = terminal "done" state (override with `initialState`/`doneState`).

**Transitions**: Map of `fromState → { toState: permission }`:

| Permission | Who can trigger | Use case |
|-----------|----------------|----------|
| `"any"` | Lead or teammate | Starting work |
| `"teammate"` | Only agents | Autonomous work (coding, testing) |
| `"lead"` | Only the human | Review gates, approvals |

### Transition Instructions

Markdown files in the workflow directory guide agents when entering a state. Filename matches state name:

```
workflows/default/
├── workflow.json
├── in_progress.md       # Shown when entering in_progress
└── leader_review.md     # Shown when entering leader_review
```

Example `leader_review.md`:

```markdown
## On Enter
- Create a diff: `git diff HEAD~1 --output=/tmp/<TASKID>.diff`
- Upload the diff using upload_attachment
- Post a summary of what you accomplished

## Exit Criteria
- All review comments addressed
- Lead approves or has no comments
```

### Multiple Workflows

Define different workflows for different types of work:

```
workflows/
├── default/         # Standard dev: todo → in_progress → review → done
├── bugfix/          # Simplified: todo → fixing → done
└── doc-writing/     # idea → outline → write → edit → publish
```

Assign a workflow when creating a story (required).

---

## Agent Protocol

Agents use a simple claim/release loop. The daemon handles all state transitions:

```
1. POST /api/agents/register       → register with daemon
2. GET  /api/agents/next-work      → { task: { id, storyId, title } | null }
3. POST /api/agents/claim/:id      → assigns + transitions to working state
   (agent does the work)
4. POST /api/agents/release/:id    → advances state, stores result, releases
5. POST /api/agents/heartbeat      → keep-alive
```

### Registration: capabilities & work mode

```jsonc
POST /api/agents/register
{
  "id": "neo",
  "name": "neo",
  // Capabilities this agent has. The well-known `directory` key is the
  // agent's working directory; other keys are skills/tools it possesses.
  "capabilities": { "directory": "/path/to/project", "python": "3.11", "docker": null },
  // How this agent picks work (default: eager-helper).
  "workMode": "eager-helper",           // or "assigned-story"
  "assignedStoryId": "my-story"          // required when workMode = assigned-story
}
```

**Work modes:**

| Mode | Behavior |
|------|----------|
| `eager-helper` *(default)* | Picks up any story whose requirements the agent satisfies |
| `assigned-story` | Works only its `assignedStoryId`; when that story's tasks are exhausted, the daemon archives it and `next-work` returns `{ dismiss: true }` so the agent shuts down |

### How work is matched

A task is offered to an agent only if its story is **ready**, **not paused**, and
the agent's capabilities **satisfy the story's requirements**. Directory affinity
is not special — it's just the `directory` requirement:

- `requirements.directory` must equal the agent's `capabilities.directory` (exact, normalized).
- Any other `requirements` key must be present in the agent's capabilities; a
  `null` value means "just needs to have it", a non-null value must match exactly.

See [docs/DESIGN.md](docs/DESIGN.md) → *Capability-Based Work Matching*.

### What the agent gets on claim

| Field | Description |
|-------|-------------|
| `task` | Minimal structured metadata for bookkeeping: `id`, `storyId`, `status` |
| `prompt` | **The full, ready-to-use prompt** assembled by the daemon (story, task, prior-task context, lead comments, state guidance, and the transition instructions for leaving the previous state and entering the working state). Harnesses deliver this verbatim rather than re-assembling their own. |

---

## Harness Guides

### Pi (Native Extension)

The [pi-pizza-team](https://github.com/timzen/pi-pizza-team) extension provides native leader + teammate integration:

```bash
pi install git:github.com/timzen/pi-pizza-team
```

The leader Pi instance manages tmux, spawns teammates, and provides slash commands. Teammates run an autonomous loop: poll → claim → execute → release → repeat.

### Claude Code (MCP Server)

Use the [mpt-mcp-server](https://github.com/timzen/mpt-mcp-server) as an MCP bridge:

```json
{
  "mcpServers": {
    "mpt": {
      "command": "node",
      "args": ["/path/to/mpt-mcp-server/src/index.mjs"],
      "env": {
        "MPT_DAEMON_URL": "http://localhost:7437",
        "MPT_AGENT_ID": "claude-1",
        "MPT_ROLE": "teammate"
      }
    }
  }
}
```

The MCP server exposes tools: `get_next_work`, `claim_task`, `release_task`, `post_comment`, `upload_attachment`.

### Codex (Shell Wrapper)

A shell-based runner that polls for work and executes via Codex CLI:

```bash
#!/bin/bash
DAEMON_URL="http://localhost:7437"
AGENT_NAME="codex-1"

# Register
curl -s -X POST "$DAEMON_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$AGENT_NAME\", \"name\": \"$AGENT_NAME\", \"cwd\": \"$(pwd)\"}"

# Poll → claim → execute → release loop
while true; do
  TASK=$(curl -s "$DAEMON_URL/api/agents/next-work?agentId=$AGENT_NAME" | jq -r '.task.id // empty')
  [ -z "$TASK" ] && sleep 5 && continue

  # Claim (daemon transitions to working state)
  CLAIM=$(curl -s -X POST "$DAEMON_URL/api/agents/claim/$TASK" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\"}")

  # Execute with codex...
  RESULT="Work completed"

  # Release (daemon advances to next state)
  curl -s -X POST "$DAEMON_URL/api/agents/release/$TASK" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\", \"result\": \"$RESULT\"}"
done
```

---

## API Overview

| Group | Key Endpoints | Purpose |
|-------|-----------|---------|
| Health | `GET /health` | Uptime, agents, memory |
| Stories | `GET/POST/PUT/DELETE /api/stories/*` | CRUD, archive, backlog |
| Tasks | `GET/POST/PUT/DELETE /api/tasks/*` | CRUD, move, comments, attachments |
| Agents | `/api/agents/*` | Register, heartbeat, claim, release |
| Assistant | `/api/assistant/*` | Chat conversation |
| Context | `/api/context/*` | Reusable prompt/context library (inject into agents) |
| Control | `POST /api/control/pause\|resume` | Pause/resume task distribution |
| Capabilities | `GET/POST/DELETE /api/capabilities` | Recently used capability names + values |
| Workflows | `GET /api/workflows/*` | List, view, manage workflows |

Full API route table: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#api-routes)

---

## Project Structure

```
my-pizza-team/
├── daemon/            # HTTP server (Hono on Deno.serve)
│   ├── server.ts      # Route orchestrator
│   ├── store.ts       # SQLite data layer
│   └── routes/        # Route modules (shared, stories, tasks, agents, etc.)
├── cli/               # CLI (start/stop/status/install)
├── ui/                # Frontend (React + Vite + shadcn/ui)
├── shared/            # Shared types, utilities, protocol contracts
├── desktop/           # Native tray/menu bar apps (macOS, Windows)
├── scripts/           # Build and packaging scripts
├── tests/             # Integration and unit tests
└── docs/              # Architecture and design docs
```

---

## Development

```bash
deno task dev          # Auto-reload daemon
deno task ui:dev       # Vite dev server for UI
deno task test         # Run tests
deno task check        # Type-check
```

## Building

```bash
deno task compile              # Single binary (current platform)
deno task compile:all          # All platforms → dist/
```

---

## License

MIT

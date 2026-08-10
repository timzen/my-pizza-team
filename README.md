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
- **Agent harnesses** poll for work, claim tasks, do the work, and mark done
- **The daemon** admits work (one task in flight per story), advances completed
  work, manages assignments, tracks progress

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
  upgrade [--check]     Self-update to the latest GitHub release (--check only reports)

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
│       └── *.md         # State persona per agent state
├── stories/            # flat story files (grouping/order/status)
│   ├── my-story.json    #   tasks: [{id, status}]  (children live in tasks/)
│   └── …
├── tasks/              # EVERY unit of work is a WorkDef (authored markdown)
│   └── my-story-1/
│       ├── workdef.md   #   Goal / Acceptance Criteria / Additional Context + parent
│       ├── comments.jsonl
│       └── attachments/
├── schedules/          # cron parents (fire their child WorkDefs)
│   └── nightly.json
├── templates/          # Task Templates: reusable molds for Solitary tasks
│   └── investigate-ticket/
│       └── template.md  #   same authored fields as a WorkDef; never enqueues
├── archived/
├── backlog/
├── context/             # Context library: reusable prompt/context markdown entries
├── thoughts/            # Thoughts board: markdown sticky notes (thoughts/<id>.md)
└── groups.json          # Thought groups ([{id, title}]; membership lives on each note)
```

---

## Workflows

A workflow is an **ordered pipeline of active states** between the implicit
`todo` and `done` buckets (see [docs/WORK-MODEL.md](docs/WORK-MODEL.md)).
There is no transition matrix: the daemon admits one task per story into the
pipeline (CONWIP), advances completed agent work automatically, and you can
move any card anywhere.

### workflow.json

```json
{
  "states": [
    { "name": "in_progress", "type": "agent" },
    { "name": "leader_review", "type": "manual" }
  ]
}
```

**States**: Ordered. `todo` and `done` are implicit — never declared.

| Type | Who works it | How it completes |
|------|--------------|------------------|
| `"agent"` | Teammates (claim → work → COMPLETE) | Daemon advances automatically |
| `"manual"` | You (or the leader agent) | You move the card onward |

When a task lands in an **agent state** the daemon enqueues a `READY` WorkItem
for it; a teammate claims it (→ `IN_PROGRESS`) and, on COMPLETE, the daemon
advances the task. The board shows the active WorkItem as a chip (queued /
working / at-risk).

### State Personas

Markdown files in the workflow directory give each **agent state** a persona —
role framing injected into the claim prompt. Filename matches state name:

```
workflows/default/
├── workflow.json
└── in_progress.md       # The "implementer" persona for in_progress
```

Example `in_progress.md`:

```markdown
You are a careful implementer. Write the code the task describes,
add tests, and keep the change minimal. Summarize what you did when
you finish — the task advances automatically.
```

Manual states need no persona (no prompt is ever built for them).

### Multiple Workflows

Define different workflows for different types of work:

```
workflows/
├── default/         # Standard dev: todo → in_progress → review → done
├── bugfix/          # Simplified: [fixing]
└── doc-writing/     # [outline, write, edit] with a manual publish gate
```

Assign a workflow when creating a story (required).

---

## Agent Protocol

Agents work the **WorkItem queue** — the single unit of agent execution — in a
poll → claim → work → set-state loop. Workers never move tasks; the daemon
reacts to a terminal WorkItem state (COMPLETE advances the task, FAILED leaves
it stuck for a human). See [docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md](docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).

```
1. POST /api/agents/register              → register with daemon
2. GET  /api/agents/next-work             → { workItem: { id, title } | null }
3. POST /api/agents/claim/:workItemId     → lease (→ IN_PROGRESS) + daemon prompt
   (agent does the work, in the ref's directory)
4. POST /api/agents/work-items/:id/state  → { state: "COMPLETE" } (advance task)
   or { state: "FAILED" } after posting a comment (leave the task stuck)
5. POST /api/agents/heartbeat             → keep-alive (restores this agent's MORIBUND items)
```

### Registration: name + directory

```jsonc
POST /api/agents/register
{
  "id": "neo",
  "name": "neo",
  // The agent's working directory (its pi cwd). This is the ONLY work-selection
  // signal — teammates are a flat generalist pool biased by directory.
  "directory": "/path/to/project"
}
```

There are no capabilities, skills, or work modes: every teammate is a
generalist. Retiring capability matching removed a whole class of
path-string/skill-mismatch bugs.

### How work is matched: directory affinity

`getNextWorkItem()` picks the next `READY` WorkItem for a polling agent using
soft, presence-based **directory affinity** (no timers, no hard requirements):

1. **My directory** — items whose ref names the agent's `directory`.
2. **Un-homed work** — items with no directory.
3. **Another directory** — only if *no online agent* is homed there (so nothing
   starves), otherwise it waits for a matching-directory teammate to appear.

An item that ends up somewhere an agent can't reach is simply failed by that
agent. See [docs/DESIGN.md](docs/DESIGN.md).

### What the agent gets on claim

| Field | Description |
|-------|-------------|
| `workItem` | Minimal bookkeeping metadata: `{ id }` (the harness treats it as opaque) |
| `prompt` | **The full, ready-to-use prompt** assembled by the daemon (state persona, story/WorkDef, working-directory instruction, reference context, prior-task context, lead comments, completion guidance). Harnesses deliver this verbatim rather than re-assembling their own. |

---

## Harness Guides

### Pi (Native Extension)

The [pi-pizza-team](https://github.com/timzen/pi-pizza-team) extension provides native leader + teammate integration:

```bash
pi install git:github.com/timzen/pi-pizza-team
```

The leader Pi instance manages tmux, spawns teammates, and provides slash commands. Teammates run an autonomous loop: poll → claim → execute → set-state → repeat.

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

# Register (name + working directory)
curl -s -X POST "$DAEMON_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$AGENT_NAME\", \"name\": \"$AGENT_NAME\", \"directory\": \"$(pwd)\"}"

# Poll → claim → execute → set-state loop
while true; do
  WI=$(curl -s "$DAEMON_URL/api/agents/next-work?agentId=$AGENT_NAME" | jq -r '.workItem.id // empty')
  [ -z "$WI" ] && sleep 5 && continue

  # Claim (daemon leases the WorkItem → IN_PROGRESS and returns the prompt)
  CLAIM=$(curl -s -X POST "$DAEMON_URL/api/agents/claim/$WI" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\"}")

  # Execute with codex...
  RESULT="Work completed"

  # Complete (daemon advances the task). Use "FAILED" to give up (leave it stuck).
  curl -s -X POST "$DAEMON_URL/api/agents/work-items/$WI/state" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\", \"state\": \"COMPLETE\", \"result\": \"$RESULT\"}"
done
```

---

## API Overview

| Group | Key Endpoints | Purpose |
|-------|-----------|---------|
| Health | `GET /health` | Uptime, agents, memory |
| Stories | `GET/POST/PUT/DELETE /api/stories/*` | CRUD, archive, backlog |
| Tasks | `GET/POST/PUT/DELETE /api/tasks/*` | CRUD, move, comments, attachments |
| Agents | `/api/agents/*` | Register, heartbeat, next-work, claim, work-item state |
| Assistant | `/api/assistant/*` | Chat conversation (batched replies, read receipts, response turns) |
| Context | `/api/context/*` | Reusable prompt/context library (inject into agents) |
| Thoughts | `GET/POST /api/thoughts`, `POST /api/thoughts/positions`, `PATCH /api/thoughts/:id`, `POST .../archive\|restore`, `DELETE`, `POST/PATCH/DELETE /api/thought-groups[/:id]` | Markdown sticky-note board (a personal workspace/outbox) |
| Control | `POST /api/control/pause\|resume` | Pause/resume task distribution |
| WorkItems | `GET /api/work-items`, `POST /api/work-items/:id/{cancel,force-fail,read}`, `POST /api/work-items/re-enqueue` | The queue: list (Inbox/sidebar) + recovery actions |
| WorkDefs | `GET/POST/PUT/DELETE /api/work-defs`, `POST /api/work-defs/:id/enqueue` | Standalone Solitary + Scheduled work |
| Templates | `GET/POST/PUT/DELETE /api/templates` | Reusable molds that pre-fill a new Solitary task (never enqueue) |
| Hosts | `GET /api/hosts/:hostId`, `POST /api/hosts/:hostId/readiness`, `GET /api/hosts-readiness` | Host config + readiness (a not-ready host holds scheduled work destined for it) |
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

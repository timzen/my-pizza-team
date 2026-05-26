# Architecture

This document explains how pi-pizza-team is structured internally, for developers who want to modify or extend the codebase.

## Overview

pi-pizza-team is a Pi extension package that operates in two roles depending on where it's launched:

```
┌─────────────────────────────────────────────────────────────┐
│  Extension loads (src/index.ts)                              │
│                                                              │
│  Does .pi-pizza-team/config.json exist in cwd?              │
│  ├── YES → setupTeamLead()                                  │
│  │         • Load config + SQLite store                     │
│  │         • Start HTTP server                              │
│  │         • Register lead commands + LLM tools             │
│  │         • Start autosave timers                          │
│  │         • Show status widget                             │
│  │                                                          │
│  └── NO → Is --team-worker flag set or PI_TEAM_LEADER_URL?  │
│       ├── YES → setupTeammate()                             │
│       │         • Connect to leader HTTP API                │
│       │         • Start work loop (poll → claim → execute)  │
│       │         • Register permission bypass                │
│       │         • Listen for agent_end to capture results   │
│       │                                                     │
│       └── NO → Register only /team-init command             │
└─────────────────────────────────────────────────────────────┘
```

## Module Map

```
src/
├── index.ts              # Entry point: role detection + setup orchestration
├── shared/
│   ├── types.ts          # All TypeScript types, interfaces, constants, defaults
│   └── protocol.ts       # HTTP API request/response shapes (shared contract)
├── lead/
│   ├── store.ts          # SQLite store: schema, CRUD, sync to/from JSON files
│   ├── server.ts         # Hono HTTP server: API routes + web UI (board, landing)
│   ├── commands.ts       # Slash commands + team_add_task LLM tool
│   └── tmux.ts           # tmux session/window lifecycle management
└── teammate/
    ├── client.ts         # HTTP client wrapping all leader API calls
    ├── loop.ts           # Work loop: poll → claim → execute → report
    └── permissions.ts    # Dynamic yoloMode toggling for permission system
```

## Data Flow

### Team Lead (server side)

```
JSON files on disk                    SQLite (state.db)
─────────────────                    ─────────────────
stories/*/story.json  ──loadFromDisk()──►  stories table
stories/*/tasks/*/task.json  ──────────►  tasks table
stories/*/tasks/*/messages.jsonl  (lazy)►  messages table

                         SQLite
                        ─────────
                    tasks.dirty = 1
                           │
              flushToDisk() (every 30 min + shutdown)
                           │
                           ▼
                    task.json files updated
                           │
              commitToGit() (daily)
                           │
                           ▼
                    git add + commit
```

### Teammate (client side)

```
┌─────────────────────────────────────────────────────────┐
│  WorkLoop                                                │
│                                                          │
│  1. GET /api/next-task?memberId=X                       │
│  2. POST /api/tasks/:id/claim                           │
│  3. pi.sendUserMessage(task.description)                │
│     └── Pi agent executes the task autonomously         │
│  4. agent_end event fires                               │
│     └── handleAgentComplete(lastAssistantMessage)       │
│         ├── If "NEEDS_INPUT:" → POST message + status   │
│         └── Else → POST status=review + result          │
│  5. Back to step 1                                      │
└─────────────────────────────────────────────────────────┘
```

## SQLite Schema

The database (`state.db`) is the runtime engine. See `src/lead/store.ts` for the full schema.

**Tables loaded from disk (source of truth = JSON files):**
- `stories` — story metadata (id, title, description, status, depends_on, dir_path)
- `tasks` — task definitions (id, story_id, seq, slug, title, description, status, result, dir_path, dirty)

**Tables that are runtime-only (ephemeral, never written to JSON):**
- `assignments` — which teammate has claimed which task
- `members` — registered teammates with heartbeat timestamps
- `messages` — cached messages (loaded lazily from messages.jsonl on first access)
- `messages_loaded` — tracks which tasks have had their messages loaded from disk

## Sync Strategy

### Startup
1. Walk `.pi-pizza-team/stories/` directory tree
2. Load each `story.json` and `task.json` into SQLite
3. Messages are NOT loaded (lazy — only on first access)

### Runtime writes
| Event | Action |
|-------|--------|
| New message | Append to `messages.jsonl` immediately + insert into SQLite |
| Task status change | Update SQLite, mark `dirty = 1` |
| Story completion | Update SQLite + write `story.json` immediately |

### Periodic flush (configurable, default 30 min)
- All tasks with `dirty = 1` → write back to `task.json`, clear dirty flag

### Daily commit (configurable)
- `git add .pi-pizza-team/ && git commit -m "checkpoint..."`
- Only if there are staged changes
- Never pushes (that's manual)

### Shutdown
- Flush all dirty state immediately

## Workflow Engine

The workflow is defined in `config.json` as a state machine:

```json
{
  "transitions": {
    "<from_state>": { "<to_state>": "<permission>" }
  }
}
```

Permissions: `"any"`, `"teammate"`, `"lead"`

Validation happens in `Store.canTransition()` — called by the HTTP API before any status update. The API returns 403 if the actor doesn't have permission for the requested transition.

## Permission System Integration

Uses `@gotgenes/pi-permission-system`'s `yoloMode` flag, which is read fresh on every tool call.

File: `<teammate-cwd>/.pi/extensions/pi-permission-system/config.json`

- **Created at spawn time** by `tmux.ts` with `yoloMode: true`
- **Toggled dynamically** by `permissions.ts`:
  - Interactive input detected → rewrite with `yoloMode: false`
  - `/team-worker-resume` → rewrite with `yoloMode: true`

## HTTP API

Server runs on the port from `config.json` (default 7437). Routes defined in `src/lead/server.ts`.

| Route | Purpose |
|-------|---------|
| `GET /` | Landing page HTML |
| `GET /board` | Kanban board HTML (polls API) |
| `GET /api/status` | Summary stats |
| `GET /api/stories` | All stories + tasks + readiness |
| `GET /api/next-task?memberId=X` | Next claimable task |
| `POST /api/tasks/:id/claim` | Claim a task |
| `POST /api/tasks/:id/status` | Update status (enforces workflow) |
| `POST /api/tasks/:id/message` | Post a message |
| `GET /api/tasks/:id/messages` | Get message thread |
| `POST /api/team/join` | Register a teammate |
| `POST /api/team/heartbeat` | Keepalive |
| `GET /api/team` | List members |
| `POST /api/control/pause` | Pause task distribution |
| `POST /api/control/resume` | Resume task distribution |

## tmux Integration

- `ensureSession()` — creates session if it doesn't exist, returns whether it was just created
- `spawnTeammate()` — reuses default window on fresh session, creates new window otherwise
- Writes permissive permission config to teammate's cwd before launching Pi
- Pi is launched with flags: `--team-worker --team-lead=<url> --team-name=<name>`

## Key Design Decisions

1. **JSON files are the source of truth** for stories/tasks (committable, diffable, human-readable)
2. **SQLite is the runtime engine** (fast, atomic, handles concurrent access)
3. **Messages use JSONL** (append-only, no read-modify-write, clean git diffs)
4. **Messages are lazy-loaded** (startup is fast regardless of history size)
5. **Stories own tasks sequentially** (parallelism is at the story level only)
6. **Workflow permissions are declarative** (config drives behavior, no code changes needed)
7. **Task execution uses sendUserMessage** (keeps teammate interactive for pairing)
8. **Permission toggle is file-based** (leverages permission system's runtime config reload)

## Extending

### Adding a new command
1. Add to `src/lead/commands.ts` inside `registerLeadCommands()`
2. Use `getStore()` for data access, `getConfig()` for config
3. Add autocomplete via `getArgumentCompletions` if applicable

### Adding a new API endpoint
1. Add route in `src/lead/server.ts` → `setupRoutes()`
2. Add request/response types in `src/shared/protocol.ts`

### Adding a new workflow state
1. Just add it to `config.json` — no code changes needed
2. Define transitions and permissions in the `transitions` map

### Modifying the board UI
1. Edit the `BOARD_HTML` constant at the bottom of `src/lead/server.ts`
2. It's vanilla HTML/JS that polls the JSON API every 3 seconds

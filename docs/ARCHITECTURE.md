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
│  └── NO → Is --ppt-worker flag set or PI_TEAM_LEADER_URL?  │
│       ├── YES → setupTeammate()                             │
│       │         • Connect to leader HTTP API                │
│       │         • Start work loop (poll → claim → execute)  │
│       │         • Register permission bypass                │
│       │         • Listen for agent_end to capture results   │
│       │                                                     │
│       └── NO → Register only /ppt-init command             │
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
│   ├── store.ts          # SQLite store: schema, CRUD, sync to/from JSON files, archiving
│   ├── server.ts         # Hono HTTP server: API routes + web UI (board, archived, landing)
│   ├── assets.ts         # Static asset loader (reads from ui/ at module load)
│   ├── ui/               # HTML, CSS, JS for the web UI
│   │   ├── home-page.html / .css
│   │   ├── board.html / .css
│   │   ├── archived-page.html / .css
│   │   ├── config-page.html / .css
│   │   ├── theme.css         # CSS custom properties for themes
│   │   ├── nav.css / nav.js  # Shared navigation bar
│   │   └── shared.js         # Shared browser utilities (escHtml, renderMarkdown)
│   ├── commands.ts       # Slash commands for team lead
│   ├── tools.ts          # LLM-callable tools (team_add_story, team_add_task)
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
- `stories` — story metadata (id, title, description, status, depends_on, dir, dir_path)
- `tasks` — task definitions (id, story_id, seq, slug, title, description, status, result, dir_path, dirty)

**Tables that are runtime-only (ephemeral, never written to JSON):**
- `assignments` — which teammate has claimed which task
- `members` — registered teammates with heartbeat timestamps
- `messages` — cached messages (loaded lazily from messages.jsonl on first access)
- `messages_loaded` — tracks which tasks have had their messages loaded from disk

## Sync Strategy

### Startup
1. Walk `.pi-pizza-team/stories/` directory tree (NOT `archived/`)
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

Workflows are defined in `config.json` as named state machines. Each workflow has a name, and one is designated as the default. Individual stories can override the default by specifying a `workflow` field.

```json
{
  "defaultWorkflow": "default",
  "workflows": {
    "default": {
      "states": ["todo", "in_progress", "needs_input", "review", "done"],
      "transitions": {
        "todo": { "in_progress": "any" },
        "in_progress": { "needs_input": "teammate", "review": "teammate" },
        "needs_input": { "in_progress": "lead" },
        "review": { "done": "lead", "in_progress": "lead" }
      }
    },
    "simple": {
      "states": ["todo", "in_progress", "done"],
      "transitions": {
        "todo": { "in_progress": "any" },
        "in_progress": { "done": "any" }
      }
    }
  }
}
```

Permissions: `"any"`, `"teammate"`, `"lead"`

**Resolution order:**
1. Story's `workflow` field → named workflow from config
2. If not set (or unknown name) → `defaultWorkflow` from config

Validation happens in `Store.canTransition()` which calls `getWorkflowForTask()` to resolve the effective workflow. The API returns 403 if the actor doesn't have permission for the requested transition.

## Permission System Integration

Uses `@gotgenes/pi-permission-system`'s `yoloMode` flag, which is read fresh on every tool call.

File: `<teammate-cwd>/.pi/extensions/pi-permission-system/config.json`

- **Created at spawn time** by `tmux.ts` with `yoloMode: true`
- **Toggled dynamically** by `permissions.ts`:
  - Interactive input detected → rewrite with `yoloMode: false`
  - `/ppt-worker-resume` → rewrite with `yoloMode: true`

## HTTP API

Server runs on the port from `config.json` (default 7437). Routes defined in `src/lead/server.ts`.

| Route | Method | Purpose |
|-------|--------|--------|
| `/` | GET | Landing page HTML |
| `/board` | GET | Kanban board HTML (polls API) |
| `/archived` | GET | Archived stories page HTML |
| `/config` | GET | Configuration page HTML |
| `/css/board.css` | GET | Board stylesheet |
| `/css/archived-page.css` | GET | Archived page stylesheet |
| `/css/config-page.css` | GET | Config page stylesheet |
| `/js/shared.js` | GET | Shared browser utilities (escHtml, renderMarkdown) |
| `/api/status` | GET | Summary stats + workflow config |
| `/api/stories` | GET | All stories + tasks + readiness |
| `/api/stories` | POST | Create a new story (with optional tasks, dir) |
| `/api/stories/:storyId/tasks` | POST | Create a task within a story |
| `/api/stories/:id` | DELETE | Delete a story and all its tasks (400 if tasks in progress) |
| `/api/stories/:id/archive` | POST | Archive a completed story (400 if tasks incomplete) |
| `/api/archived` | GET | List archived stories with synopsis |
| `/api/next-task?memberId=X` | GET | Next claimable task (filtered by member's cwd ↔ story dir) |
| `/api/tasks/:id/claim` | POST | Claim a task (returns transition instructions) |
| `/api/tasks/:id/status` | POST | Update status (enforces workflow, returns instructions) |
| `/api/tasks/:id/move` | POST | Move task status (lead-only, enforces workflow) |
| `/api/tasks/:id` | PUT | Update task title/description |
| `/api/tasks/:id` | DELETE | Delete a task (removes from DB + disk) |
| `/api/tasks/:id/message` | POST | Post a message |
| `/api/tasks/:id/messages` | GET | Get message thread |
| `/api/team/join` | POST | Register a teammate |
| `/api/team/heartbeat` | POST | Keepalive |
| `/api/team` | GET | List members |
| `/api/team/spawn` | POST | Spawn a new teammate (auto-generates name) |
| `/api/team/spawn-options` | GET | Available directories for spawning |
| `/api/control/pause` | POST | Pause task distribution |
| `/api/control/resume` | POST | Resume task distribution |
| `/api/config` | GET | Read current configuration |
| `/api/config` | PUT | Update configuration (writes to disk) |

## Transition Instructions

The store supports optional markdown files in the team directory:
- `.pi-pizza-team/on-enter-<status>.md` — instructions when entering a status
- `.pi-pizza-team/on-exit-<status>.md` — instructions when leaving a status

These are read by `Store.getTransitionInstructions(fromStatus, toStatus)` and returned in the API responses for `/claim`, `/status`, and `/move` endpoints. The teammate's work loop prepends enter-instructions to the task prompt and sends exit/enter-review instructions as follow-up messages.

Files are cached in memory with a 30-second TTL and mtime-based invalidation.

## tmux Integration

- `ensureSession()` — creates session if it doesn't exist, returns whether it was just created
- `spawnTeammate()` — reuses default window on fresh session, creates new window otherwise
- Writes permissive permission config to teammate's cwd before launching Pi
- Pi is launched with flags: `--ppt-worker --ppt-lead=<url> --ppt-name=<name>`

## Key Design Decisions

1. **JSON files are the source of truth** for stories/tasks (committable, diffable, human-readable)
2. **SQLite is the runtime engine** (fast, atomic, handles concurrent access)
3. **Messages use JSONL** (append-only, no read-modify-write, clean git diffs)
4. **Messages are lazy-loaded** (startup is fast regardless of history size)
5. **Stories own tasks sequentially** (parallelism is at the story level only)
6. **Workflow permissions are declarative** (config drives behavior, no code changes needed; stories can override the default workflow)
7. **Task execution uses sendUserMessage** (keeps teammate interactive for pairing)
8. **Permission toggle is file-based** (leverages permission system's runtime config reload)
9. **Archived stories are directory-based** (moved from `stories/` to `archived/`, never loaded into SQLite at startup)

## Archiving

Completed stories can be archived to keep the active board clean:

```
stories/my-story/  ──archiveStory()──►  archived/my-story/
                                           + story.json (archivedAt added)
                                           + SYNOPSIS.md (auto-generated)
                                           + tasks/ (preserved as-is)
```

**Flow:**
1. `isStoryArchivable(id)` — checks all tasks are "done"
2. `archiveStory(id)` — moves dir, stamps archivedAt, generates synopsis, removes from SQLite
3. `getArchivedStories()` — reads `archived/` directory for listing
4. `getArchivedStoryContext(id)` — reads full context for listing

**Key invariant:** `loadFromDisk()` only walks `stories/`, so archived stories are never re-loaded into the active database. The `archived/` directory is purely file-based.

## Extending

### Adding a new command
1. Add to `src/lead/commands.ts` inside `registerLeadCommands()`
2. Use `getStore()` for data access, `getConfig()` for config
3. Add autocomplete via `getArgumentCompletions` if applicable

### Adding a new API endpoint
1. Add route in `src/lead/server.ts` → `setupRoutes()`
2. Add request/response types in `src/shared/protocol.ts`
3. For task CRUD, consider adding a store method for DB operations

### Adding a new workflow state
1. Just add it to a workflow in `config.json` — no code changes needed
2. Define transitions and permissions in the workflow's `transitions` map
3. Optionally add `on-enter-<state>.md` / `on-exit-<state>.md` for instructions

### Adding a new named workflow
1. Add a new entry under `workflows` in `config.json`
2. Define its `states` array and `transitions` map
3. Stories can use it via the `workflow` field in `story.json`

### Modifying the board UI
1. Edit `src/lead/ui/board.html` (loaded by `src/lead/assets.ts`)
2. It's vanilla HTML/JS that polls the JSON API every 3 seconds
3. Task data is stored in `taskDataMap` for safe modal access
4. Workflow transitions are fetched from `GET /api/status` and used to render move dropdowns
5. The archived stories page is a separate file: `src/lead/ui/archived-page.html`

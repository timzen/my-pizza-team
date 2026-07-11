# Architecture

## Overview

my-pizza-team is a Deno-based application organized into four main modules:

- **daemon/** — HTTP API server built with [Hono](https://hono.dev/) on Deno's native `Deno.serve()` adapter
- **cli/** — Command-line interface for interacting with the daemon
- **ui/** — Frontend application (TBD)
- **shared/** — Types, utilities, and constants shared across modules

## Module Map

### daemon/
- `main.ts` — Entry point. Reads PORT/HOST/TEAM_DIR from env, validates bind safety, starts `Deno.serve()`.
- `app.ts` — Creates the Hono application, wires Store to routes. Merges user config with defaults.
- `server.ts` — Builds the Hono app with route context (store, config, helpers). Applies auth middleware when token is configured.
- `workflow-engine.ts` — Centralized workflow state machine logic: `getClaimTarget()`, `getReleaseTarget()`, `canTransition()`, `getExitState()`, `isWorkableByAgent()`, `isDone()`.
- `store.ts` — SQLite data layer using `jsr:@db/sqlite`. Manages schema, CRUD for stories/tasks/assignments/members/comments, workflow validation, JSON file sync, autosave timers, and agent heartbeat timeout reaping. Also owns **capability-based work matching** (`getNextWorkableTask`): skips paused stories, restricts to `assignedStoryId` for `assigned-story` agents, and applies `meetsRequirements()` (the `directory` capability is just one requirement among many). Tracks **recently used capabilities** (`recordCapabilities`/`addCapability`/`removeCapability`) into `config.recentCapabilities` and persists `config.json` losslessly via `persistConfig()`.
- `auth.ts` — Optional API token authentication. Bearer tokens, Basic auth (for web UI), and query param fallback. Enforces bind safety (refuses 0.0.0.0 without token).
- `routes/agents.ts` — Agent protocol: register, heartbeat, next-work, claim, release, comments, spawn requests.
- `routes/tasks.ts` — Task CRUD, move (lead), comments, attachments, token usage.
- `routes/stories.ts` — Story CRUD, archive, backlog.
- `routes/shared.ts` — Health, status, config, control (pause/resume), hosts, workflow management.

### cli/
- `main.ts` — CLI entry point (start/stop/status/upgrade/install/uninstall).
- `service.ts` — Platform service installer/uninstaller. Generates macOS launchd plists or Linux systemd unit files for auto-start on login.
- `migrate.ts` — Migration logic for `mpt upgrade`. Converts legacy team directories (inline workflows, old instruction locations) to the daemon's expected structure.

### shared/
- `types.ts` — Shared TypeScript interfaces (TeamConfig, Story, Task, Member, etc.) and utility functions (slugify, getInitialState, getDoneState, generateTeammateName). Also defines the capability model: `Capabilities` (`Record<string, string | null>`), `WorkMode`, the `DIRECTORY_CAP` well-known key, `normalizeDirectory()`, and `meetsRequirements()`.
- `protocol.ts` — API request/response type contracts for all HTTP endpoints.
- `frontmatter.ts` — Parsing/serialization of YAML-like frontmatter for memory notes.
- `search.ts` — BM25 search engine for memory notes, with per-category indexes.

### tests/
- `health.test.ts` — Integration test for the `/health` endpoint using Hono's `app.request()` test helper.
- `server.test.ts` — API route tests (stories, tasks, claims, transitions, comments, team, pause/resume).
- `store.test.ts` — Unit tests for Store CRUD operations, workflow transitions, comment persistence, and disk sync.

## Data Flow

```
Client → Deno.serve() → Hono router → Route handler → JSON response
```

## Key Design Decisions

- **Deno runtime** — Chosen for built-in TypeScript, secure-by-default permissions, and standard library.
- **Hono framework** — Lightweight, fast, Web Standards-based. Uses `app.request()` for testing without starting a real server.
- **JSR imports** — Using `jsr:` specifiers via the import map in `deno.json` for dependency management.
- **No build step** — Deno runs TypeScript directly.
- **jsr:@db/sqlite** — Native FFI SQLite binding for Deno. API mirrors better-sqlite3 (synchronous, prepared statements). WAL mode for concurrent reads.
- **JSON files as source of truth** — Story/task definitions live on disk as JSON. SQLite is the fast runtime index, synced via the `dirty` flag and periodic flush.
- **Comments append to JSONL** — Never lost; append-only file per task.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (uptime, agents, queueDepth, memory, lastCommitTime) |
| GET | `/api/status` | Dashboard summary (stories, tasks, members) |
| GET | `/api/stories` | List all stories with tasks |
| POST | `/api/stories` | Create a new story (with optional tasks) |
| PUT | `/api/stories/:id` | Update story details |
| DELETE | `/api/stories/:id` | Delete a story |
| POST | `/api/stories/:id/archive` | Archive a completed story |
| POST | `/api/stories/:id/backlog` | Move story to backlog |
| POST | `/api/stories/:storyId/tasks` | Add a task to a story |
| POST | `/api/tasks/:id/move` | Lead moves a task to new status |
| PUT | `/api/tasks/:id` | Update task title/description |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/comment` | Post a comment on a task |
| GET | `/api/tasks/:id/comments` | Get task comments |
| POST | `/api/tasks/:id/token-usage` | Record token usage |
| GET | `/api/archived` | List archived stories |
| GET | `/api/backlog` | List backlogged stories |
| POST | `/api/backlog/:id/restore` | Restore from backlog |
| GET | `/api/assistant/queue` | List assistant queue |
| POST | `/api/assistant/queue` | Enqueue assistant item |
| GET | `/api/assistant/next` | Get next pending item |
| POST | `/api/assistant/queue/:id/claim` | Claim an item |
| POST | `/api/assistant/queue/:id/complete` | Complete an item |
| DELETE | `/api/assistant/queue/:id` | Delete an item |
| GET | `/api/assistant/notes` | List memory notes |
| POST | `/api/assistant/notes` | Save a note |
| DELETE | `/api/assistant/notes/:id` | Delete a note |
| POST | `/api/spawn-requests` | Create a spawn request |
| GET | `/api/spawn-requests?hostId=X` | Poll pending spawn requests for a host |
| POST | `/api/spawn-requests/:id/ack` | Acknowledge a spawn request |
| GET | `/api/workflows` | List workflow summaries (name, stateCount, transitionCount, isDefault) |
| GET | `/api/workflows/:name` | Get full WorkflowConfig for a workflow |
| GET | `/api/workflows/:name/instructions/:filename` | Read a workflow instruction markdown file |
| PUT | `/api/workflows/:name/instructions/:filename` | Write/update a workflow instruction markdown file |
| GET | `/api/config` | Get current config |
| GET | `/api/hosts/:hostId` | Get host-specific config (directories, tmuxSession) |
| POST | `/api/control/pause` | Pause task distribution |
| POST | `/api/control/resume` | Resume task distribution |
| GET | `/api/capabilities` | Get recently used capabilities (name -> known values) |
| POST | `/api/capabilities` | Add a capability key (and optional value) |
| DELETE | `/api/capabilities/:name` | Remove a key, or one value with `?value=X` |
| POST | `/api/agents/register` | Register an agent (`capabilities` map, `workMode`, `assignedStoryId`) |
| POST | `/api/agents/heartbeat` | Agent heartbeat |
| GET | `/api/agents/next-work?agentId=X` | Poll for workable tasks; returns `{ task: null, dismiss: true }` when an `assigned-story` agent's story is exhausted (daemon archives it) |
| POST | `/api/agents/claim/:taskId` | Claim task and transition to working state |
| POST | `/api/agents/release/:taskId` | Finish work, advance state, release ownership |
| GET | `/api/agents/comments/:taskId` | Get task comments |
| POST | `/api/agents/comments/:taskId` | Post a comment on a task |
| GET | `/api/agents` | List all registered agents |
| DELETE | `/api/agents/:id` | Unregister an agent |

## Agent Lifecycle

Agents use a simple claim/release loop. The daemon handles all state transitions:

```
1. Poll GET /api/agents/next-work → finds unclaimed task with teammate transitions
2. POST /api/agents/claim/:taskId → assigns ownership + transitions to working state
3. Agent does the work
4. POST /api/agents/release/:taskId → advances to next state, releases ownership
5. Agent polls again (repeat)
```

If the lead needs to act (e.g., review→done is lead-only), the release advances
to that state anyway and the task leaves the agent's hands. If the lead sends
the task back (e.g., review→coding with comments), the agent discovers it on
the next poll, claims it again, and sees the comments.

Comments are task-level, not real-time chat. Agents load them when
starting work to see lead feedback or rework instructions.

## Pi Extension (Thin Adapter)

### desktop/macos/
- `Sources/App.swift` — SwiftUI menu bar app (`LSUIElement`). Status bar icon, start/stop controls, team directory picker, port config.
- `Sources/DaemonManager.swift` — Launches the bundled `mpt` binary as a subprocess, polls `/health` for status, manages preferences via `UserDefaults`.
- `Resources/mpt.entitlements` — Code-signing entitlements for the compiled Deno binary. Required for V8 JIT (`allow-jit`, `allow-unsigned-executable-memory`) and FFI SQLite loading (`disable-library-validation`).
- `Package.swift` — Swift package manifest (SwiftUI, macOS 13+).

### Code Signing (macOS)

The compiled `mpt` binary requires three entitlements when signed with hardened runtime:
1. **`com.apple.security.cs.allow-jit`** — V8 needs MAP_JIT for code generation
2. **`com.apple.security.cs.allow-unsigned-executable-memory`** — V8 CodeRange allocation
3. **`com.apple.security.cs.disable-library-validation`** — `@db/sqlite` loads a `.dylib` via FFI with a different Team ID

Without these, the binary crashes immediately with "Failed to reserve virtual memory for CodeRange" or "code signature not valid for use in process".

The [pi-pizza-team](https://github.com/timzen/pi-pizza-team) extension (v0.2.0+)
is a **pure HTTP client** with zero server-side code. It owns no state — all data
lives in this daemon.

Extension structure (kept files only):
```
src/
├── index.ts       — Role detection, flag registration, wiring
├── client.ts      — DaemonClient: unified HTTP client for all API calls
├── leader.ts      — Tmux management, spawn polling, slash commands
├── teammate.ts    — TeammateLoop: poll → claim → execute → transition
├── assistant.ts   — AssistantLoop: queue processing
├── tools.ts       — LLM tool registration (role-specific)
├── permissions.ts — Dynamic yoloMode toggling
└── shared/types.ts — Minimal types (WorkflowConfig, constants)
```

Removed in v0.2.0 (moved to this daemon):
- HTTP server (hono, @hono/node-server)
- SQLite store (better-sqlite3)
- Web UI (React assets)
- BM25 search engine
- Git sync / autosave
- Protocol types (now daemon-internal)

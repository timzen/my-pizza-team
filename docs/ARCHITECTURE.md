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
- `app.ts` — Creates the Hono application, wires Store to routes.
- `server.ts` — All API route handlers (buildApp function). Implements the full REST protocol. Applies auth middleware when token is configured.
- `store.ts` — SQLite data layer using `jsr:@db/sqlite`. Manages schema, CRUD for stories/tasks/assignments/members/comments, workflow validation, JSON file sync, autosave timers, and agent heartbeat timeout reaping.
- `auth.ts` — Optional API token authentication. Bearer tokens, Basic auth (for web UI), and query param fallback. Enforces bind safety (refuses 0.0.0.0 without token).

### cli/
- `main.ts` — CLI entry point (start/stop/status/upgrade/install/uninstall).
- `service.ts` — Platform service installer/uninstaller. Generates macOS launchd plists or Linux systemd unit files for auto-start on login.
- `migrate.ts` — Migration logic for `mpt upgrade`. Converts legacy team directories (inline workflows, old instruction locations) to the daemon's expected structure.

### shared/
- `types.ts` — Shared TypeScript interfaces (TeamConfig, Story, Task, Member, etc.) and utility functions (slugify, getInitialState, getDoneState, generateTeammateName).
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
| GET | `/api/status` | Dashboard summary (stories, tasks, members, inbox) |
| GET | `/api/stories` | List all stories with tasks |
| POST | `/api/stories` | Create a new story (with optional tasks) |
| PUT | `/api/stories/:id` | Update story details |
| DELETE | `/api/stories/:id` | Delete a story |
| POST | `/api/stories/:id/archive` | Archive a completed story |
| POST | `/api/stories/:id/backlog` | Move story to backlog |
| POST | `/api/stories/:storyId/tasks` | Add a task to a story |
| GET | `/api/next-task?memberId=X` | Get next available task for a teammate |
| POST | `/api/tasks/:id/claim` | Claim a task (transitions to in_progress) |
| POST | `/api/tasks/:id/status` | Update task status (enforces workflow) |
| POST | `/api/tasks/:id/move` | Lead moves a task to new status |
| PUT | `/api/tasks/:id` | Update task title/description |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/comment` | Post a comment on a task |
| GET | `/api/tasks/:id/comments` | Get task comments |
| POST | `/api/tasks/:id/token-usage` | Record token usage |
| POST | `/api/tasks/:id/mark-read` | Mark comments as read |
| POST | `/api/team/join` | Register a teammate |
| POST | `/api/team/heartbeat` | Teammate heartbeat |
| GET | `/api/team` | List team members |
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
| GET | `/api/config` | Get current config |
| GET | `/api/hosts/:hostId` | Get host-specific config (directories, tmuxSession) |
| POST | `/api/control/pause` | Pause task distribution |
| POST | `/api/control/resume` | Resume task distribution |
| POST | `/api/agents/register` | Register a new agent |
| POST | `/api/agents/heartbeat` | Agent heartbeat |
| GET | `/api/agents/next-work?agentId=X` | Poll for unclaimed tasks with teammate transitions |
| POST | `/api/agents/claim/:taskId` | Claim task ownership (no state change) |
| POST | `/api/agents/transition/:taskId` | Advance task to next state |
| POST | `/api/agents/release/:taskId` | Release task (when blocked by lead transition) |
| GET | `/api/agents/comments/:taskId` | Get task comments |
| POST | `/api/agents/comments/:taskId` | Post a comment on a task |
| GET | `/api/agents` | List all registered agents |
| DELETE | `/api/agents/:id` | Unregister an agent |

## Agent Lifecycle

Agents own tasks across multiple state transitions. The flow:

```
1. Poll GET /api/agents/next-work → finds unclaimed task with teammate transitions
2. POST /api/agents/claim/:taskId → assigns ownership (no state change)
3. POST /api/agents/transition/:taskId → advances state (repeatable)
4. When availableTransitions is empty → POST /api/agents/release/:taskId
5. Lead acts (moves task via /api/tasks/:id/move, adds comments)
6. Agent polls again → re-discovers task, sees comments, claims, continues
```

Comments are task-level, not real-time chat. Agents load them when
starting work to see lead feedback or rework instructions.

# Architecture

## Overview

my-pizza-team is a Deno-based application organized into four main modules:

- **daemon/** — HTTP API server built with [Hono](https://hono.dev/) on Deno's native `Deno.serve()` adapter
- **cli/** — Command-line interface for interacting with the daemon
- **ui/** — Frontend application (TBD)
- **shared/** — Types, utilities, and constants shared across modules

## Module Map

### daemon/
- `main.ts` — Entry point. Reads PORT from env, starts `Deno.serve()`.
- `app.ts` — Creates the Hono application and registers all routes.
- `store.ts` — SQLite data layer using `jsr:@db/sqlite`. Manages schema, CRUD for stories/tasks/assignments/members/messages, workflow validation, JSON file sync, and autosave timers.

### cli/
- `main.ts` — CLI entry point (stub).

### shared/
- `types.ts` — Shared TypeScript interfaces (TeamConfig, Story, Task, Member, etc.) and utility functions (slugify, getInitialState, getDoneState, generateTeammateName).
- `frontmatter.ts` — Parsing/serialization of YAML-like frontmatter for memory notes.

### tests/
- `health.test.ts` — Integration test for the `/health` endpoint using Hono's `app.request()` test helper.
- `store.test.ts` — Unit tests for Store CRUD operations, workflow transitions, message persistence, and disk sync.

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
- **Messages append to JSONL** — Never lost; append-only file per task.

## API Routes

| Method | Path      | Handler Location | Description |
|--------|-----------|------------------|-------------|
| GET    | `/health` | `daemon/app.ts`  | Health check |

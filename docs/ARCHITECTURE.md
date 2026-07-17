# Architecture

## Overview

my-pizza-team is a Deno-based application organized into four main modules:

- **daemon/** — HTTP API server built with [Hono](https://hono.dev/) on Deno's native `Deno.serve()` adapter
- **cli/** — Command-line interface for interacting with the daemon
- **ui/** — Frontend application (React + Vite + shadcn/ui). Talks to the daemon's HTTP API.
  - `src/App.tsx` — Router + shell layout: `NavBar` on top, a scrollable `<main>` for the routed page, and a persistent `TeammateSidebar` on the right (shown on `lg+`). Pages: `/` + `/context` (RootPage — Workflows/Context tabs), `/board`, `/scratchpad`, `/assistant`, `/task/:storyId/:taskId`, `/story/:id`, `/backlog`, `/archived`, `/config`, `/workflows/:name`, `/help`.
  - `src/pages/RootPage.tsx` — Home. Two tabs for the foundational setup: **Workflows** (`/`) and **Context** (`/context`); renders `WorkflowsPage` / `ContextPage` as panels.
  - `src/components/TeammateSidebar.tsx` — Always-visible right column listing connected teammates (status dot, current task, **capability badges**) with per-teammate reset (`reset-session` directive → Pi's `/new`) and dismiss, plus a Spawn button. Collapses to a slim icon rail (status avatars + Spawn `+`); the choice is persisted in `localStorage`. Replaces the old standalone teammates page.
  - `src/pages/BoardPage.tsx` — Kanban board of story swimlanes. Task cards are **not** clickable as a whole; opening a task is an explicit action (an "eye" button opens a read-only preview, a `details →` link opens the task page).
  - `src/components/board/TaskViewDialog.tsx` — Read-only task preview modal (description + link to the task page). Editing does **not** happen here.
  - `src/components/board/StoryViewDialog.tsx` — Read-only story preview modal (description + link to the story page), opened by the "eye" button on a story header. Editing does **not** happen here.
  - `src/pages/TaskDetailPage.tsx` — Task page. Home for task editing (title, description, workflow status moves, delete) plus comments, attachments, and diff review.
  - `src/pages/StoryDetailPage.tsx` — Story page (`/story/:id`). Home for story editing (title, description, requirements, paused, delete) plus a linked task list. Reached by clicking a story title on the board. Requirements are edited with `RequirementsEditor` as key/value capabilities.
  - `src/components/board/RequirementsEditor.tsx` — Edits a story's requirements as key/value capability badges (add/remove), with name/value suggestions sourced from `/api/capabilities` (recently used capabilities). Mirrors the settings "Recent Capabilities" editor and the teammates capability badges.
- **shared/** — Types, utilities, and constants shared across modules

## Module Map

### daemon/
- `main.ts` — Entry point. Reads PORT/HOST/TEAM_DIR from env, validates bind safety, starts `Deno.serve()`.
- `app.ts` — Creates the Hono application, wires Store to routes. Merges user config with defaults.
- `server.ts` — Builds the Hono app with route context (store, config, helpers). Applies auth middleware when token is configured.
- `workflow-engine.ts` — Centralized workflow state machine logic: `getClaimTarget()`, `getReleaseTarget()`, `canTransition()`, `getExitState()`, `isWorkableByAgent()`, `isDone()`.
- `store.ts` — SQLite data layer using `jsr:@db/sqlite`. Manages schema, CRUD for stories/tasks/assignments/members/comments, workflow validation, JSON file sync, autosave timers, and agent heartbeat timeout reaping. **Task order is owned by the story** (`Story.taskOrder`, an array of task IDs in story.json); `getTasksForStory()` reconciles it against the tasks on disk (listed order first, orphans appended by creation `seq`, danglers ignored) and `reorderTasks()` just rewrites `taskOrder` — task IDs, titles, and directories are untouched. Also owns **capability-based work matching** (`getNextWorkableTask`): skips paused stories, restricts to `assignedStoryId` for `assigned-story` agents, and applies `meetsRequirements()` (the `directory` capability is just one requirement among many). Tracks **recently used capabilities** (`recordCapabilities`/`addCapability`/`removeCapability`) into `config.recentCapabilities` and persists `config.json` losslessly via `persistConfig()`. Self-contained concerns are split into `store/`:
  - `store/context.ts` — context library (reusable prompt/context entries as markdown files under `context/`, with `title`/`description`/`tags` frontmatter). Entries can be **attached to stories/tasks** (`story.context` / `task.context`, arrays of entry ids); `store.resolveTaskContext()` merges + dedupes them for prompt injection.
  - `store/scratchpad.ts` — personal scratch pad kept as plain files under the team dir (no SQLite): `todo.jsonl` (one `{status,item,created,completed}` per line, addressed by index) + `notes.md` (free-form markdown).
  - `store/git-sync.ts` — optional git checkpointing of the team directory.
- `auth.ts` — Optional API token authentication. Bearer tokens, Basic auth (for web UI), and query param fallback. Enforces bind safety (refuses 0.0.0.0 without token).
- `routes/agents.ts` — Agent protocol: register, heartbeat, next-work, claim, release, comments, and per-host leader directives. The claim response returns just `prompt` (the full message assembled by `prompt.ts`) plus minimal `task` metadata (`id`/`storyId`/`status`) — harnesses deliver the prompt verbatim instead of each re-assembling their own.
- `prompt.ts` — `buildTaskPrompt()`: assembles the canonical task prompt (Story → Task → reference context → prior-task context → lead comments → state guidance → transition instructions for leaving the previous state and entering the working state). **Reference context** is the set of context-library entries attached to the story and/or task (resolved + deduped by `store.resolveTaskContext`), inlined verbatim so every harness gets the same material. Session-specific framing is intentionally excluded — that belongs to a stateful harness, not the shared prompt. Also exports `normalizeInstructionMarkdown()`, which demotes authored instruction headings (fence-aware) so they nest under the prompt's own `##` sections and can't mangle its structure.
- `workflow-lint.ts` — `validateInstructionMarkdown()`: lints authored state-instruction markdown. Unbalanced code fences are **errors** (they'd swallow the rest of the prompt) and block the save; shallow headings and stray `---` rules are **warnings** (the prompt builder normalizes headings anyway).
- `routes/tasks.ts` — Task CRUD, move (lead), comments, attachments, token usage.
- `routes/stories.ts` — Story CRUD, archive, backlog.
- `routes/shared.ts` — Health, status, config, control (pause/resume), hosts, workflow management.
- `routes/assistant.ts` — Assistant chat (conversation + agent-facing turn queue) and the assistant **persona** (a context-library entry whose body is vended as the assistant's system prompt; when none is selected the daemon supplies `DEFAULT_ASSISTANT_PERSONA`). Swapping clears + resets the session.
- `routes/context.ts` — Context library CRUD (`/api/context`) over `store/context.ts`.
- `routes/scratchpad.ts` — Personal scratch pad (`/api/scratchpad`): todos (add/toggle/delete by index) + notes, over `store/scratchpad.ts`.

### cli/
- `main.ts` — CLI entry point (start/stop/status/install/uninstall/rotate-token). Exposes `main()` for the compiled binary and runs directly under `deno run`.
- `service.ts` — Platform service installer/uninstaller. Generates macOS launchd plists or Linux systemd unit files for auto-start on login.

### shared/
- `types.ts` — Shared TypeScript interfaces (TeamConfig, Story, Task, Member, etc.) and utility functions (slugify, getInitialState, getDoneState, generateTeammateName). Also defines the capability model: `Capabilities` (`Record<string, string | null>`), `WorkMode`, the `DIRECTORY_CAP` well-known key, `normalizeDirectory()`, and `meetsRequirements()`.
- `protocol.ts` — API request/response type contracts for all HTTP endpoints.
- `frontmatter.ts` — Parsing/serialization of YAML-like frontmatter (`title`, `description`, `tags`) for context entries.

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
- **Story-owned task ordering** — A task's `id` (stable key), `title` (name), and position are three separate concerns. The story owns the order via `taskOrder` (an array of task IDs in `story.json`); the creation `seq` in an id is just a stable counter, not a position. Task directories are named by the **task id only** (e.g. `tasks/auth-3/`), so the folder name never encodes order and never drifts when the title changes; `seq` is derived from the id on load and `slug` from the current title. Reordering rewrites one array in one file (great for git), needs no directory renames, and `loadFromDisk` reconciles the array against the tasks actually present so hand-edits are tolerated. See DESIGN.md.
- **Comments append to JSONL** — Never lost; append-only file per task.
- **"Teammates", not "Agents", in the UI** — The product is my-pizza-team, so human-facing vocabulary settled on "Teammates". The HTTP API and internal types keep the technical term `agent`/`member` (the route stays `/api/agents`). Teammates are shown in a persistent right-hand sidebar rather than a dedicated page.
- **Board previews; pages edit** — The board is for glancing and light triage (status nudges via prev/next). Clicking a card never opens an editor; a read-only modal previews a task, and all editing lives on dedicated pages (`/task/:storyId/:taskId`, `/story/:id`). This keeps destructive/edit actions off the high-traffic board surface.
- **Distinct panel color for chrome** — The nav header and story headers use `bg-muted` (not `bg-card`) so they read as a distinct panel against the page background in both light and dark themes.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (uptime, agents, queueDepth, memory, lastCommitTime) |
| GET | `/api/status` | Status summary (stories, tasks, members) |
| GET | `/api/stories` | List all stories with tasks |
| POST | `/api/stories` | Create a new story (with optional tasks) |
| PUT | `/api/stories/:id` | Update story details |
| DELETE | `/api/stories/:id` | Delete a story |
| POST | `/api/stories/:id/archive` | Archive a completed story |
| POST | `/api/stories/:id/backlog` | Move story to backlog |
| POST | `/api/stories/:storyId/tasks` | Add a task to a story |
| POST | `/api/stories/:storyId/tasks/reorder` | Reorder a story's tasks (`{ order: [taskId, ...] }`) |
| POST | `/api/tasks/:id/move` | Lead moves a task to new status |
| PUT | `/api/tasks/:id` | Update task title/description |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/comment` | Post a comment on a task |
| GET | `/api/tasks/:id/comments` | Get task comments |
| POST | `/api/tasks/:id/token-usage` | Record token usage |
| GET | `/api/archived` | List archived stories |
| GET | `/api/backlog` | List backlogged stories |
| POST | `/api/backlog/:id/restore` | Restore from backlog |
| GET | `/api/assistant/messages` | Get the assistant conversation (chronological) |
| POST | `/api/assistant/messages` | Send a user message (creates a pending assistant turn) |
| DELETE | `/api/assistant/messages/:id` | Delete a single message |
| DELETE | `/api/assistant/messages` | Clear the conversation (also resets the assistant session) |
| GET | `/api/assistant/persona` | Get the active persona + effective system prompt (`{personaId, entry, systemPrompt}`; `systemPrompt` falls back to the daemon default) |
| PUT | `/api/assistant/persona` | Swap the persona (clears + resets the session); `personaId: null` = default |
| GET | `/api/assistant/next` | Agent: get the next pending assistant turn (`{id, prompt}`) |
| POST | `/api/assistant/messages/:id/claim` | Agent: claim a turn (-> processing) |
| POST | `/api/assistant/messages/:id/complete` | Agent: complete a turn with a reply |
| GET | `/api/context` | List context-library entries |
| GET | `/api/context/:id` | Get a single context entry |
| POST | `/api/context` | Create/overwrite a context entry (id derived from title) |
| PUT | `/api/context/:id` | Update a context entry in place |
| DELETE | `/api/context/:id` | Delete a context entry |
| GET | `/api/scratchpad` | Get the scratch pad (`{todos, notes}`) |
| POST | `/api/scratchpad/todos` | Add a todo (`{item}`) |
| PUT | `/api/scratchpad/todos/:index` | Update a todo by index (`status`/`item`; done stamps `completed`) |
| DELETE | `/api/scratchpad/todos/:index` | Delete a todo by index |
| PUT | `/api/scratchpad/notes` | Overwrite the notes markdown (`{content}`) |
| POST | `/api/hosts/:hostId/leader/directives` | Create a leader directive (spawn, reset-session, ...) |
| GET | `/api/hosts/:hostId/leader/directives` | Poll pending directives for a host (single leader queue) |
| PUT | `/api/hosts/:hostId/leader/directives/:id` | Update a directive's status (e.g. `done`) |
| GET | `/api/spawn-requests` | List pending `spawn` directives across all hosts (name, cwd, hostId, createdAt) — surfaces stuck spawns in the UI |
| DELETE | `/api/spawn-requests/:id` | Cancel a pending spawn request (marks it `cancelled` so the leader stops retrying) |
| GET | `/api/workflows` | List workflow summaries (name, stateCount, transitionCount, isDefault) |
| GET | `/api/workflows/:name` | Get full WorkflowConfig for a workflow |
| GET | `/api/workflows/:name/instructions/:filename` | Read a workflow instruction markdown file |
| PUT | `/api/workflows/:name/instructions/:filename` | Write/update a workflow instruction markdown file. Lints content: unbalanced code fences are errors (rejected, 400); shallow headings / `---` return `warnings` on success. |
| GET | `/api/config` | Get current config |
| GET | `/api/hosts/:hostId` | Get host-specific config (directories, tmuxSession) |
| POST | `/api/control/pause` | Pause task distribution |
| POST | `/api/control/resume` | Resume task distribution |
| GET | `/api/capabilities` | Get recently used capabilities (name -> known values) |
| POST | `/api/capabilities` | Add a capability key (and optional value) |
| DELETE | `/api/capabilities/:name` | Remove a key, or one value with `?value=X` |
| POST | `/api/agents/register` | Register an agent (`capabilities` map, `workMode`, `assignedStoryId`, opaque `metadata`) |
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
- `Sources/App.swift` — SwiftUI menu bar app (`LSUIElement`). Status bar icon; start/stop/**restart** controls; **Open UI in a configurable browser**; team directory picker, **reveal in Finder**, and **open in a configurable terminal**; port config; and an app-**version** line (read from the bundle's `CFBundleShortVersionString`).
- `Sources/DaemonManager.swift` — Launches the bundled `mpt` binary as a subprocess, polls `/health` for status, manages preferences via `UserDefaults` (`teamDir`, `port`, `browserAppPath`, `terminalAppPath`).
- `Resources/mpt.entitlements` — Code-signing entitlements for the compiled Deno binary. Required for V8 JIT (`allow-jit`, `allow-unsigned-executable-memory`) and FFI SQLite loading (`disable-library-validation`).
- `Package.swift` — Swift package manifest (SwiftUI, macOS 13+). The `.app` bundle's `Info.plist` version is injected from `deno.json` by `scripts/package-macos-menubar.sh`, so the menu's version line stays in sync with the daemon.

### Code Signing (macOS)

The compiled `mpt` binary requires three entitlements when signed with hardened runtime:
1. **`com.apple.security.cs.allow-jit`** — V8 needs MAP_JIT for code generation
2. **`com.apple.security.cs.allow-unsigned-executable-memory`** — V8 CodeRange allocation
3. **`com.apple.security.cs.disable-library-validation`** — `@db/sqlite` loads a `.dylib` via FFI with a different Team ID

Without these, the binary crashes immediately with "Failed to reserve virtual memory for CodeRange" or "code signature not valid for use in process".

The [pi-pizza-team](https://github.com/timzen/pi-pizza-team) extension is a
**pure HTTP client** with zero server-side code. It owns no state — all data
lives in this daemon.

Extension structure:
```
src/
├── index.ts       — Role detection, flag registration, wiring
├── client.ts      — DaemonClient: unified HTTP client for all API calls
├── leader.ts      — Tmux management, directive polling, slash commands
├── teammate.ts    — TeammateLoop: poll → claim → execute → release
├── assistant.ts   — AssistantLoop: answers pending conversation turns
├── tools.ts       — LLM tool registration (role-specific)
├── permissions.ts — Dynamic yoloMode toggling
└── shared/types.ts — Minimal types (WorkflowConfig, constants)
```

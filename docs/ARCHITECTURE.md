# Architecture

## Overview

my-pizza-team is a Deno-based application organized into four main modules:

- **daemon/** — HTTP API server built with [Hono](https://hono.dev/) on Deno's native `Deno.serve()` adapter
- **cli/** — Command-line interface for interacting with the daemon
- **ui/** — Frontend application (React + Vite + shadcn/ui). Talks to the daemon's HTTP API.
  - `src/App.tsx` — Router + shell layout: `NavBar` on top, a scrollable `<main>` for the routed page, and a persistent `TeammateSidebar` on the right (shown on `lg+`). Pages: `/` + `/assistant` (RootPage — Inbox/Assistant tabs), `/context` (ContextPage), `/board`, `/tasks`, `/schedule`, `/work-defs/new`, `/work-defs/:id`, `/scratchpad`, `/task/:storyId/:taskId`, `/story/:id`, `/stories/new`, `/story/:id/tasks/new`, `/spawn`, `/backlog`, `/archived`, `/config` (+ `/config/:tab`), `/workflows` (+ `/workflows/:name`), `/help`. The NavBar surfaces the four primary destinations — **Board · Tasks · Schedule · Context** — plus scratch-pad/help/config/theme icons. Route-driven tab groups (RootPage's Inbox/Assistant, the Board's Board/Backlog/Archive/Workflows, ConfigPage's General/Teammates/Theme — Theme being a client-side palette preference, not daemon config) share `src/components/RouteTabs.tsx`.
  - `src/components/ThemeToggle.tsx` — Light/dark mode toggle (the `dark` class on `<html>`, persisted to `localStorage`). Palette selection lives on the Config page's Theme tab; `src/lib/theme.ts` owns the palette preference (the `data-theme` attribute, applied at startup by `main.tsx`). Palettes are CSS variable blocks in `index.css` (`html[data-theme="…"]` for light, `html.dark[data-theme="…"]` for dark; Default and Solarized) — adding a palette is two variable blocks plus a `PALETTES` entry.
  - `src/pages/RootPage.tsx` — Home (`/`). A **quick-create row** (new story / Solitary task / Scheduled job / spawn teammate) over two tabs: **Inbox** (`/`) and **Assistant** (`/assistant`). The Inbox (`src/pages/InboxPage.tsx`) is a paginated, unread-by-default review queue of terminal WorkItems (COMPLETE/FAILED; CANCELED excluded); each routes to its backing WorkDef's detail page **deep-linked to the Thread tab** (`?tab=thread`, since a completed run's outcome lives in the comments) — board tasks open `/task/:storyId/:id` (via the item's `parent`), standalone work opens `/work-defs/:id`. Foundational setup moved out of the root: **Workflows** is a Board sub-tab and **Context** is a top-level nav page.
  - `src/pages/TasksPage.tsx` / `src/pages/SchedulePage.tsx` — Standalone WorkDefs: **Solitary** one-shots (Tasks) and **Scheduled** cron jobs (Schedule). Both list `/api/work-defs` filtered by derived `type` (Board tasks are excluded); each row shows the aggregate run cost (`tokenUsage.totalCostUsd`) when present. Schedule joins `/api/schedules` for each job's cron + last-run (cron lives on the Schedule parent, not the WorkDef — see docs/WORKDEF_UNIFICATION.md). `src/pages/NewWorkDefPage.tsx` is the shared create form (`/work-defs/new?type=…` — fixed by the query param; Scheduled adds cron presets + auto-creates a Schedule, Solitary an "enqueue now" toggle). Acceptance criteria use an add-as-you-go list (`src/components/ui/acceptance-criteria-editor.tsx`) scored against **RFC 2119**. `src/pages/WorkDefDetailPage.tsx` is the view/edit page for standalone work; board tasks use the same format on `src/pages/TaskDetailPage.tsx` (see below). Both split the detail into two tabs below the title — **Details** (goal/criteria/context/directory) and **Thread** (the run thread — comments, newest first, with clickable attachments that open the diff/file viewer and an **Attach** button; uploads are ref-scoped so they work for Solitary/Scheduled too) — via the shared `src/components/ui/detail-tabs.tsx` (`useDetailTab` + `DetailTabBar`), which backs the selection on the `?tab=` query param so the Inbox can deep-link to `?tab=thread`. Details is the default.
  - `src/components/TeammateSidebar.tsx` — Always-visible right column with two sections: **Team** (connected agents grouped by role — leader `[L]`, assistant `[A]`, teammates `[Tn]` — each row showing status dot, current work, and **working directory** as the only work-selection signal; per-agent reset via `reset-session` directive → Pi's `/new`, and dismiss) and **Queue** (non-terminal WorkItems — READY/IN_PROGRESS/MORIBUND — with recovery actions: cancel a READY item, force-fail a MORIBUND one, or force-fail-and-re-enqueue). Also surfaces pending spawn requests. Collapses to a slim icon rail (role avatars + Spawn `+` + queue badge); the choice is persisted in `localStorage`.
  - `src/pages/SpawnPage.tsx` — Spawn page (`/spawn`; replaces the old spawn modal). Asks for host and an optional **working directory** (the pi process cwd) — teammates are a flat generalist pool, and this directory is the sole work-selection signal (directory affinity; see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md). No state picker, story binding, or capability list.
  - `src/pages/BoardPage.tsx` — Kanban board of story swimlanes. Task cards are **not** clickable as a whole; opening a task is an explicit action (the `details →` link opens the task page — there are no preview modals). A card shows a small chip for its active agent WorkItem (queued / working / at-risk). Headed by `src/components/board/BoardTabs.tsx`, a segmented control presenting Board / Backlog / Archive / Workflows as tabs of one surface; `/backlog`, `/archived`, and `/workflows` stay deep-linkable routes and render the same tabs. Built on `src/components/RouteTabs.tsx`, the shared route-driven segmented tab control. The NavBar's Board link highlights for all of them (and story/task detail).
  - `src/pages/NewStoryPage.tsx` — Story creation page (`/stories/new`; replaces the old modal): workflow, directory, context, inline task list. On success lands on the new story's page.
  - `src/pages/NewTaskPage.tsx` — Task creation page (`/story/:id/tasks/new`; replaces the old modal), linked from the board swimlane header and the story page. On success returns to where you came from.
  - `src/pages/TaskDetailPage.tsx` — Board-task page (`/task/:storyId/:taskId`). A board task **is a WorkDef** (parent = its story), so this page mirrors `WorkDefDetailPage`'s format: two tabs below the title (**Details** / **Thread**, via `detail-tabs.tsx`; deep-linkable through `?tab=thread`). Details edits the WorkDef fields (title, goal, acceptance criteria, additional context, directory, context) via `PUT /api/work-defs/:taskId`; Thread is the run thread (comments + attachments, **newest first**). Layered on top are the board-specific concerns — the story breadcrumb, the workflow status + move buttons (`POST /api/tasks/:taskId/move`), and delete via `DELETE /api/tasks/:taskId` (which also drops the task from the story's list + frees the CONWIP token). Thread attachments stay clickable, opening the diff/file viewer with line-level review; the composer keeps an **Attach** button. Because editing goes through the WorkDef path, `store.updateWorkDefDetails` syncs the `tasks` cache (title/goal/context) so the board reflects edits without a reload.
  - `src/pages/StoryDetailPage.tsx` — Story page (`/story/:id`). Home for story editing (title, description, requirements, paused, delete) plus a linked task list. Reached by clicking a story title on the board. Requirements are edited with `RequirementsEditor` as key/value capabilities.
  - `src/components/board/RequirementsEditor.tsx` — Edits a story's requirements as key/value capability badges (add/remove), with name/value suggestions sourced from `/api/capabilities` (recently used capabilities). Mirrors the settings "Recent Capabilities" editor and the teammates capability badges.
- **shared/** — Types, utilities, and constants shared across modules

## Module Map

### daemon/
- `main.ts` — Entry point. Reads PORT/HOST/TEAM_DIR from env, validates bind safety, starts `Deno.serve()`.
- `app.ts` — Creates the Hono application, wires Store to routes. Merges user config with defaults.
- `server.ts` — Builds the Hono app with route context (store, config, helpers). Applies auth middleware when token is configured.
- `workflow-engine.ts` — Workflow position logic for the state model (docs/WORK-MODEL.md): `activeStateNames()`, `isAgentState()`, `firstActiveState()`, `nextState()`, `boardColumns()`, `isValidPosition()`, `validateWorkflow()`. No transition matrix, no permission checks.
- `cron.ts` — vendored 5-field cron parser (`parseCron`/`cronMatches`/`isCronDue`/`isValidCron`) for Scheduled WorkDefs.
- `token-cost.ts` — **fallback** token-cost estimator (rough per-1M-token price table) used only when the harness doesn't report a cost. Harnesses that know the real, cache-aware cost (pi's `usage.cost.total`, the number its powerline footer shows) send `costUsd` and the daemon stores it verbatim.
- `store.ts` — SQLite data layer using `jsr:@db/sqlite`. Manages schema, CRUD for stories/members/comments, workflow validation, JSON file sync, autosave timers, and heartbeat/turn/cron timers. Every unit of work is a **WorkDef** (`tasks/<id>/workdef.md`); a **Story** (`stories/<id>.json`) is a grouping that owns order + status via `tasks: [{id,status}]`, and a **Schedule** (`schedules/<id>.json`) is a cron parent (see docs/WORKDEF_UNIFICATION.md). The internal `tasks` table is a runtime cache of board WorkDefs (those parented to a story). Also owns the **WorkItem queue** — the unit of agent execution: admission enqueues a `READY` WorkItem when a task lands in an agent state; `getNextWorkItem()` matches by **directory affinity** (my-dir → no-dir → other-dir-if-no-online-agent-has-it); `claimWorkItem`/`setWorkItemState` drive the terminal-only lifecycle (COMPLETE advances the board task, FAILED leaves it stuck), and the heartbeat reaper moves in-flight items to `MORIBUND`. A single **`enqueueFor(workDefId)`** is the one WorkItem creator; the **cron scheduler** (`runScheduler`) fires each due Schedule's child WorkDefs through it. The scheduler is **readiness-gated**: a due child whose target host is not ready (see `setHostReadiness`/`canScheduleForDirectory` and the "Scheduler readiness gating" design note) is *held* instead of enqueued, flagging the Schedule `heldForReadiness` so it re-fires exactly once when the host recovers (no per-occurrence backlog). Self-contained concerns are split into `store/`:
  - `store/workdefs.ts` — on-disk IO for **WorkDefs** (authored markdown+frontmatter under `tasks/<id>/`, with per-def `comments.jsonl`); frontmatter carries only structural metadata (title, `parent`, directory, contextRefs).
  - `store/schedules.ts` — flat cron **Schedule** files (`schedules/<id>.json`: cron + lastEnqueuedAt + optional `heldForReadiness` marker set when a due occurrence was held because its target host wasn't ready).
  - `store/context.ts` — context library (reusable prompt/context entries as markdown files under `context/`, with `title`/`description`/`tags` frontmatter). Entries can be **attached to stories/tasks** (`story.context` / `task.context`); `store.resolveTaskContext()` merges + dedupes them for prompt injection.
  - `store/scratchpad.ts` — personal scratch pad kept as plain files under the team dir (no SQLite): `todo.jsonl` (one `{status,item,created,completed}` per line, addressed by index) + `notes.md` (free-form markdown).
  - `store/git-sync.ts` — optional git checkpointing of the team directory.
- `auth.ts` — Optional API token authentication. Bearer tokens, Basic auth (for web UI), and query param fallback. Enforces bind safety (refuses 0.0.0.0 without token).
- `routes/agents.ts` — Agent protocol (WorkItem-centric): register (with a working `directory`), heartbeat, next-work (returns `{ workItem }`), claim (lease + daemon-assembled prompt), the single **state-setter** (`work-items/:id/state` → COMPLETE|FAILED), work-item comments/token-usage/attachments (resolved to the backing ref), and per-host leader directives. Token-usage prefers the harness-reported `costUsd` (accurate + cache-aware) and estimates only as a fallback; it's recorded on the ref, so board **and** standalone runs are tracked. No `done`/`release`/`return` — the daemon offers primitives; "giving up" is a comment + FAILED composed by the agent.
- `routes/work.ts` — WorkItem queue: list (filter/paginate — powers Inbox + sidebar), cancel (READY), force-fail (MORIBUND, optional re-enqueue), read/unread, re-enqueue by ref.
- `routes/work-defs.ts` — WorkDef CRUD + enqueue ("save without enqueueing" = `enqueue:false`) + the ref-scoped surface for **any** WorkDef: comments, attachments (upload/list/serve/delete), and token-usage. This is the canonical UI surface for board tasks too (a board task is a WorkDef).
- `prompt.ts` — `buildTaskPrompt()`: assembles the canonical task prompt (**state persona** → Story → working-directory instruction (cd + read that repo's AGENTS.md) → Task → reference context → prior-task context → lead comments → completion guidance). The state persona is the markdown at `workflows/<wf>/<state>.md` — role framing for whoever works that state. There are no transition instructions: workers never move tasks (docs/WORK-MODEL.md). **Reference context** is the set of context-library entries attached to the story and/or task (resolved + deduped by `store.resolveTaskContext`), inlined verbatim so every harness gets the same material. Session-specific framing is intentionally excluded — that belongs to a stateful harness, not the shared prompt. Also exports `normalizeInstructionMarkdown()`, which demotes authored headings (fence-aware) so they nest under the prompt's own `##` sections and can't mangle its structure.
- `workflow-lint.ts` — `validateInstructionMarkdown()`: lints authored state-instruction markdown. Unbalanced code fences are **errors** (they'd swallow the rest of the prompt) and block the save; shallow headings and stray `---` rules are **warnings** (the prompt builder normalizes headings anyway).
- `routes/tasks.ts` — Story-parent task operations: create-in-story, reorder, move (lead), delete. Board-only attachments + token-usage routes are kept here for mpt-mcp-server; comments moved to the ref-scoped `/api/work-defs/:id/comment(s)`. See docs/WORKDEF_UNIFICATION.md “Route surface.”
- `routes/stories.ts` — Story CRUD, archive, backlog.
- `routes/shared.ts` — Health, status, config, control (pause/resume), hosts, workflow management.
- `routes/assistant.ts` — Assistant **chat** (append-only user/assistant messages) + the agent-facing response **turn** protocol, and the assistant **persona**. The chat is a real conversation: sending a user message just appends it; replies are produced by a coalescing response *turn* the assistant polls/claims/streams-into/completes (see DESIGN.md "Assistant chat model"). The vended `systemPrompt` is always `ASSISTANT_CHAT_FRAMING` (chat/batching rules + the `send_message` tool contract) followed by the persona body — or `DEFAULT_ASSISTANT_PERSONA` when none is selected — so the chat behavior is system-level and no persona needs to restate it. Swapping the persona clears + resets the session.
- `routes/context.ts` — Context library CRUD (`/api/context`) over `store/context.ts`.
- `routes/scratchpad.ts` — Personal scratch pad (`/api/scratchpad`): todos (add/toggle/delete by index) + notes, over `store/scratchpad.ts`.

### cli/
- `main.ts` — CLI entry point (start/stop/status/install/uninstall/rotate-token/upgrade). Exposes `main()` for the compiled binary and runs directly under `deno run`. `upgrade` self-updates the compiled binary from the latest GitHub release (`timzen/my-pizza-team`): it maps the platform to the release asset (`mpt-<os>-<arch>`), verifies against `checksums.sha256`, atomically replaces `Deno.execPath()` in place, and — when a service is installed — restarts it via the service manager (warning if the service points at a different binary). Refuses when run from source (`deno run`), where the executable is `deno` itself.
- `service.ts` — Platform service installer/uninstaller. Generates macOS launchd plists or Linux systemd unit files for auto-start on login (embedding the binary's absolute path at install time). `detectInstalledService()` locates an installed plist/unit, parses the launched binary path, and exposes a `restart()` (launchctl kickstart / systemctl --user restart) used by `mpt upgrade`.

### shared/
- `types.ts` — Shared TypeScript interfaces (TeamConfig, Story, Task, Member, `WorkItem`/`WorkItemState`/`WorkItemRef`, `WorkDef`/`WorkDefType`, etc.) and utilities (slugify, generateTeammateName, `normalizeDirectory`). Matching is directory-affinity only — there is no capability/requirements model.
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
- **Story-owned order + status** — A task's `id` (stable key), `title` (name), and position are separate concerns. The story owns order *and* workflow position in one list: `tasks: [{id, status}]` in `stories/<id>.json`. A board task is a WorkDef whose `parent` is the story; its directory is `tasks/<id>/`, named by id only, so the folder never encodes order and never drifts when the title changes. A reorder or advance rewrites one file (great for git), needs no directory renames, and `loadFromDisk` reconciles the list against the WorkDefs actually present so hand-edits are tolerated. See DESIGN.md / WORKDEF_UNIFICATION.md.
- **Comments append to JSONL** — Never lost; append-only file per task.
- **Assistant chat model (turns, not pairs)** — The assistant chat is append-only messages decoupled from response *turns*. A user message is just appended (`sent`); it does **not** create a paired assistant placeholder. A response turn is the job of replying to the batch of unanswered user messages: the agent polls one, claims it (which flips those messages to `read` — read receipts), streams any number of bubbles via `send_message` (`.../say`), then completes. Only one turn processes at a time and the composer locks while it runs, so there's no message enqueue/ordering to reason about. Rapid user messages coalesce into one turn's prompt. A **pre-claim debounce** (`assistantTurnDebounceSeconds`, default 5s) holds the turn until the user has been quiet — no new message and no typing ping (`POST /api/assistant/typing`, sent by the composer) — so the assistant never grabs a message while the user is still typing a follow-up. A stuck-turn timeout (`assistantTurnTimeoutSeconds`, default 300s, reaped alongside agent heartbeats) fails an abandoned turn so the composer can't lock forever. See DESIGN.md.
- **"Teammates", not "Agents", in the UI** — The product is my-pizza-team, so human-facing vocabulary settled on "Teammates". The HTTP API and internal types keep the technical term `agent`/`member` (the route stays `/api/agents`). Teammates are shown in a persistent right-hand sidebar rather than a dedicated page.
- **Pages over modals** — The board is for glancing and light triage (drag a card to another column to move it). Clicking a card never opens an editor; the `details →` link opens the task page, and all reading/editing/creating lives on dedicated pages (`/task/:storyId/:taskId`, `/story/:id`, `/stories/new`, `/story/:id/tasks/new`, `/spawn`) — deep-linkable, roomy, and browser-back friendly. The only surviving modal is the FileViewer (a lightbox-style artifact/attachment viewer). This keeps destructive/edit actions off the high-traffic board surface. Cards carry no state badge (the column names the state) — only the substatus chip; drops only accept cards from the same story (the drag MIME type carries the story id). Each swimlane can hide the implicit todo/done bucket columns (persisted per story in `localStorage`); hidden buckets show their task counts in the story header.
- **Distinct panel color for chrome** — The nav header and story headers use `bg-muted` (not `bg-card`) so they read as a distinct panel against the page background in both light and dark themes.
- **Scheduler readiness gating** — Credentials/VPN/network are a whole-*host* fact, so readiness is a host property, not a per-teammate or per-directory one. Each host's **leader** (the per-host singleton) runs an optional probe and reports the result via `POST /api/hosts/:hostId/readiness`; the daemon holds it in memory (ephemeral connection state, like members — an unknown host is treated as ready). The cron scheduler consults it: a due scheduled child is **held** (not enqueued) when *every* host that could run it (directory affinity rolled up to `hostId`) is not-ready, so a wedged cloud desktop (e.g. expired `mwinit`) stops piling up FAILED scheduled runs overnight. Holding sets `heldForReadiness` on the Schedule and *doesn't* advance the cron cursor via that path, so when the host recovers the scheduler fires the held job **exactly once** (missed occurrences collapse into a single catch-up run — no thundering herd). This gates *only* the cron scheduler: Solitary/board work is human-initiated and still runs (and may fail visibly). Absent (offline) hosts are not gated — readiness is about connected-but-unable hosts; the queue waits for a connection as before.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (uptime, agents, queueDepth, memory, lastCommitTime, tmuxSession, leaderPresent, hostsNotReady) |
| GET | `/api/status` | Status summary (stories, tasks, members) |
| GET | `/api/stories` | List all stories with tasks |
| POST | `/api/stories` | Create a new story (with optional tasks) |
| PUT | `/api/stories/:id` | Update story details |
| DELETE | `/api/stories/:id` | Delete a story |
| POST | `/api/stories/:id/archive` | Archive a completed story |
| POST | `/api/stories/:id/backlog` | Move story to backlog |
| POST | `/api/stories/:storyId/tasks` | Add a task to a story |
| POST | `/api/stories/:storyId/tasks/reorder` | Reorder a story's tasks (`{ order: [taskId, ...] }`) |
| POST | `/api/tasks/:id/move` | Judgment move (human/leader): put a task anywhere in its workflow; entering an agent state resets substatus + clears the lease |
| PUT | `/api/tasks/:id` | Update task title/description (legacy; edits also go through `PUT /api/work-defs/:id`) |
| DELETE | `/api/tasks/:id` | Delete a task (drops it from the story + frees the CONWIP token) |
| POST/GET/DELETE | `/api/tasks/:id/attachments[/:filename]` | Board-task attachments (kept for mpt-mcp-server; the web UI uses the ref-based `/api/work-defs/:id/attachments`) |
| POST | `/api/tasks/:id/token-usage` | Record token usage (kept for mpt-mcp-server; ref-based equivalent is `/api/work-defs/:id/token-usage`) |
| GET | `/api/archived` | List archived stories |
| GET | `/api/backlog` | List backlogged stories |
| POST | `/api/backlog/:id/restore` | Restore from backlog |
| GET | `/api/assistant/messages` | Get the conversation + active turn (`{messages, activeTurn}`). User messages carry `sent`/`read` (read receipts); `activeTurn` (processing) drives the UI typing indicator + composer lock |
| POST | `/api/assistant/messages` | Append a user message (status `sent`; no assistant placeholder — a turn produces replies) |
| POST | `/api/assistant/typing` | UI typing-presence ping; re-arms the pre-claim debounce so the assistant waits until the user goes quiet |
| DELETE | `/api/assistant/messages/:id` | Delete a single message |
| DELETE | `/api/assistant/messages` | Clear the conversation + turns (also resets the assistant session) |
| GET | `/api/assistant/persona` | Get the active persona + effective system prompt (`{personaId, entry, systemPrompt}`; `systemPrompt` = chat framing + persona/default) |
| PUT | `/api/assistant/persona` | Swap the persona (clears + resets the session); `personaId: null` = default |
| GET | `/api/assistant/next` | Agent: get the next response turn (`{id, prompt}`); null while one is processing, nothing is unanswered, or the pre-claim debounce hasn't elapsed. Prompt = all unanswered user messages, coalesced |
| POST | `/api/assistant/messages/:id/claim` | Agent: claim a turn (-> processing); flips its coalesced user messages to `read` |
| POST | `/api/assistant/messages/:id/say` | Agent: append one chat bubble to the active turn (the `send_message` tool — call repeatedly to batch) |
| POST | `/api/assistant/messages/:id/complete` | Agent: close the turn; `result` is a fallback bubble used only if the turn sent none via `say` |
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
| POST | `/api/hosts/:hostId/leader/directives` | Create a leader directive (spawn, reset-session, ...). For `spawn`, the daemon assigns `params.name` if absent: a generated adjective-noun for teammates, or the reserved singleton name `assistant` for `reason: "assistant"` (a duplicate assistant spawn is coalesced onto the existing member/pending spawn, not duplicated) |
| GET | `/api/hosts/:hostId/leader/directives` | Poll pending directives for a host (single leader queue) |
| PUT | `/api/hosts/:hostId/leader/directives/:id` | Update a directive's status (e.g. `done`) |
| GET | `/api/spawn-requests` | List pending `spawn` directives across all hosts (name, cwd, hostId, createdAt) — surfaces stuck spawns in the UI |
| DELETE | `/api/spawn-requests/:id` | Cancel a pending spawn request (marks it `cancelled` so the leader stops retrying) |
| GET | `/api/workflows` | List workflow summaries (name, stateCount, agentCount, manualCount, isDefault) |
| GET | `/api/workflows/:name` | Get full WorkflowConfig for a workflow |
| GET | `/api/workflows/:name/instructions/:filename` | Read a workflow instruction markdown file |
| PUT | `/api/workflows/:name/instructions/:filename` | Write/update a workflow instruction markdown file. Lints content: unbalanced code fences are errors (rejected, 400); shallow headings / `---` return `warnings` on success. |
| GET | `/api/config` | Get current config |
| GET | `/api/hosts/:hostId` | Get host-specific config (directories, tmuxSession) + last-reported `readiness` |
| POST | `/api/hosts/:hostId/readiness` | Report a host's readiness (`{ ready, reason? }`) — the host's leader runs a probe; a not-ready host holds scheduled work destined for it |
| GET | `/api/hosts-readiness` | List all reported host-readiness records (`{ hosts }`) |
| POST | `/api/control/pause` | Pause task distribution |
| POST | `/api/control/resume` | Resume task distribution |
| POST | `/api/agents/register` | Register an agent (working `directory`, opaque `metadata`, `hostId`) |
| POST | `/api/agents/heartbeat` | Agent heartbeat (restores this agent's MORIBUND items to IN_PROGRESS) |
| GET | `/api/agents/next-work?agentId=X` | Poll for a `READY` WorkItem by directory affinity; `{ workItem: null }` when none |
| POST | `/api/agents/claim/:workItemId` | Lease a READY WorkItem (→ IN_PROGRESS) and get the daemon-assembled prompt |
| POST | `/api/agents/work-items/:workItemId/state` | Set COMPLETE (advances a task ref) or FAILED (leaves it stuck) |
| POST | `/api/agents/work-items/:workItemId/token-usage` | Record token usage on the ref (any WorkDef); prefers harness `costUsd`, else estimates |
| POST | `/api/agents/work-items/:workItemId/attachments` | Upload an attachment (resolved to the backing ref) |
| GET | `/api/agents/comments/:workItemId` | Get comments on the WorkItem's ref |
| POST | `/api/agents/comments/:workItemId` | Post a comment on the WorkItem's ref |
| GET | `/api/agents` | List all registered agents |
| DELETE | `/api/agents/:id` | Unregister an agent |
| GET | `/api/work-items` | List WorkItems (`?state=`, `?read=`, `?limit=&offset=`) — powers Inbox + sidebar |
| POST | `/api/work-items/:id/cancel` | Cancel a READY item |
| POST | `/api/work-items/:id/force-fail` | MORIBUND → FAILED (`{ reEnqueue? }`) |
| POST | `/api/work-items/:id/read` | Mark read/unread (`?read=false`) |
| POST | `/api/work-items/re-enqueue` | Create a fresh READY item for a ref with none active (`{ ref }`) |
| GET/POST | `/api/work-defs` | List / create WorkDefs (create enqueues unless `enqueue:false`) |
| GET/PUT/DELETE | `/api/work-defs/:id` | Get / update / delete a WorkDef |
| POST | `/api/work-defs/:id/enqueue` | Enqueue a READY WorkItem for the def |
| GET/POST | `/api/work-defs/:id/comment(s)` | Per-def comment thread (ref-scoped; the canonical UI comment routes for **all** WorkDefs incl. board tasks) |
| POST/GET/DELETE | `/api/work-defs/:id/attachments[/:filename]` | Ref-scoped attachments for **any** WorkDef (board/Solitary/Scheduled) — upload, list, serve raw, delete |
| POST | `/api/work-defs/:id/token-usage` | Record token usage on the ref (works for any WorkDef); prefers harness `costUsd`, else estimates |

## Agent Lifecycle

Agents use a poll → claim → set-state loop over **WorkItems** (the unit of agent
execution). Workers never move tasks: the daemon owns admission (CONWIP), advance,
and the WorkItem lifecycle. See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.

```
1. Poll  GET  /api/agents/next-work        → a READY WorkItem (directory affinity)
2. POST /api/agents/claim/:workItemId       → lease (→ IN_PROGRESS) + daemon prompt
3. Agent does the work (cd to the ref's directory)
4a. POST .../work-items/:id/state COMPLETE  → daemon advances the task (task refs)
4b. comment + .../state FAILED              → give up: task left stuck for a human
5. Agent polls again (repeat)
```

A WorkItem only ever moves toward a terminal state (COMPLETE/FAILED/CANCELED);
`MORIBUND` is the reaped-but-not-dead state (restored on reconnect, or
force-failed by a human). Rework is a judgment move back into an agent state,
which enqueues a fresh READY WorkItem — re-entry is indistinguishable from first
entry. Manual states (e.g. review) belong to humans/the leader.

Members and assignments are **connection state, not durable records**: they live
in SQLite for the running process but are cleared on daemon boot
(`resetConnectionsForBoot`), since a freshly-started daemon holds zero live
connections. Without this, a restarted daemon would list the previous run's
agents as "offline" forever. Agents re-register on reconnect; any WorkItem left
IN_PROGRESS across the restart is moved to `MORIBUND` (its `member_id` kept, so
the same agent can still complete it or a human can recover it).

Comments live on the **ref** (per-task for story tasks, per-def for WorkDefs),
not on the WorkItem. Agents load them when starting work.

## Pi Extension (Thin Adapter)

### desktop/macos/
- `Sources/App.swift` — SwiftUI menu bar app (`LSUIElement`). Status bar icon; start/stop/**restart** controls; **Open UI in a configurable browser**; team directory picker, **reveal in Finder**, and **open in a configurable terminal**; **Launch Leader** via a configurable command (shown only when the daemon is up and no leader is connected); port config; and an app-**version** line (read from the bundle's `CFBundleShortVersionString`).
- `Sources/DaemonManager.swift` — Launches the bundled `mpt` binary as a subprocess, polls `/health` for status (including `tmuxSession` and `leaderPresent`), manages preferences via `UserDefaults` (`teamDir`, `port`, `browserAppPath`, `terminalAppPath`, `leaderCommand`). The leader command is a soft, editable default (`tmux new-session … pi --ppt-lead`) with `{session}`/`{dir}`/`{port}`/`{url}` placeholders — so the app has no hard dependency on the pi harness.
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
├── assistant.ts   — AssistantLoop: works response turns (poll → claim → stream bubbles → complete)
├── tools.ts       — LLM tool registration (role-specific)
├── permissions.ts — Dynamic yoloMode toggling
└── shared/types.ts — Minimal types (WorkflowConfig, constants)
```

# Architecture

What is where, and how the pieces talk. The rationale behind these choices is in
[DESIGN.md](DESIGN.md); this document is the map.

## Overview

my-pizza-team is one repository producing one binary, `mpt`:

- **daemon/** — HTTP API server: [Hono](https://hono.dev/) on `Deno.serve()`, a SQLite runtime index over plain files, tmux supervision, and timers (heartbeat reaper, scheduler, autosave, readiness probe, spawn realization).
- **cli/** — the `mpt` command: start/stop the daemon, `setup`, `doctor`, `lead`, `upgrade`, service install.
- **ui/** — the web UI (React + Vite + shadcn/ui), built into `ui/dist/` and served by the daemon.
- **shared/** — types, protocol contracts, and constants shared by the daemon, CLI, and (via generation) the Pi extension.
- **harnesses/pi/** — the Pi extension: a Node/npm package with its own `tsconfig.json`, `package.json`, and tests. Its source is embedded in `mpt` and written out by `mpt setup`.
- **agent/** — `mpt agent`, the supervisor that runs an experimental non-Pi teammate (Kiro, Claude Code) over the Agent Client Protocol.
- **desktop/** — optional tray/menu-bar apps (macOS SwiftUI, Windows PowerShell).
- **scripts/** — build, packaging, release, and code generation.
- **tests/** — the fast suite (`deno task test`) and `tests/e2e/` (`deno task test:e2e`).

```
            ┌──────────── mpt (one binary) ─────────────┐
 browser ──▶│ Hono routes ─▶ Store ─▶ SQLite (state.db) │
            │                  │    └▶ team dir files    │──▶ git (autosave)
            │ timers: reaper · pool · scheduler · probe  │
            │ spawner ─▶ tmux windows ───────────────────┼──▶ pi (leader, teammates)
            └────────────────────────────────────────────┘        │
                    ▲  HTTP: register · poll · claim · state ·    │
                    └──── chat mirror · transcript · usage ───────┘
```

## Data model and storage

The **team directory** (`.my-pizza-team/`) is the record; SQLite (`state.db`) is a
runtime index rebuilt from it. Everything under the team dir except runtime files is
committed by autosave.

| Path | Contents | Source of truth |
|---|---|---|
| `config.json` | Team config (`TeamConfig`) | file |
| `workflows/<name>/workflow.json` | `{ states: [{name, type}] }` | file |
| `workflows/<name>/<state>.md` | Persona for an agent state | file |
| `stories/<id>.json` | Story: title, description, workflow, directory, context, paused, dependsOn, `tasks: [{id, status}]` | file (indexed in SQLite) |
| `tasks/<id>/workdef.md` | A WorkDef: frontmatter (title, `parent`, directory, contextRefs, `status: archived`) + `## Goal` / `## Acceptance Criteria` / `## Additional Context` | file (board ones cached in the `tasks` table) |
| `tasks/<id>/comments.jsonl`, `attachments/` | The WorkDef's thread and files (append-only comments) | file |
| `schedules/<id>.json` | Cron parent: cron, lastEnqueuedAt, `heldForReadiness?` | file |
| `templates/<id>/template.md` | Task Template (WorkDef format, never enqueued) | file |
| `archived/<id>.json`, `backlog/<id>.json` | Archived (with synopsis) / backlogged stories | file |
| `context/<id>.md` | Context-library entry (title/description/tags frontmatter) | file |
| `thoughts/<id>.md`, `groups.json` | Thoughts notes and groups | file |
| `assistant/sessions/<id>.md` | Chat session transcripts | file (messages live in SQLite) |
| `usage/YYYY-MM.jsonl` | Token-usage ledger, one line per run | file (cached in `token_usage`) |
| `state.db` (+ `-wal`, `-shm`) | SQLite: index, WorkItems, members, directives, chat | runtime |
| `daemon.pid` | The running daemon's PID | runtime |
| `daemon.log`, `daemon.log.1` | A background daemon's output (`mpt start --daemon`): this run, and the one before | runtime |
| `.gitignore` | Written by mpt to exclude the runtime files | file |

**Runtime-only state** (SQLite or memory, never committed): the WorkItem queue,
members and assignments (cleared on boot), leader directives, chat messages and
receipts, transcripts (memory), pairing intent (memory), readiness (memory), spawn
capability (memory). Stories and board tasks are flushed to disk on a timer via a
`dirty` flag; comments and usage are appended immediately.

**WorkItem lifecycle:**

```
READY ──claim──▶ IN_PROGRESS ──▶ COMPLETE | FAILED        (terminal)
  │                  │  ▲
  └─cancel─▶ CANCELED  reaper/boot ▼ │ heartbeat
                     MORIBUND ──force-fail──▶ FAILED (+ optional fresh READY)
```

A board task's position changes cancel its active WorkItem; landing in an agent
state enqueues a new one. When every task in a story reaches `done` the story is
marked done; moving one back out reopens it.

## Module Map

### daemon/

- `start.ts` — `startDaemonInProcess`: **the one startup routine**, used by `mpt start` (foreground and the `--daemon` child), the compiled binary, and `main.ts`. Creates the app, validates bind safety, writes the PID file, registers signal handlers, serves, then probes spawn capability (and, if tmux is reachable, runs `realizePending` every 2s) and starts the readiness loop. Also `resolveTeamDir` (TEAM_DIR as the dir or its parent; else `./.my-pizza-team`), shared with the CLI.
- `main.ts` — Entry point for `deno task dev`/`start`: a thin call into `start.ts`, so the dev daemon is the real daemon.
- `app.ts` — `createApp(teamDir)`: merges `config.json` over `DEFAULT_CONFIG`, constructs the Store, loads from disk, starts timers, builds the app. Without a team dir, a health-only app.
- `server.ts` — `buildApp()`: auth middleware (when a token is configured), static UI serving, and registration of every route module with a shared `RouteContext` (store, config, teamDir, pause flag).
- `auth.ts` — Optional API-token auth: Bearer, Basic (for the browser), and a query-param fallback. `validateBindSafety` refuses a non-localhost bind without a token. `MPT_API_TOKEN` overrides `config.apiToken`.
- `static.ts` — Serves `ui/dist/` (or `UI_DIST`) with SPA fallback to `index.html`.
- `lifecycle.ts` — PID file, SIGTERM/SIGINT handling, flush-and-close on exit, and `redirectOutputToLog` (a background daemon's console → `daemon.log`, the previous run's kept as `daemon.log.1`, uncaught errors included).
- `store.ts` — The Store: SQLite (`node:sqlite` `DatabaseSync`) plus file sync. Owns schema and migrations, story/task CRUD and ordering, CONWIP admission and advance (`setTaskPosition`, `advanceTask`), the **WorkItem queue** (`enqueueFor` — the single creator; `getNextWorkItem` — directory affinity; `claimWorkItem`; `setWorkItemState`; cancel/force-fail/re-enqueue), members and heartbeats (`reapOfflineAgents`, `dismissMember` tombstones), leader directives, the teammate pool (`reconcileTeammatePool`), team readiness and the cron scheduler (`runScheduler`, readiness-gated), archive/backlog, attachments, context resolution (`resolveTaskContext`), and config persistence (`saveConfig` → `serializeConfig`, the single writer). Timers (`startTimers`): flush + autocommit, a 30s tick (reap → refresh chat snapshot → reconcile pool), and a 30s scheduler tick. Self-contained concerns live in `store/`:
  - `store/workdefs.ts` — WorkDef markdown IO (`serializeWorkDef`/`parseWorkDef`) and per-def comments.
  - `store/schedules.ts` — Schedule JSON files.
  - `store/templates.ts` — Template IO (reuses the WorkDef serializer; files only, no index).
  - `store/context.ts` — Context-library markdown entries.
  - `store/thoughts.ts` — Thought notes and `groups.json` (files only). A group is a spatial rectangle; membership lives on each note's `groupId`.
  - `store/assistant-chat.ts` — The chat: sessions, messages, receipts, the agent inbox, the ephemeral reasoning buffer, and SSE fan-out. At most one session is `active`.
  - `store/assistant-snapshots.ts` — Session markdown transcripts (reasoning excluded).
  - `store/transcripts.ts` — Live teammate transcripts: in-memory per-member ring buffers (500 entries) of keyed upserts, viewer tracking with a 30s grace, `watch` markers.
  - `store/pairing.ts` — Web pairing intent: paired flag, message outbox, pending release; drained exactly-once by the agent's poll.
  - `store/usage.ts` — The usage ledger: append to `usage/YYYY-MM.jsonl`, rebuild the `token_usage` cache on boot (`syncUsageLedger`), `dailyUsage` / `runsOnDay` rollups in the client's timezone.
  - `store/git-sync.ts` — Autosave: `git add/commit -- <teamDir>` (pathspec-limited, so the user's own staged work is never included), push if a remote exists, and `ensureTeamGitignore`. All failures non-fatal.
- `workflow-engine.ts` — Position logic: `activeStateNames`, `isAgentState`, `firstActiveState`, `nextState`, `boardColumns`, `isValidPosition`, `validateWorkflow`.
- `workflow-lint.ts` — `validateInstructionMarkdown`: unbalanced fences are errors; shallow headings and `---` are warnings.
- `prompt.ts` — `buildTaskPrompt` (see DESIGN.md "The Daemon Owns the Prompt") and `normalizeInstructionMarkdown` (fence-aware heading demotion).
- `cron.ts` — Vendored 5-field cron parser (`parseCron`, `cronMatches`, `isCronDue`, `isValidCron`).
- `token-cost.ts` — Fallback cost estimator, used only when a harness reports no `costUsd`.
- `tmux.ts` — tmux control via argv arrays (no shell): session/window create, list, kill, `send-keys`, `shellQuote`, `renderTemplate` (placeholders `{name}`, `{url}`, `{cwd}`, `{session}`, `{window}`, and `{mpt}` — how to run this mpt), and `tmuxUnavailableReason`.
- `self.ts` — `mptInvocation()`: the argv that runs this mpt again (the binary, or `deno run … cli/main.ts` from source), for `mpt start --daemon`'s child and the `{mpt}` placeholder; `isRunningFromSource()`.
- `spawner.ts` — `probeSpawnCapability` (once at startup) and `realizePending`: turns pending `spawn`/`dismiss` directives into tmux windows using the harness templates (built-ins overridden per harness by config); an unrealizable directive — including an experimental harness on a team that hasn't opted in — is marked `failed` with its reason. Other actions are left for the leader.
- `readiness.ts` — `runProbe` (timeout-bounded `sh -c`, which also survives a hung child on Linux) and `startReadinessLoop` (every 30s; nothing configured → never reports → ready).
- `routes/types.ts` — `RouteContext`.
- `routes/shared.ts` — Health, status, pause/resume, config (GET/PUT; PUT also saves workflows), the teammate pool, readiness, and workflows.
- `routes/stories.ts` — Story CRUD, archive, backlog/restore.
- `routes/tasks.ts` — Story-parent task operations: create-in-story, reorder, move, delete.
- `routes/work-defs.ts` — WorkDef CRUD, enqueue, archive/restore, and the ref-scoped surface for **every** WorkDef: comments, attachments, token usage.
- `routes/work.ts` — WorkItem queue reads (list/one) and recovery actions (cancel, force-fail, read, re-enqueue).
- `routes/schedules.ts` — Schedule CRUD (children are WorkDefs).
- `routes/templates.ts` — Template CRUD.
- `routes/agents.ts` — The agent protocol: register (version handshake, and the experimental-harness gate — `experimentalGate`), heartbeat (`reregister`/`dismissed` signals), next-work, claim, the single state-setter, work-item comments/attachments (resolved to the ref), agent list/delete, self-directives, leader directives, spawn requests.
- `routes/assistant.ts` — The chat: conversation reads/writes, SSE stream, the agent mirror surface (inbox/ack, bubbles, thoughts, session report), sessions (list/new/resume/snapshot), persona.
- `routes/transcripts.ts` — Teammate transcript SSE (subscribing registers a viewer), the agent's watch poll and batched POST, and a snapshot.
- `routes/pairing.ts` — Pair / message / release (UI), pairing state, and the draining agent poll. Pi teammates only (ACP teammates don't poll it yet).
- `routes/usage.ts` — Usage reports from any run, and the dashboard's daily/day rollups.
- `routes/context.ts`, `routes/thoughts.ts` — Thin CRUD shells over their store modules.

### cli/

- `main.ts` — Command dispatch and most commands (`agent` and `setup --harness` route to `agent.ts`): `start` (foreground, or `--daemon` re-launches itself detached — as `deno run …` when running from source — with `start --foreground-internal`, which logs to `daemon.log` via `redirectOutputToLog`; the parent waits for the PID file, or reports that the child exited and where its log is), `stop`, `status`, `rotate-token`, `install`/`uninstall` (service), `upgrade`, `doctor`, `setup`, `lead`, and the hidden `write-extension-internal`. `cmdLead` renders the harness's `leader` template, opens the fixed `leader` window in the project directory, and attaches (or `select-window` when already inside tmux); an existing window is attached rather than duplicated. `upgrade` maps the platform to a release asset (`mpt-<os>-<arch>`), verifies `checksums.sha256`, atomically replaces the executable, runs the new binary's `write-extension-internal` to refresh the managed extension, and restarts an installed service. The GitHub API call sends `MPT_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` when set (to `api.github.com` only); on any API failure (typically a rate-limit 403) it falls back to the unauthenticated `github.com/<repo>/releases/latest` redirect and constructs `/releases/download/<tag>/<asset>` URLs. Refuses when run from source.
- `setup.ts` — `planSetup()` (pure: decides what to change, including conflict resolution between managed, dev-checkout, and legacy registrations), settings mutation (atomic, preserving unowned fields), and the `SetupManifest` that `--uninstall` replays.
- `doctor.ts` — Gathers facts and `evaluate()`s them (pure) into a checklist: Pi (vs `TESTED_PI_VERSION`), tmux, Pi settings, extension registration and version, permission system, team dir, project trust, daemon, leader, spawning path, service, GitHub token. Only failures set the exit code.
- `pi-config.ts` — Reads Pi's `settings.json`/`trust.json` (under `PI_CODING_AGENT_DIR`, default `~/.pi/agent`); resolves local package entries to absolute paths before comparing; classifies registrations as `managed` / `dev` / `legacy` / `missing`.
- `extension.ts` — Locates the embedded extension (`MPT_PI_EXTENSION` override → checkout → alongside the binary) and writes it to `~/.my-pizza-team/pi-extension/` (`MPT_HOME` overrides `~`), staged and swapped so an interrupted write can't leave a half-populated directory. Only `package.json` and `src/` are embedded.
- `agent.ts` — `mpt agent --harness <h>` (builds the supervisor: client, launch command, the `mpt agent fail` command the agent is told about, and the environment that lets it reach the daemon), `mpt agent fail "<why>"` (fails the IN_PROGRESS item belonging to `MPT_AGENT_ID`), and `mpt setup --harness <h>` (checks prerequisites; installs the pinned Claude adapter with npm).
- `service.ts` — launchd plist / systemd user unit generation, detection of an installed service and the binary it launches, and `restart()`.

### agent/

The experimental ACP supervisor (DESIGN.md "Harness Tiers, and Why Not MCP"). Deno code in the
`mpt` binary that imports the Pi extension's harness-agnostic `runtime/` (`client.ts`,
`transcript.ts`) directly.

- `acp.ts` — `AcpConnection`: JSON-RPC 2.0 over a child's stdio, one object per line. `initialize` (no fs/terminal; accepts `notice` updates so agents don't write notices into replies), `newSession`, `setMode`, `prompt`, `cancel`; notifications to handlers; agent → client requests answered by one handler, unknown ones with "method not supported"; `permissionOutcome` (never an "always" option).
- `harnesses.ts` — `ACP_HARNESSES`: how to launch each — Kiro `kiro-cli acp`; Claude the pinned `@agentclientprotocol/claude-agent-acp` under `~/.my-pizza-team/acp/claude/` run with node, `CLAUDE_CODE_EXECUTABLE` pointing at the user's own `claude` — and the session mode to set (Claude: `default`).
- `supervisor.ts` — `AgentSupervisor`: register (retrying while unreachable; a 409 refusal is final), heartbeat (dismissed → stop; reregister), and the loop: poll → claim → `session/new` (+ mode) → the daemon's prompt plus `failInstructions` → on `end_turn` a `[done]` comment with the reply after the last tool call and COMPLETE, unless the item was already failed (`getWorkItemState`); other stop reasons, errors, and the agent exiting fail the item with the reason. Permission requests → allow once. `session/update` → the transcript mirror (message segments split at tool calls, tools, thinking) and the tmux window; `usage_update` cost in USD + the prompt result's tokens → `/api/agents/:id/usage` (no report when the agent gives neither). On stop it fails any item in hand before deregistering.

### shared/

- `types.ts` — Domain types (`TeamConfig`, `WorkflowConfig`, `Story`, `WorkDef`, `WorkItem`, `Schedule`, `Template`, `Member`, `TeamReadiness`, `Thought`, …), `DEFAULT_CONFIG`, `DEFAULT_HARNESS_TEMPLATES`, team-dir constants, `resolveMinTeammates`, `normalizeDirectory`, `slugify`, `generateTeammateName`.
- `protocol.ts` — Request/response contracts for the HTTP API, and `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION`.
- `frontmatter.ts` — The small YAML-like frontmatter parser/serializer used by markdown files.

### ui/src/

**Shell.** `App.tsx` is the router and the two-column shell (`h-dvh`, so each region
scrolls itself): the `SideDock` on the left and the center (NavBar + scrollable
`<main>`), with aligned `h-14` headers. The center is a Tailwind `@container`, so the
nav adapts to the space the dock leaves. `/assistant` redirects to `/` and opens the
dock's Assistant tab.

- `components/NavBar.tsx` — Center-column nav: **Thoughts · Board · Tasks · Schedule · Context**, then pause/resume, Usage, Help, Config, and the theme toggle.
- `components/RouteTabs.tsx` — Route-driven segmented tabs, used by RootPage (Queue/Inbox), `board/BoardTabs.tsx` (Board/Backlog/Archive/Workflows), `TasksTabs.tsx` (Items/Templates), and ConfigPage (General/Teammates/Theme).
- `components/dock/SideDock.tsx` — The dock: header row (`NewWorkMenu` `+` → `lib/start-work.ts` destinations; `queue/QueueSummary.tsx` counts + hover preview; collapse), tab row (Assistant with presence dot + unread badge; Team with online count + amber dot; the active tab's actions), both bodies kept mounted, drag-resize (300–560px), collapsed icon rail, floating panel below `lg`. Owns `useAssistantStream`, `useTeamData`, and `useQueue` so badges stay live. `SideDockProvider.tsx` + `hooks/useSideDock.ts` hold open/tab state in `localStorage`.
- `components/assistant/*` — `AssistantChat` (presentational, so collapsing can't drop the SSE connection), `MessageBubble`, `BubbleDialog`, `ThinkingBubble` → `ThoughtsPanel`, `Composer` (never locks; quoted replies), `QuotedMessage`, `SessionMenu`, `PersonaChips`. `hooks/useAssistantStream.ts` owns the SSE subscription plus a 15s reconcile poll; `hooks/useMediaQuery.ts` picks docked vs floating.
- `components/team/TeamPanel.tsx`, `TeamParts.tsx` — The Team tab: teammate rows (never the leader) linking to `/teammates/:id`, pending and failed spawns, the version-skew banner with restart, offline members. `lib/team.ts` holds types, `roleOf`, `viewPath`, and `harnessSkew`.
- `components/TeamSizeDialog.tsx` — Declared team size over `/api/teammate-pool` (online/starting counts, default indicator, **Use default**, no-leader warning).
- `components/SpawnDialog.tsx` — Spawn one teammate in a chosen directory (a `spawn` directive with `cwd`).

**Pages.**

- `pages/RootPage.tsx` — Home tabs: **Queue** (`/queue`, `QueuePage.tsx`: At risk → Waiting → Working, with stall banner; `hooks/useQueue.ts`, `lib/queue.ts`) and **Inbox** (`/`, `InboxPage.tsx`: paginated terminal WorkItems, unread by default, each deep-linked to its WorkDef's Thread tab — board tasks via `/task/:storyId/:id`, standalone via `/work-defs/:id`; `lib/work-item-link.ts`).
- `pages/BoardPage.tsx` — Story swimlanes (`board/StorySwimlane.tsx`) of task cards (`board/TaskCard.tsx`: title, assignee, cost, WorkItem chip, `details →`). Drag-to-move posts `/api/tasks/:id/move`; the drag MIME type (`board/task-drag.ts`) carries the story id so lanes only accept their own tasks. Todo/done bucket columns can be hidden per story (`localStorage`).
- `pages/BacklogPage.tsx`, `pages/ArchivedPage.tsx` — Board sub-tabs.
- `pages/WorkflowsPage.tsx`, `pages/WorkflowDetailPage.tsx` — List/create workflows and edit states (saved through `PUT /api/config`), set the default, and edit personas (`workflow/PersonaEditor.tsx`, via the instructions API with lint warnings).
- `pages/NewStoryPage.tsx`, `pages/StoryDetailPage.tsx`, `pages/NewTaskPage.tsx` — Story creation (workflow, directory, context, inline tasks), story editing (title, description, directory, context, paused, task order, archive, delete), and task creation in a story.
- `pages/TaskDetailPage.tsx` — A board task (a WorkDef with a story parent): **Details** / **Thread** tabs (`ui/detail-tabs.tsx`, `?tab=`), edits via `PUT /api/work-defs/:id`, plus breadcrumb, workflow status + move, and delete (`DELETE /api/tasks/:id`).
- `pages/TasksPage.tsx`, `pages/SchedulePage.tsx` — Solitary and Scheduled WorkDefs (filtered by derived type), with Run / Run now, per-row cost, Archive, and an Archived drawer. Schedule joins `/api/schedules` for cron and last run.
- `pages/TemplatesPage.tsx`, `pages/TemplateDetailPage.tsx`, `components/TemplatePickerDialog.tsx` — Templates list/edit and the "task from template" picker.
- `pages/NewWorkDefPage.tsx` — Shared create form (`/work-defs/new?type=Solitary|Scheduled|Template`, `&template=<id>` to pre-fill): cron presets and auto-created Schedule for Scheduled, "enqueue now" for Solitary. Acceptance criteria use `ui/acceptance-criteria-editor.tsx` (RFC 2119 scoring).
- `pages/WorkDefDetailPage.tsx` — Standalone WorkDef view/edit with Details/Thread tabs and Run now.
- `pages/ContextPage.tsx` — The context library (`board/ContextSelector.tsx` attaches entries elsewhere).
- `pages/ThoughtsPage.tsx` — Thoughts: owns the notes, groups, and every mutation, and switches between two views (**Canvas | List**, `mpt.thoughts.view` in `localStorage`), carrying the selection across. Both sit under one shared toolbar row the page renders — **+ Note** first, then the view's own tools (canvas: Group, Tidy, Select, Map; list: Folder), and at the right zoom (canvas only), Archived, and the switch — so the fixed controls never move when you change view. The **canvas** is this page: pan/zoom (`lib/wheelGesture.ts`), drag/multi-select/marquee, keyboard shortcuts, minimap + group chips, uniform cards, group plates, drag-and-drop membership, Tidy, archived drawer; geometry in `lib/thoughtGeometry.ts`, colors in `lib/thoughtColors.ts`, checklist toggling in `lib/taskMarkers.ts`. The **list** is `thoughts/ThoughtsList.tsx`: folders (groups, alphabetical, collapsible — `mpt.thoughts.collapsedFolders`) then ungrouped notes, search, ↑/↓, drag a row onto a folder to file it, and the selected note in a pane. Its rules (titles/snippets, ordering, search, keyboard order, and where a note lands on the canvas when the list files it — `placeForGroupChange`, `slotInPlate`, `slotBelowAll`) are pure in `lib/thoughtList.ts`. Both views edit through `thoughts/NoteEditor.tsx`: framed by `thoughts/NoteDialog.tsx` on the canvas (saves on close) and inline in the list (autosaves). `thoughts/CopyId.tsx` is the copy-id chip.
- `pages/UsagePage.tsx` — Tiles, a 53-week contribution grid, and the cost split by kind; pure helpers in `lib/usage.ts`.
- `pages/TeammatePage.tsx` — A teammate's live transcript (`transcript/TranscriptView.tsx`, `hooks/useTranscriptStream.ts`, `lib/transcript-types.ts`) with Pair (`transcript/PairComposer.tsx`) and Resume / Complete / Fail.
- `pages/ConfigPage.tsx` — **General** (port, tmux session, max/min teammates, default workflow, readiness probe, autosave), **Teammates** (name nouns), **Theme** (palette; client-side via `lib/theme.ts` and `ThemeToggle.tsx`).
- `pages/HelpPage.tsx` — Renders `GUIDE.md`, copied to `src/content/guide.md` by the `prebuild` script.

**Shared UI.** `viewer/FileViewer.tsx` (attachment lightbox) and `viewer/DiffViewer.tsx`
(line-comment review); `components/ui/*` (shadcn primitives plus markdown, title,
directory, and back-button fields); `hooks/useApi.ts` (fetch + optional polling);
`lib/assistant-types.ts` (hand-mirrored wire types).

### harnesses/pi/

A **pure HTTP client** of the daemon with no server-side code; it owns no state.
Roles are chosen by flag: `--ppt-lead` (leader) or `--ppt-worker` (teammate), with
`--ppt-name`, `--ppt-daemon`, `--ppt-tmux-session`, `--ppt-tmux-window`.

```
src/
├── index.ts        — Role detection, flag registration, teammate commands, wiring
├── leader.ts       — Leader: registration, directive polling (fallback spawns, reset-session → /new), /ppt-* commands, the chat mirror
├── teammate.ts     — TeammateLoop: poll → claim → run the prompt → comment → set state; pairing and fresh sessions
├── chat.ts         — ChatMirror: daemon inbox → Pi (steer), Pi prose → bubbles, terminal input → chat
├── tools.ts        — LLM tools (role-specific): fail, stories/tasks/schedules, thoughts, workflows, context, team status, attachments
├── permissions.ts  — Autonomous permission handling via @gotgenes/pi-permission-system (optional; warns when absent)
├── runtime/        — Harness-agnostic protocol code: no external imports, no relative value imports,
│   │                 no mention of Pi (tests/runtime-purity.test.ts)
│   ├── client.ts     — DaemonClient: every HTTP call
│   ├── transcript.ts — TranscriptMirror: streams the session while watched
│   ├── bubbles.ts    — Splits prose into chat bubbles (fence/list aware)
│   ├── pairing.ts    — WebPairing: pause/message/release from the browser
│   └── usage.ts      — Summarises a run's token usage
└── shared/types.ts — GENERATED from shared/types.ts by `deno task sync-shared`
```

The extension's own detail is in `harnesses/pi/README.md` and `harnesses/pi/docs/`.

### desktop/, scripts/, CI

- `desktop/macos/` — SwiftUI menu-bar app (`Sources/App.swift`, `Sources/DaemonManager.swift`): launches the bundled `mpt`, polls `/health` (including `tmuxSession` and `leaderPresent`), start/stop/restart, open UI in a chosen browser, team-dir picker, reveal in Finder, open in a chosen terminal, and **Launch Leader** via an editable command template (`{session}`/`{dir}`/`{port}`/`{url}`). `Package.swift`; the bundle's version is injected from `deno.json` by `scripts/package-macos-menubar.sh`. `Resources/mpt.entitlements` grants `allow-jit` and `allow-unsigned-executable-memory`, which V8 needs under the hardened runtime — without them a signed build crashes with "Failed to reserve virtual memory for CodeRange". Nothing else: SQLite is Deno's built-in `node:sqlite`, so no non-system library is loaded and library validation needs no exception.
- `desktop/windows/` — `tray.ps1` system-tray app and `My Pizza Team.bat` launcher (see its README).
- `scripts/build.sh` (cross-compile all platforms into `dist/`), `package-macos-menubar.sh`, `package-windows.sh`, `generate-icns.swift`, `publish.sh` (bump version, sync generated copies, tag — the tag triggers the release workflow), `sync-version.ts`, `sync-shared.ts`, `ci-annotate.py` (failed tests → GitHub annotations).
- `.github/workflows/ci.yml` runs every gate: daemon check + fast tests + generated-files check, e2e (with real tmux), the extension's typecheck + tests, and the UI's `tsc -b` + lint. `release.yml` builds and publishes on tags.

### tests/

`deno task test` runs `tests/*.test.ts` (daemon, CLI, and pure UI helpers such as
`thought-geometry`, `thought-list`, `acp` (against the fake agent), `usage-grid`, `wheel-gesture`, `harness-skew`) using
`tests/_config.ts`'s `TEST_CONFIG` (autosave off). `tests/e2e/` holds the slow suites
on the `_sandbox.ts` harness: CLI lifecycle, tmux lifecycle, git sync, readiness
probe, entry points (every way of starting the daemon gets the same daemon), and `agent` (`mpt agent` end to end against `tests/fixtures/fake-acp-agent.ts`: the gate, completion, fresh sessions, permissions, usage, `mpt agent fail`, a crash). Guard tests worth knowing: `version.test.ts` (extension version in step),
`protocol-version.test.ts`, `runtime-purity.test.ts`, `build-embeds.test.ts`,
`doctor-coherence.test.ts`. The extension's suites are in `harnesses/pi/tests/`
(`deno task test:ext`).

## Agent Lifecycle

```
1. POST /api/agents/register          → {protocolVersion, harness, harnessVersion, directory, metadata}
2. GET  /api/agents/next-work?agentId → { workItem: {id, title} | null }   (null while paused)
3. POST /api/agents/claim/:id         → lease (→ IN_PROGRESS) + { workItem: {id}, prompt }
4. (the agent works, in the ref's directory, and posts its own comment)
5. POST /api/agents/work-items/:id/state {state: COMPLETE|FAILED}
6. POST /api/agents/:id/usage         → one line in the ledger
   POST /api/agents/heartbeat         → keep-alive; restores this agent's MORIBUND items
```

Members and assignments are **connection state**: cleared on daemon boot
(`resetConnectionsForBoot`), with any `IN_PROGRESS` item moved to `MORIBUND` (its
`member_id` kept, so the same agent can still complete it). A heartbeat from an
agent the daemon no longer knows gets `reregister` (a restart forgot it); one that
was explicitly dismissed (`DELETE /api/agents/:id?dismiss=true`) gets `dismissed`
and shuts down. A plain `DELETE` is a clean self-deregister and leaves no
tombstone. This keeps restarts and upgrades from silently killing teammates.

**Spawning.** The pool reconciler (or the Spawn dialog) creates a `spawn`
directive with a daemon-assigned name. If the daemon can reach tmux, `realizePending`
opens a window in `config.tmuxSession` running the harness's `teammate` template
within ~2s; otherwise the leader realizes it. The teammate registers with its tmux
location in `metadata`, which later `dismiss` / `reset-session` directives use.
`reconcileTeammatePool` only queues spawns while a leader is online — on purpose, even when the daemon could spawn (DESIGN.md "Team Size"); a one-off Spawn-dialog spawn isn't held.

An experimental harness (`params.harness` or `defaultHarness` = `kiro`/`claude`, with
`experimental.harnesses` on) spawns the same way, but its template runs `{mpt} agent
--harness …` — the daemon fills `{mpt}` with how it was itself run (`daemon/self.ts`).
The leader's fallback path can't, so those spawns need the daemon to reach tmux; the
supervisor then registers with `harness` set, like any agent.

## Templates

Task Templates are files under `templates/<id>/template.md` served by
`/api/templates`; they share the WorkDef serializer and never touch the WorkItem
queue. The UI's create form pre-fills from one via `?template=<id>`.

## Thoughts

Notes are `thoughts/<id>.md` (frontmatter: color, status, x/y/w/h, zIndex, pinned,
groupId, timestamps; body: markdown). Groups are `groups.json`
(`[{id, title, x, y, w, h, groupColor, plateOpacity}]`). Files are read and written
directly — no SQLite index. Store methods mint ids, auto-place new notes, and
cascade group membership; `POST /api/thoughts/positions` batches one drag gesture.
`updatedAt` is the last *content* edit — geometry, color, pin, status, and group
changes leave it alone, since the list view sorts by it. When the UI changes a
note's group anywhere but a canvas drop (the list, a Group picker), it also sends a
new `x`/`y` so the note sits inside its plate, or clear of every plate
(`lib/thoughtList.ts`). The Pi extension exposes read/write tools so the leader can
use the board.

## Scheduler readiness gating

`runScheduler` (every 30s) enqueues each due Schedule's active child WorkDefs, deduped
per minute via `lastEnqueuedAt`. `canScheduleNow()` allows it when no agent is online
or the team is ready (`TeamReadiness`, set by the daemon's probe or
`POST /api/readiness`; unreported = ready). Otherwise the Schedule is marked
`heldForReadiness` without advancing its cursor, and fires once on recovery.
Rationale: DESIGN.md "Readiness Gating".

## API Routes

When a token is configured, every path except `/health` requires it.

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `status`, `uptime`, `agents` (online), `queueDepth`, `memory`, `lastCommitTime`, `tmuxSession`, `leaderPresent`, `notReady` (readiness when not ready, else null), `spawning` (spawn capability) |
| GET | `/api/status` | Story/task/member counts, `paused`, `defaultWorkflow`, `workflows` |
| POST | `/api/control/pause` \| `/api/control/resume` | Pause/resume distribution (next-work returns null while paused) |
| GET | `/api/config` | Config + loaded `workflows` + `defaultNouns` |
| PUT | `/api/config` | Update config; requires `workflows` + a valid `defaultWorkflow`; validates and saves each workflow to `workflows/<name>/workflow.json`; reconciles the pool |
| GET | `/api/teammate-pool` | `{ minTeammates (effective), isDefault, maxTeammates, online, pending, leaderPresent }` |
| PUT | `/api/teammate-pool` | `{ minTeammates }` (non-negative integer, clamped to max; `null` = default) — persists and reconciles |
| GET | `/api/readiness` | `{ readiness }` (null if never reported) |
| POST | `/api/readiness` | Report `{ ready, reason? }` (the daemon's own probe also writes this) |
| GET | `/api/workflows` | Summaries: name, stateCount, agentCount, manualCount, isDefault |
| GET | `/api/workflows/:name` | Full `WorkflowConfig` |
| GET/PUT | `/api/workflows/:name/instructions/:state` | Read/write a persona; PUT lints (errors → 400; warnings returned) |

### Stories and board tasks

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/stories` | List (with tasks) / create (optionally with tasks) |
| PUT/DELETE | `/api/stories/:id` | Update / delete |
| POST | `/api/stories/:id/archive` | Archive (writes `archived/<id>.json` with a synopsis) |
| POST | `/api/stories/:id/backlog` | Move to backlog (with dependents; refused while tasks are assigned) |
| GET | `/api/archived`, `/api/backlog` | List archived / backlogged stories |
| POST | `/api/backlog/:id/restore` | Restore from backlog |
| POST | `/api/stories/:storyId/tasks` | Create a board task in a story |
| POST | `/api/stories/:storyId/tasks/reorder` | `{ order: [taskId, …] }` |
| POST | `/api/tasks/:taskId/move` | Judgment move to any position (buckets included) |
| DELETE | `/api/tasks/:taskId` | Delete (drops it from the story; frees the CONWIP token) |

### WorkDefs, Schedules, Templates, WorkItems

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/work-defs` | List (`?status=active` default, `archived`, `all`) / create (enqueues unless `enqueue:false`) |
| GET/PUT/DELETE | `/api/work-defs/:id` | Get / update / delete any WorkDef |
| POST | `/api/work-defs/:id/enqueue` | Enqueue a READY WorkItem |
| POST | `/api/work-defs/:id/archive` \| `/restore` | Archive (also stops cron firing) / restore |
| GET | `/api/work-defs/:id/comments` | The thread |
| POST | `/api/work-defs/:id/comment` | Add a comment |
| GET/POST | `/api/work-defs/:id/attachments` | List / upload |
| GET/DELETE | `/api/work-defs/:id/attachments/:filename` | Serve raw / delete |
| POST | `/api/work-defs/:id/token-usage` | Record usage on the ref (prefers harness `costUsd`) |
| GET | `/api/schedules`, `/api/schedules/:id` | List / get (`id, title, cron, lastEnqueuedAt`) |
| PUT/DELETE | `/api/schedules/:id` | Update (cron validated) / delete |
| GET/POST | `/api/templates` | List / create |
| GET/PUT/DELETE | `/api/templates/:id` | Get / update / delete |
| GET | `/api/work-items` | List (`?state=`, `?read=`, `?limit=&offset=`) — Queue, Inbox, dock |
| GET | `/api/work-items/:id` | One item (with its WorkDef's `parent`) |
| POST | `/api/work-items/:id/cancel` | Cancel a READY item |
| POST | `/api/work-items/:id/force-fail` | MORIBUND → FAILED (`{ reEnqueue? }`) |
| POST | `/api/work-items/:id/read` | Mark read (`?read=false` for unread) |
| POST | `/api/work-items/re-enqueue` | `{ ref }` — fresh READY item for a ref with none active |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agents/register` | Register (`id`, `name`, `directory`, `metadata`, handshake fields); 409 on an unservable `protocolVersion`, or an experimental `harness` without `experimental.harnesses` |
| POST | `/api/agents/heartbeat` | Keep-alive; `{reregister:true}` or `{dismissed:true}` when unknown |
| GET | `/api/agents/next-work?agentId=` | Next READY item by directory affinity |
| POST | `/api/agents/claim/:workItemId` | Lease + prompt (409 if not claimable) |
| POST | `/api/agents/work-items/:workItemId/state` | COMPLETE (advances a board task) or FAILED; only the holder (403 otherwise); posts no comment |
| GET/POST | `/api/agents/comments/:workItemId` | Read / post comments on the item's ref |
| POST | `/api/agents/work-items/:workItemId/attachments` | Upload to the ref |
| POST | `/api/agents/:id/usage` | One run: tokens incl. cache, `costUsd`, `model`, `kind` (`work`\|`pairing`\|`chat`\|`other`), optional `workItemId` |
| GET | `/api/agents` | Members (with handshake fields) + the daemon's `protocolVersion` and `daemonVersion` |
| DELETE | `/api/agents/:id` | Unregister (`?dismiss=true` leaves a tombstone) |
| GET | `/api/agents/:id/directives` | Self-handled directives (`new-session`, `resume-session`) |
| PUT | `/api/agents/:id/directives/:directiveId` | Mark one done/failed |
| GET/POST | `/api/leader/directives` | Pending queue (self-handled actions excluded) / create (`spawn` gets a generated `params.name`; an experimental `params.harness` is refused with 400 unless opted in) |
| PUT | `/api/leader/directives/:id` | Update status |
| GET | `/api/spawn-requests` | `{ requests (pending spawns), failed (failed spawns with reasons) }` |
| DELETE | `/api/spawn-requests/:id` | Mark a spawn directive `cancelled` (stops a pending one; clears a failed one from the list) |
| GET | `/api/agents/:id/transcript/stream` | SSE; subscribing is watching. `hello {entries}` then `entry` upserts |
| GET | `/api/agents/:id/transcript/watch` | Agent: `{ watched }` |
| POST | `/api/agents/:id/transcript` | Agent: batched `{ entries }`; recorded only while watched |
| GET | `/api/agents/:id/transcript` | Snapshot `{ entries, watched }` |
| POST | `/api/agents/:id/pair` | Start pairing (404 unknown, 400 leader) |
| POST | `/api/agents/:id/messages` | `{ text, mode: "queue"\|"steer" }` (409 unless paired) |
| POST | `/api/agents/:id/release` | `{ action: "resume"\|"complete"\|"fail" }` |
| GET | `/api/agents/:id/pairing/state` | UI: `{ paired, since, pendingRelease }` |
| GET | `/api/agents/:id/pairing` | Agent: drains `{ paired, release, messages }` |

### Assistant chat

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/assistant/messages` | `{ session, messages, thinking, chatAgent }`; `?sessionId=` for an earlier session |
| POST | `/api/assistant/messages` | Send (always succeeds); `replyTo`, `origin: "tui"` for mirrored terminal input |
| DELETE | `/api/assistant/messages/:id` | Delete one message |
| GET | `/api/assistant/stream` | SSE: `hello`, `message`, `message-deleted`, `delivery`, `thinking`, `session` |
| GET | `/api/assistant/inbox?agentId=` | Leader only: queued messages with resolved quotes |
| POST | `/api/assistant/inbox/ack` | `{ ids, state }`; empty `ids` + `read` promotes all delivered |
| POST | `/api/assistant/bubbles` | Mirror one bubble `{ content, failed? }` |
| GET/POST | `/api/assistant/thoughts` | Reasoning peek: read / `{chunk}` \| `{clear:true}` \| `{thinking}` |
| POST | `/api/assistant/session` | Report the backing Pi session file |
| GET | `/api/assistant/sessions` | List sessions, newest first |
| POST | `/api/assistant/sessions/new` | Snapshot + end the active session; emit `new-session` |
| POST | `/api/assistant/sessions/:id/resume` | Reopen; emit `resume-session` (`contextRestored:false` if no file) |
| GET | `/api/assistant/sessions/:id/snapshot` | The session's markdown |
| GET/PUT | `/api/assistant/persona` | Active persona + effective system prompt / swap (ends + snapshots the session; `null` = default) |

### Context, Thoughts, Usage

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/context` | List / create (id from title) |
| GET/PUT/DELETE | `/api/context/:id` | Get / update / delete |
| GET/POST | `/api/thoughts` | List (`?status=`) with groups / create (auto-placed unless x/y given) |
| GET/PATCH/DELETE | `/api/thoughts/:id` | Get / partial update / hard delete |
| POST | `/api/thoughts/positions` | Batch geometry for one gesture |
| POST | `/api/thoughts/:id/archive` \| `/restore` | Toggle archived |
| POST | `/api/thought-groups` | Create `{ title, memberIds? }` |
| PATCH/DELETE | `/api/thought-groups/:id` | Rename / ungroup (notes stay) |
| GET | `/api/usage/daily?days=&tzOffset=` | Per-day usage by kind + totals + peak |
| GET | `/api/usage/day?date=&tzOffset=` | One day's runs, most expensive first |

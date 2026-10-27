# Architecture

What is where, and how the pieces talk. The rationale behind these choices is in
[DESIGN.md](DESIGN.md); this document is the map.

## Overview

my-pizza-team is one repository producing one npm package, `my-pizza-team`, whose command is `mpt`:

- **daemon/** — HTTP API server: [Hono](https://hono.dev/) served by `@hono/node-server`, a SQLite runtime index over plain files, tmux supervision, and timers (heartbeat reaper, scheduler, autosave, readiness probe, spawn realization).
- **cli/** — the `mpt` command: start/stop the daemon, `setup`, `doctor`, `lead`, `upgrade`, service install.
- **ui/** — the web UI (React + Vite + shadcn/ui), built into `ui/dist/` and served by the daemon.
- **shared/** — types, protocol contracts, and constants shared by the daemon, CLI, and (via generation) the Pi extension.
- **harnesses/pi/** — the Pi extension: a Node/npm package with its own `tsconfig.json`, `package.json`, and tests. Its source ships in the `my-pizza-team` package and is written out by `mpt setup`.
- **agent/** — `mpt agent`, the supervisor that runs an experimental non-Pi teammate (Kiro, Claude Code) over the Agent Client Protocol.
- **desktop/** — optional tray/menu-bar apps (macOS SwiftUI, Windows PowerShell).
- **scripts/** — build, packaging, release, and code generation.
- **tests/** — the fast suite (`npm test`) and `tests/e2e/` (`npm run test:e2e`), both on `node:test`.

```
            ┌──────────── mpt (one package) ────────────┐
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
| `config.json` | Team config (`TeamConfig`), including the `features` toggles (absent ⇒ all on; see "Feature toggles") | file |
| `workflows/<name>/workflow.json` | `{ states: [{name, type}] }` | file |
| `workflows/<name>/<state>.md` | Persona for an agent state | file |
| `stories/<id>.json` | Story: title, description, workflow, directory, context, `pending: true` while pending, dependsOn, `tasks: [{id, status}]` (legacy `paused` is migrated on load) | file (indexed in SQLite) |
| `tasks/<id>/workdef.md` | A WorkDef: frontmatter (title, `parent`, directory, contextRefs, `status: archived`, `pending: true` while pending — legacy `draft: true` reads as pending) + `## Goal` / `## Acceptance Criteria` / `## Additional Context` | file (board ones cached in the `tasks` table) |
| `tasks/<id>/comments.jsonl`, `attachments/` | The WorkDef's thread and files (append-only comments) | file |
| `schedules/<id>.json` | Cron parent: cron, lastEnqueuedAt, `heldForReadiness?`, `pending?` (reversible), `resumedAt?` (last reactivation) | file |
| `sources/<sourceId>.json` | A Work Source's own key/value state (e.g. `revision:<defId>` stamps from `enqueueRevision`); written only by a source that uses `ctx.kv` — the built-ins don't. An external source's mirrors keep `mirror:<defId>` (revision mirrored), `vanished:<defId>` (archived by sync), and `mode:<defId>` (`"triage"` while the item is in triage mode) here | file |
| `tasks/<sourceId>~<externalId>/workdef.md` | A **mirrored** WorkDef (`parentKind: external`, `parentSource`, `url`): an external source's item, written only by its sync (`sources/mirror.ts`); MPT's edit/delete/create routes refuse it. Its thread and attachments are ordinary | file |
| `templates/<id>/template.md` | Task Template (WorkDef format, never enqueued) | file |
| `archived/<id>.json` | Archived stories (with synopsis). A legacy `backlog/<id>.json` is moved back to `stories/` as pending on load (`store/story-migration.ts`) | file |
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
state enqueues a new one. A **pending** WorkDef never gets a WorkItem:
`enqueueFor` refuses it, the scheduler skips it, and admission stops at a pending
`todo` task (holding the story's slot) — `activateWorkDef` clears the flag and
then enqueues (Solitary), re-runs admission or enqueues in place (Board), or
leaves it to the next cron firing (Scheduled). See DESIGN.md "Pending: Write,
Review, Activate". When every task in a story reaches `done` the story is
marked done; moving one back out reopens it.

A **pending story** (`Story.pending`, reversible via `setStoryPending`) is a gate
on top of that: `runAdmission` admits nothing for it and the Story source's
`isEligible` never offers its READY items, so a task already IN_PROGRESS finishes (and
advances — a fresh READY item in the next agent state just waits) while nothing
new starts. Its dependents wait because it isn't `done` (`isStoryReady`).
Activating re-runs admission; its waiting READY items become eligible again.

## Module Map

### daemon/

- `start.ts` — `startDaemonInProcess`: **the one startup routine**, used by `mpt start` (foreground and the `--daemon` child, and so the service), and `main.ts`. Creates the app, validates bind safety, writes the PID file, registers signal handlers, serves, then probes tmux once (and, if reachable, every 2s re-checks the config's default harness with `harnessCapability` — so a Config-page fix needs no restart — and runs `realizePending`) and starts the readiness loop. Also `resolveTeamDir` (TEAM_DIR as the dir or its parent; else `./.my-pizza-team`), shared with the CLI.
- `main.ts` — Entry point for `npm run dev`/`start`: a thin call into `start.ts`, so the dev daemon is the real daemon.
- `app.ts` — `createApp(teamDir, { pluginRunner?, pluginInstallTimeoutMs? })` (async): merges `config.json` over `DEFAULT_CONFIG`, constructs the Store, registers dev sources, installs configured-but-missing npm/git plugin packages (`plugins/install.ts` `installMissingPackages`) and loads plugin packages (`plugins/loader.ts`), loads from disk, starts timers, builds the app. Without a team dir, a health-only app.
- `server.ts` — `buildApp()`: auth middleware (when a token is configured), static UI serving, the feature gates (`registerFeatureGates`, ahead of every route), and registration of every route module with a shared `RouteContext` (store, config, teamDir, pause flag).
- `features.ts` — Feature toggles (see "Feature toggles"), driven by the Work Source registry (each source's `toggle`): `registerFeatureGates` (one `requireFeature` middleware per toggleable source's `routes`, plus the WorkDef and proposal resolvers; 403 `feature '<name>' is disabled`), `featureNames` / `enabledFeatures` (the resolved toggles `/api/status` and `/api/config` report), `featureForWorkDef` / `featureForProposalKind` / `isWorkDefVisible`, and the turn-off guard — `activeFeatureItems` (the source's `toggle.activeItems`, default its non-archived WorkDefs; `featureUsage` for all of them) and `resolveFeaturesUpdate` (validates a `PUT /api/config` `features` value; 409 while items remain).
- `auth.ts` — Optional API-token auth: Bearer, Basic (for the browser), and a query-param fallback. `validateBindSafety` refuses a non-localhost bind without a token. `MPT_API_TOKEN` overrides `config.apiToken`.
- `static.ts` — Serves the UI with SPA fallback to `index.html`: `UI_DIST` if set, else the package's own `ui/dist/` (`shared/paths.ts`), else `<cwd>/ui/dist`.
- `lifecycle.ts` — PID file, SIGTERM/SIGINT handling, flush-and-close on exit, and `redirectOutputToLog` (a background daemon's console → `daemon.log`, the previous run's kept as `daemon.log.1`, uncaught errors included).
- `store.ts` — The Store: SQLite (`node:sqlite` `DatabaseSync`) plus file sync. Owns schema and migrations, story/task CRUD and ordering, the entry points into the board policy (`moveTask`, `updateTaskStatus`, `runAdmission`, `admitDependents` — all delegating to the Story source; `writeTaskPosition` persists a position), the **WorkItem queue** (`enqueueFor` — the single creator, which refuses pending WorkDefs; `getNextWorkItem` — directory affinity, skipping items blocked by an exclusive directory lease; `claimWorkItem` — re-checks the lease in a `BEGIN IMMEDIATE` transaction; `getDirectoryBlocker` — the in-flight item holding an overlapping directory; `setWorkItemState`; `failWorkItemForSessionError` — an errored agent session: `[retry]` comment + a backoff-held retry item (`attempt`, `retry_at`), or `[failed]` once `resolveRetry`'s retries run out, DESIGN.md "Errored Sessions Retry"; cancel/force-fail/re-enqueue; `getExecutionStats` / `getExecutionStatsFor` — per-WorkDef run count and last run, one aggregate over `work_items` with CANCELED excluded, DESIGN.md "Execution Count: Derived, not Counted"), members and heartbeats (`reapOfflineAgents`, `dismissMember` tombstones), leader directives, the teammate pool (`reconcileTeammatePool`), team readiness, the Work Source registry (`registerWorkSource`, `getWorkSourceFor`, `tickWorkSources`; hooks called from `loadFromDisk` (`reconcile`), `enqueueFor`, `isWorkItemEligible`, `claimWorkItem`, `setWorkItemState` / cancel / force-fail / a board move's withdrawal (`onItemTerminal`), `addCommentForRef` (`onComment`), `activateWorkDef`, `runWorkDef`), external sources (`syncWorkSource` → `SyncRunner` → `ingestExternalDefs`: mirror, enqueue once per revision behind readiness, archive what vanished; `listExternalSources`, `getMirrorState` (revision, vanished, mode), `getLatestWorkItemState`; triage mode — `isTriageModeMirror`, and for those mirrors the daemon's title/directory in `enqueueFor`, prompt in `buildPromptFor`, and Triage now in `runWorkDef`, via `sources/external-triage.ts`) and `runScheduler` (a synchronous call into the Schedule source), story pending ⇄ active (`setStoryPending`) and archive, attachments, context resolution (`resolveTaskContext`), and config persistence (`saveConfig` → `serializeConfig`, the single writer). Timers (`startTimers`): flush + autocommit, a 30s tick (reap → refresh chat snapshot → reconcile pool), and a 30s Work Source tick (`tickWorkSources`; the Schedule source fires there), and one sync timer per external source (`syncEveryMs`, default 60s, plus a first run 1s after start). Self-contained concerns live in `store/`:
  - `store/workdefs.ts` — WorkDef markdown IO (`serializeWorkDef`/`parseWorkDef`, including the `pending` flag, reading legacy `draft: true` as pending) and per-def comments.
  - `store/story-migration.ts` — `migrateLegacyStoryFiles`, run first by `loadFromDisk`: story `paused: true` → `pending: true`, `backlog/<id>.json` → `stories/` as pending (`backloggedAt` dropped, `backlog/` removed once empty; an id already in `stories/` is left and warned about). Idempotent.
  - `store/schedules.ts` — Schedule JSON files.
  - `store/templates.ts` — Template IO (reuses the WorkDef serializer; files only, no index).
  - `store/context.ts` — Context-library markdown entries.
  - `store/thoughts.ts` — Thought notes and `groups.json` (files only). A group is a spatial rectangle; membership lives on each note's `groupId`.
  - `store/assistant-chat.ts` — The chat: sessions, messages, receipts, the agent inbox (each item's `mode`: `queue`/`steer` from the terminal-mode composer, `send_mode` column; null from the chat composer), the ephemeral reasoning buffer, and SSE fan-out. At most one session is `active`.
  - `store/assistant-snapshots.ts` — Session markdown transcripts (reasoning excluded).
  - `store/transcripts.ts` — Live agent transcripts (teammates, and the leader for the assistant's terminal mode — keyed by agent id, no role branch): in-memory per-member ring buffers (500 entries) of keyed upserts, viewer tracking with a 30s grace, `watch` markers.
  - `store/pairing.ts` — Web pairing intent: paired flag, message outbox, pending release; drained exactly-once by the agent's poll.
  - `store/usage.ts` — The usage ledger: append to `usage/YYYY-MM.jsonl`, rebuild the `token_usage` cache on boot (`syncUsageLedger`), `dailyUsage` / `runsOnDay` rollups in the client's timezone.
  - `store/source-kv.ts` — `fileSourceKv`: a Work Source's string key/value store in `sources/<sourceId>.json` (sorted keys, read through on every get).
  - `store/git-sync.ts` — Autosave: `git add/commit -- <teamDir>` (pathspec-limited, so the user's own staged work is never included), push if a remote exists, and `ensureTeamGitignore`. All failures non-fatal.
- `plugins/spec.ts` — Plugin package specs from `TeamConfig.packages` (DESIGN.md "Plugin packages"): `parsePackageSpec` (`npm:` / `git:` / `https://` / `ssh://` with `@ref` / local path → an npm, git, or local spec with its dedupe `identity`; never throws) and `parsePackageEntries` (strings and `{ source, config }`; invalid entries and duplicate identities reported in `errors` / `rejected`, the rest kept). Pure.
- `plugins/loader.ts` — `loadPlugins` (startup, from `createApp`: after the built-ins and dev sources, before `loadFromDisk`/`startTimers`): per package, resolve its dir (`packageInstallDir` — local in place, npm `<teamDir>/packages/npm/node_modules/<name>`, git `<teamDir>/packages/git/<host>/<path>`; the layout `mpt plugins` installs into), read the package.json `"mpt": { "sources": [...] }` manifest (other `mpt` keys ignored), `import()` each entry (10s timeout; must stay inside the package) and take its default export — a `WorkSource` or a factory `(options, { teamDir })` — then `registerWorkSource` it with the entry's `config` as `ctx.options()`. The per-entry steps are exported (`resolvePackageDir`, `readPluginManifest`, `resolveSourceEntry`, `importSourceEntry` — which registers the host resolve hook — `isPluginFactory`, `instantiateSource`, `withTimeout`) so `mpt plugins doctor` runs exactly the daemon's path. Every failure is logged (`[plugins]`) and recorded in that package's `PluginLoadStatus` (shared/protocol.ts); the daemon and other plugins carry on. Statuses are kept on the Store (`get/setPluginStatuses`). A package whose install-on-start failed (`installErrors`) is recorded as `install failed: …` without a load attempt.
- `plugins/install.ts` — Fetch/prepare npm and git packages into the install layout; one code path for `mpt plugins add|update`, the daemon's install-on-start, and `mpt plugins doctor` on an uninstalled spec (into a temp team dir). `installNpm` (`npm install --prefix … --omit=peer`), `cloneGit`, `prepareGit` — every `mpt.sources` entry tracked in the checkout (`git ls-files`, so a stale ignored `dist/` after an update's reset doesn't count) and no runtime `dependencies` → no npm; tracked entries plus runtime deps → `npm install --omit=peer --omit=dev`; otherwise `npm install --omit=peer` (dev deps too) + `npm run build`, then each entry must exist ("built, but … is still missing"). A failed npm step throws `PluginInstallError` with the command, exit code (or timeout), the tail of npm's stderr and, for git packages, the contract (plain npm against the user's registry, or prebuilt entries; GUIDE.md "Distributing a plugin"). `installMissingPackages(config, deps)`: each configured npm/git identity whose install dir is missing, once, isolated (failure logged, partial install removed, returned identity → message); local paths never touched; config.json never written. Per-command limit `MPT_PLUGIN_INSTALL_TIMEOUT_MS` (default 10 min; `pluginInstallTimeoutMs`). `runPluginCommand` is the real runner (spawnSync; stdout streamed or captured, stderr captured and echoed; a timeout is exit 124). Build-system agnostic by design: no Brazil/other detection.
- `plugins/host-resolve.ts` — `registerHostResolution` (once per process, from `loadPlugins` before the first plugin import): a `module.registerHooks` resolve hook that answers the specifier `my-pizza-team/plugin` with this host's `plugin/index` module (`.ts` in a checkout, `.js` in `dist/`, following its own extension), whether or not the importing plugin has its own copy — pi-style host resolution, so plugins peer-depend on `my-pizza-team` (DESIGN.md "Plugin packages", "Host types"). Every other specifier goes to Node.
- `sources/` — Work Sources: WorkDef kinds as plugins (DESIGN.md "Work Sources: WorkDef Kinds as Plugins", which has the per-kind audit of what is migrated).
  - `sources/types.ts` — `WorkSource` (incl. `label`, `mode` — `WorkSourceMode`, "work" | "triage", also on `ExternalDef` —, `sync` / `syncEveryMs` / `syncTimeoutMs`, `onComment`), `SourceContext` (incl. `options()` — the source's own settings, `kv`, `enqueueRevision`, `upsertDef`), `SyncOutcome`, `ItemTerminalOutcome`, `SourceToggle` / `ActiveSourceItems` (the feature toggle a source may declare), `SourceKv`, `RevisionCursor`, `RunResult`, `ExternalDef`, `WORK_SOURCE_API_VERSION`. Imports nothing from the Store.
  - `sources/registry.ts` — `SourceRegistry` (register — with `RegisterSourceOptions.options`, frozen into `ctx.options()`; refusing duplicate ids, unsupported apiVersions, and an external source whose id isn't `SOURCE_ID_PATTERN` — `unregister` (test seam), get, `forWorkDef`, `external` (the sources with a `sync`), `tick`/`tickAll` and `reconcileAll`, which isolate a throwing source, and `tickSchedule`, each ticking source's timer interval) and `sourceIdForWorkDef` (`parent.kind` — `parent.source` for an `external` parent — else `"task"`).
  - `sources/revision.ts` — `enqueueRevision`, the core "enqueue once per revision" dedupe behind `ctx.enqueueRevision` (in-flight refuses; unchanged refuses unless `force`; stamp at enqueue), and `kvRevisionCursor` (default cursor: the source's kv, key `revision:<defId>`).
  - `sources/toggle.ts` — `plural`, `activeWorkDefs` (a source's non-archived WorkDefs; the default `activeItems`), and `isSourceSwitchedOff` (the live check the sync runner, ticks, and source context use).
  - `sources/task.ts` — The built-in Solitary source (toggle `tasks`, also gating `/api/templates*`; active items = Solitary WorkDefs + Templates): eligible while it exists, `onActivate` (enqueue unless `enqueue: false`/archived), `run` = `runSolitary` (refuse pending → 409 / in-flight → 400, else enqueue), also the default `run` for kinds without one.
  - `sources/story.ts` — The built-in Story (board) source, `StorySource` (toggle `stories`, gating `/api/stories*`, `/api/tasks/*`, `/api/archived`; active items = stories): the board's queue policy — `runAdmission` (CONWIP, WIP = 1 per story), `admitDependents`, `setPosition` (cancel on leave, enqueue on agent-state entry, story open/done sync), `moveTask`, `advance` — and the hooks: `reconcile` (admission + an active item for every agent-state task, on load), `isEligible` (story active + ready, task in an agent state), `resolveItem` (story directory fallback), `onItemClaimed` (assignment row), `onItemTerminal` (advance on COMPLETE, returns `{ newStatus, completed }`), `buildPrompt` (persona + story framing), `onActivate`. Story persistence comes in as `StorySourceDeps`.
  - `sources/schedule.ts` — The built-in Schedule source (toggle `schedules`, gating `/api/schedules*`; active items = Scheduled WorkDefs): `runSchedules` (cron firing, readiness hold/catch-up, pending skip) as its `tick`.
  - `sources/mirror.ts` — Mirrored WorkDefs for external sources: `mirroredWorkDefId` (`<sourceId>~<encoded externalId>`, injective and file-system safe), `upsertMirror` (write/refresh on a moved revision, restore a vanished one, leave a person-archived one archived), `invalidExternalDef`, and the kv keys `mirrorRevisionKey` / `vanishedKey` / `mirrorModeKey` (with `effectiveMode` — the item's mode, else the source's — and `mirrorMode`, recorded on every sync).
  - `sources/external-triage.ts` — Triage mode for external sources (DESIGN.md "External sources" — "Triage mode"): `isTriageModeMirror` and `ExternalTriage` — a triage-mode mirror's WorkItem title ("Triage: <title>") and directory (the mirror's, else the leader's), its claim prompt (`buildExternalTriagePrompt`), and Run = Triage now (force the mirrored revision). The Store uses these in place of the source's `resolveItem` / `buildPrompt` / `run` for those mirrors only.
  - `sources/sync.ts` — `SyncRunner`: one sync of an external source — `syncTimeoutMs` (default 30s), no overlap, exponential backoff after failures (30s doubling, capped at 30 min), never rejects; a good result goes to `Store.ingestExternalDefs`.
  - `sources/fixture.ts` — `FixtureSource`, the in-repo markdown-folder external source (one `*.md` per item, SHA-256 content revision, `mode: triage` frontmatter or the `mode` option for triage mode, write-back recorded in `writeBacks` and `<dir>/.writeback.jsonl`). Registered only by tests or `config.dev.fixtureSource` (`daemon/app.ts registerDevSources`).
  - `sources/thought.ts` — The built-in Thought (auto-triage) source, `ThoughtSource`: the sweep as its `tick` (every `triage.intervalMinutes`; no timer when triage is off), `triageNow`, `statusFor`, `ensureWorkDef`, and the hooks — `resolveItem` (note title, leader directory), `isEligible` (note active), `buildPrompt` (`buildTriagePrompt`), `run` (= Triage now). Store reads come in as `ThoughtSourceDeps`.
- `workflow-engine.ts` — Position logic: `activeStateNames`, `isAgentState`, `firstActiveState`, `nextState`, `boardColumns`, `isValidPosition`, `validateWorkflow`.
- `workflow-lint.ts` — `validateInstructionMarkdown`: unbalanced fences are errors; shallow headings and `---` are warnings.
- `prompt.ts` — `buildTaskPrompt` (see DESIGN.md "The Daemon Owns the Prompt") and `normalizeInstructionMarkdown` (fence-aware heading demotion).
- `triage.ts` — Auto-triage rules (pure, like cron.ts): `triageSkipReason`/`isTriageDue` (the turn rule), `triageWorkDefId`, `triageWorkItemTitle`, `mirrorTriageWorkItemTitle`, `noteFirstLine`, and the proposal layer — `validateAnalysis`/`validateProposal`, `foldProposals`, `latestAnalysis`, `pendingProposals`, `triageBadge`, `decisionSummary`.
- `cron.ts` — Vendored 5-field cron parser (`parseCron`, `cronMatches`, `isCronDue`, `isValidCron`).
- `token-cost.ts` — Fallback cost estimator, used only when a harness reports no `costUsd`.
- `tmux.ts` — tmux control via argv arrays (no shell): session/window create, list, kill, `send-keys`, `shellQuote`, `renderTemplate` (placeholders `{name}`, `{url}`, `{cwd}`, `{session}`, `{window}`, and `{mpt}` — how to run this mpt), and `tmuxUnavailableReason`.
- `self.ts` — `mptInvocation()`: the argv that runs this mpt again — the configured Node (`shared/runtime-config.ts`; `process.execPath` when none is saved) plus `cliEntryScript()` (`cli/main.ts` from source, `dist/main.js` from the npm package) — for `mpt start --daemon`'s child and the `{mpt}` placeholder.
- `spawner.ts` — `probeTmuxCapability` (once at startup), `harnessCapability` (the config half, re-checked each pass; `probeSpawnCapability` is both) and `realizePending`: turns pending `spawn`/`dismiss` directives into tmux windows using the harness templates (built-ins overridden per harness by config); an unrealizable directive — including an experimental harness on a team that hasn't opted in — is marked `failed` with its reason. Other actions are left for the leader. A `dismiss` is realized over several 2s passes (`realizeDismiss`), staying `pending` between them: wait until its agent has exited (`dismissReady` — deregistered, told `dismissed` ≥3s ago, already offline, or past `params.deadline`, `DISMISS_WAIT_MS` = 25s after the dismiss), then send C-c, then — on a later pass at least `DISMISS_KILL_DELAY_MS` on, never the same one — kill the window. The leader's window (`LEADER_WINDOW`) is never killed (the directive fails instead), and a window already gone (or tmux no longer answering) is simply `done`. `dismissParams` builds a UI dismiss's params from the member's `tmuxSession`/`tmuxWindow` metadata, falling back to its name and `config.tmuxSession`.
- `readiness.ts` — `runProbe` (timeout-bounded `sh -c`, which also survives a hung child on Linux) and `startReadinessLoop` (every 30s; nothing configured → never reports → ready).
- `routes/types.ts` — `RouteContext`.
- `routes/shared.ts` — Health, status, pause/resume, config (GET/PUT; PUT also saves workflows and takes `features` through `resolveFeaturesUpdate`), the teammate pool, readiness, and workflows.
- `routes/stories.ts` — Story CRUD (`pending` on create/PUT; `requestsStoryPending` also reads the deprecated `paused` field), `POST /:id/pending` and `/:id/activate`, archive.
- `routes/tasks.ts` — Story-parent task operations: create-in-story, reorder, move, delete.
- `routes/work-defs.ts` — WorkDef CRUD (every view carries `executionCount`/`lastRunAt`; the list fetches all stats in one query) (PUT of the definition only while pending — 409 once active; a cron-only PUT is always allowed), activate (plus the deprecated `/publish` alias; `requestsPending` also reads the deprecated `draft` request field), enqueue (409 while pending), archive/restore, and the ref-scoped surface for **every** WorkDef: comments, attachments, token usage. A mirrored (External) def's PUT/DELETE and a `type: "External"` create are 409 (pull only); its view carries `mirror`.
- `routes/triage.ts` — Proposals on any triage subject by its WorkDef id (`GET /api/work-defs/:id/triage`, accept, reject — what a triage-mode mirror uses), plus the accept/reject body and response handling (`readAcceptOptions`, `readRejectFrom`, `proposalResponse`) the note routes in `routes/thoughts.ts` share.
- `routes/work-sources.ts` — External sources: `GET /api/work-sources`, `GET /api/work-sources/:id/defs` (mirrored defs with revision, latest WorkItem state, run count, mode), `POST /api/work-sources/:id/sync` (403 while its toggle is off), `POST /api/work-sources/:id/disconnect` (switch off + archive mirrors; `disconnectSource`); plus `mirrorView` (a WorkDef view's `mirror`), `externalSourceViews` (`/api/status` `externalSources`), and `mirroredReadOnlyError` (the 409 work-defs.ts returns for a mirrored def). `mirror.mode` / a row's `mode` is `"triage"` for a triage-mode item, and such a row also carries `triageBadge` (the latest analysis's badge).
- `routes/work.ts` — WorkItem queue reads (list/one) and recovery actions (cancel, force-fail, read, re-enqueue).
- `routes/schedules.ts` — Schedule CRUD (children are WorkDefs).
- `routes/templates.ts` — Template CRUD.
- `routes/directories.ts` — Directory-picker suggestions (`GET /api/directories`: favorites + recent) and favorite edits; the Store normalizes and persists (`favoriteDirectories` in config.json).
- `routes/agents.ts` — The agent protocol: register (version handshake, and the experimental-harness gate — `experimentalGate`), heartbeat (`reregister`/`dismissed` signals), session stats (model, context fill, session cost, held in memory by the store and echoed on `GET /api/agents`), next-work, claim, the single state-setter, work-item comments/attachments (resolved to the ref), agent list/delete, self-directives, leader directives, spawn requests. `DELETE /api/agents/:id?dismiss=true` tombstones the member *and* queues a `dismiss` directive (`dismissParams`) so its tmux window — left at a shell prompt when the harness exits, since spawn typed the command into a shell — is closed once it has gone; a dismissed agent's later heartbeat (`noteDismissedHeartbeat`) and deregister (`noteDismissedDeregistered`, answered 200) are the "it has gone" signals. A plain DELETE queues nothing. `GET /api/leader/directives` hides `dismiss` directives from the leader while the daemon drives tmux, and otherwise until `dismissReady`.
- `routes/assistant.ts` — The chat: conversation reads/writes, SSE stream, the agent mirror surface (inbox/ack, bubbles, thoughts, session report), sessions (list/new/resume/snapshot), persona.
- `routes/transcripts.ts` — Teammate transcript SSE (subscribing registers a viewer), the agent's watch poll and batched POST, and a snapshot.
- `routes/pairing.ts` — Pair / message / release (UI), pairing state, and the draining agent poll. Pi teammates only (ACP teammates don't poll it yet).
- `routes/usage.ts` — Usage reports from any run, and the dashboard's daily/day rollups.
- `routes/context.ts`, `routes/thoughts.ts` — Thin CRUD shells over their store modules.

### cli/

- `main.ts` — Command dispatch and most commands (`agent` and `setup --harness` route to `agent.ts`): `start` (foreground, or `--daemon` re-launches itself detached — `node cli/main.ts` via `mptInvocation()` — with `start --foreground-internal`, which logs to `daemon.log` via `redirectOutputToLog`; the parent waits for the PID file, or reports that the child exited and where its log is), `stop`, `status`, `rotate-token`, `install`/`uninstall` (service), `upgrade`, `doctor`, `setup`, `lead`, `plugins` (`plugins.ts`), and the hidden `write-extension-internal` and `adopt-legacy-internal` (`legacy.ts`). `cmdLead` renders the harness's `leader` template, opens the fixed `leader` window in the project directory, and attaches (or `select-window` when already inside tmux); an existing window is attached rather than duplicated. `upgrade` is in `upgrade.ts`. A global `--node <path>` is stripped from argv first (`extractNodeFlag`) and becomes the highest-priority Node override (also exported as `MPT_NODE` for children). `setup` and `install` call `ensureNodeForCommand` (`node-choice.ts`) before writing anything that outlives the shell.
- `setup.ts` — `planSetup()` (pure: decides what to change, including conflict resolution between managed, dev-checkout, and legacy registrations), settings mutation (atomic, preserving unowned fields), `initTeamConfig` (a new team's `config.json` from `newTeamConfig()`; never overwrites), and the `SetupManifest` that `--uninstall` replays.
- `doctor.ts` — Gathers facts and `evaluate()`s them (pure) into a checklist: Pi (vs `TESTED_PI_VERSION`), tmux, Pi settings, extension registration and version, permission system, team dir, project trust, daemon, leader, spawning path, service, plugins (`pluginChecks`: each package that failed to load, from the daemon's `GET /api/work-sources`), GitHub token, and the Node checks (`nodeChecks`: the saved Node, whether the service runs it and this copy's entry, an old compiled-binary service, leftover native `mpt` binaries on PATH via `findLegacyBinaries`, and the legacy bridge — on PATH via `findLegacyBridges`, or as what the service launches — recognised by its `MPT_LEGACY_BRIDGE` marker via `isLegacyBridge`). Only failures set the exit code.
- `pi-config.ts` — Reads Pi's `settings.json`/`trust.json` (under `PI_CODING_AGENT_DIR`, default `~/.pi/agent`); resolves local package entries to absolute paths before comparing; classifies registrations as `managed` / `dev` / `legacy` / `missing`.
- `extension.ts` — Locates the bundled extension (`MPT_PI_EXTENSION` override → the package's own `harnesses/pi/` via `shared/paths.ts` → `<cwd>/harnesses/pi`) and writes it to `~/.my-pizza-team/pi-extension/` (`MPT_HOME` overrides `~`), staged and swapped so an interrupted write can't leave a half-populated directory. Only `package.json` and `src/` are embedded.
- `agent.ts` — `mpt agent --harness <h>` (builds the supervisor: client, launch command, the `mpt agent fail` command the agent is told about, and the environment that lets it reach the daemon), `mpt agent fail "<why>"` (fails the IN_PROGRESS item belonging to `MPT_AGENT_ID`), and `mpt setup --harness <h>` (checks prerequisites; installs the pinned Claude adapter with npm).
- `upgrade.ts` — `mpt upgrade [--check]`: reads the latest version from the npm registry (`<npm config get registry>/my-pizza-team/latest`), installs it with the **configured Node's own npm** (`resolveNpm`: `<dirname(node)>/npm`, else `<node> …/lib/node_modules/npm/bin/npm-cli.js`, run with that Node first on PATH) as `npm install -g my-pizza-team@<v>`, prints the exact sudo/prefix rerun on EACCES/EPERM, then `refreshManagedExtension` (the new copy's `write-extension-internal`) and `restartServiceAfterUpgrade` (refuses to restart a service that runs a different entry; notes a different Node). Running from source it points at `git pull`. All side effects go through `UpgradeDeps`, so tests stub the fetch and child processes. No GitHub API, tokens or checksums — npm verifies integrity.
- `plugins.ts` — `mpt plugins add|list|remove|update`: manages `TeamConfig.packages` (DESIGN.md "Plugin packages"), sharing the spec parser (`daemon/plugins/spec.ts`) and install layout (`packageInstallDir`, `readPluginManifest`) with the loader. npm → `npm install --prefix <teamDir>/packages/npm --omit=peer <name>[@v]` (the prefix gets a private package.json); git → `git clone` into `packages/git/<host>/<path>`, `checkout <ref>`, then `prepareGit` (`daemon/plugins/install.ts`: prebuilt skip, runtime-deps only, or `npm install` + `npm run build`); local → validated, never copied or deleted. `add` validates the manifest (and that each entry exists) before appending to config.json (raw, not merged with defaults; temp file + rename), refuses a duplicate identity, and cleans up a failed install. Relative local paths on the command line resolve from the cwd and are written absolute. `remove`/`update` match an entry by its spec, its identity, or any spec with the same identity. `update` skips local and pinned entries (npm with a version; git with a tag/commit ref — a branch is detected via `refs/remotes/origin/<ref>` after `git fetch`), bumps unpinned npm to `@latest`, resets unpinned git to `origin/<ref>`/`origin/HEAD` and rebuilds, and installs anything configured but missing. `list` adds each package's load status from `GET /api/work-sources` when the daemon is up. Mutations end with the restart hint (the service's, else `mpt stop && mpt start --daemon`). Side effects via `PluginsDeps`.
- `plugins-doctor.ts` — `mpt plugins doctor [<path|spec|identity>] [--config '<json>'|team] [--source <id>] [--hooks] [--json]`: checks every configured package, or one (configured or not). An unconfigured npm/git spec that isn't installed is first installed into a scratch team dir (temp, removed afterwards; progress on stderr under `--json`) via `installPackage`; a failed install is a ✗. The install check (always; no network beyond that install, no init/sync, a factory isn't called) runs the loader's exported steps one by one — spec, install dir, manifest, entry inside the package, the real `import()` with the host resolve hook, the default export's form — and, for an object export, the registry's checks (apiVersion, the external id pattern, no duplicate ids across packages or with the built-ins). Import errors get a hint (a native-module ABI mismatch names this Node's `NODE_MODULE_VERSION`; a missing dependency; TypeScript in node_modules). With `--config` (one package only, else a usage error; `team` = its config.json `config`) it calls the factory with the frozen options and a temp `teamDir`, then runs `init` and `sync` twice (bounded by `syncTimeoutMs`) against a throwaway `SourceContext` (temp dir, in-memory kv, recording no-op `enqueue`/`enqueueRevision`/`upsertDef`, no WorkDefs) — the real team dir is never written — and validates the items (`invalidExternalDef`, duplicate externalIds, a mirror id over the 255-byte name limit, revision stability); `--hooks` calls `onComment`/`onItemTerminal` (a fake COMPLETE item) on the first item. Prints ✓/⚠/✗ per check grouped by package and source (or the `DoctorReport` as JSON); exit 0 only with no ✗. `main.ts` exits once stdout flushes, so a plugin's open handles can't hang it.
- `legacy.ts` — `mpt adopt-legacy-internal <node> <bridge> [service]`, the TypeScript half of `scripts/legacy-bridge.sh` (DESIGN.md "Moving Old Binaries Across"): saves `<node>` as the configured Node when none is, and with `service` re-points an old service that launches the bridge's path with no entry script — TEAM_DIR/PORT read back with `service.ts` `parseServiceEnv`, `unloadServiceForRewrite` (launchd), `install()`, then a systemd restart. Side effects via `AdoptDeps`.
- `node-choice.ts` — `ensureNodeConfigured({ interactive, assumeYes })`: settles which Node runs mpt — a valid saved/overridden one is used (an override is saved); otherwise suggest `process.execPath` (or a stable spelling of it on PATH / a well-known location), ask (or, with no terminal or `--yes`, take it), validate, save. A saved Node that stopped working is re-asked, or fails clearly with no terminal.
- `service.ts` — launchd plist / systemd user unit generation (both run `[<configured node>, <abs entry: cli/main.ts or dist/main.js>, "start"]`, with TEAM_DIR, PORT and the installing shell's PATH), detection of an installed service and the Node + entry script it launches, and `restart()`.
- `features.ts` — The CLI's side of the feature toggles: `statusSummaryLines` (what `mpt status` prints — a switched-off kind's counts left out, plus a `Turned off: …` line) and `daemonErrorMessage` (a 403 `{ feature }` → `featureDisabledMessage`, the wording shared with the Pi tools from `harnesses/pi/src/runtime/client.ts`). The CLI has no work-item commands, so nothing else is gated.

### agent/

The experimental ACP supervisor (DESIGN.md "Harness Tiers, and Why Not MCP"). Part of the
`mpt` package; imports the Pi extension's harness-agnostic `runtime/` (`client.ts`,
`transcript.ts`) directly.

- `acp.ts` — `AcpConnection`: JSON-RPC 2.0 over a child's stdio, one object per line. `initialize` (no fs/terminal; accepts `notice` updates so agents don't write notices into replies), `newSession`, `setMode`, `prompt`, `cancel`; notifications to handlers; agent → client requests answered by one handler, unknown ones with "method not supported"; `permissionOutcome` (never an "always" option).
- `harnesses.ts` — `ACP_HARNESSES`: how to launch each — Kiro `kiro-cli acp`; Claude the pinned `@agentclientprotocol/claude-agent-acp` under `~/.my-pizza-team/acp/claude/` run with node, `CLAUDE_CODE_EXECUTABLE` pointing at the user's own `claude` — and the session mode to set (Claude: `default`).
- `supervisor.ts` — `AgentSupervisor`: register (retrying while unreachable; a 409 refusal is final), heartbeat (dismissed → stop; reregister), and the loop: poll → claim → `session/new` (+ mode) → the daemon's prompt plus `failInstructions` → on `end_turn` a `[done]` comment with the reply after the last tool call and COMPLETE, unless the item was already failed (`getWorkItemState`); other stop reasons, errors, and the agent exiting fail the item with the reason. Permission requests → allow once. `session/update` → the transcript mirror (message segments split at tool calls, tools, thinking) and the tmux window; `usage_update` cost in USD + the prompt result's tokens → `/api/agents/:id/usage` (no report when the agent gives neither). On stop it fails any item in hand before deregistering.

### plugin/

- `index.ts` — The public plugin surface, the package's `./plugin` subpath export (`my-pizza-team/plugin`): re-exports the `WorkSource` / `SourceContext` types and those in their signatures (`ExternalDef`, `WorkSourceMode`, `SourceKv`, `RunResult`, `ItemTerminalOutcome`, `SourceToggle`, `RevisionCursor`, `EnqueueRevisionOptions`, `ActiveSourceItems`, `PluginFactory`, `PluginFactoryContext`, `WorkDef`, `WorkItem`, `Comment`, `TeamConfig`) and the runtime constants `WORK_SOURCE_API_VERSION` and `SOURCE_ID_PATTERN`. Nothing store-internal; what's here is API (GUIDE.md "Writing a Work Source plugin").

### shared/

- `types.ts` — Domain types (`TeamConfig`, `WorkflowConfig`, `Story`, `WorkDef`, `WorkItem`, `Schedule`, `Template`, `Member`, `TeamReadiness`, `Thought`, …), `DEFAULT_CONFIG`, `DEFAULT_HARNESS_TEMPLATES`, team-dir constants, `resolveMinTeammates`, the feature toggles (`FeaturesConfig`, `FEATURE_NAMES`, `resolveFeatures` — absent ⇒ on, `NEW_TEAM_FEATURES`, `newTeamConfig`), `normalizeDirectory` (`~` expansion, trailing-slash strip, symlink resolution via `realPathSync` with string fallback), `slugify`, `generateTeammateName`.
- `protocol.ts` — Request/response contracts for the HTTP API, and `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION`.
- `frontmatter.ts` — The small YAML-like frontmatter parser/serializer used by markdown files.
- `paths.ts` — Where mpt's own files are, from source and from the installed npm package alike: `packageRoot()` (walk up to the package.json named `my-pizza-team`), `isRunningFromSource()` (false iff this module lives under `<root>/dist/`, the compiled package), `cliEntryScript()`, `uiDistDir()`, `piExtensionDir()`.
- `main-module.ts` — `isMainModule()`, Node's stand-in for `import.meta.main`.
- `runtime-config.ts` — The saved Node setting, `~/.config/mpt/runtime.json` (`$XDG_CONFIG_HOME/mpt/` on Linux if set): `{ node, chosenAt }`, written atomically, unknown keys kept. `configuredNode()` applies `--node` > `MPT_NODE` > file. `checkNode()` validates (exists, executable, `<node> -p process.versions.node` meets package.json `engines`), never resolving symlinks — `/opt/homebrew/bin/node` must survive `brew upgrade`. `pinnedNodeManager`/`pinnedNodeWarning` flag version-pinned paths (nvm, fnm, volta, asdf, mise, Homebrew Cellar) and `stableNodeAlternative`/`suggestedNode` find a stable one. Used by the CLI and by `daemon/self.ts`.

### ui/src/

**Shell.** `App.tsx` is the router and the two-column shell (`h-dvh`, so each region
scrolls itself): the `SideDock` on the left and the center (NavBar + scrollable
`<main>`), with aligned `h-14` headers. The center is a Tailwind `@container`, so the
nav adapts to the space the dock leaves. `/assistant` redirects to `/` and opens the
dock's Assistant tab. Before either shell mounts, `App.tsx` routes `/m` and below to
the **phone shell** (`mobile/`, below), and sends a phone (`lib/mobile.ts`
`PHONE_QUERY`) landing on `/` there unless it chose the desktop view
(`shouldRedirectToMobile`, `mpt.mobile.view` in `localStorage`).

**Feature toggles** (see "Feature toggles"). `hooks/useFeatures.ts` holds the resolved
toggles from `/api/status` in one module-level cache (`useSyncExternalStore`; refetched
on `notifyFeaturesChanged()` after a Config save, and every 30s while subscribed);
`null` until loaded, and gated things stay hidden until then. `lib/features.ts` is the
pure, tested half (tests/features-ui.test.ts): hand-mirrored names/defaults,
`featureForPath`, `featureForProposalKind`, and `filterByFeatures` (used by
`lib/start-work.ts` and Config's tabs — Workflows carries `feature: "stories"`).
The same cache carries `/api/status` `assistantChatMode`, read with
`useAssistantChatMode()` (`null` until loaded; anything but `"terminal"` is `"chat"`).
`lib/work-items.ts` gates the Work sub-tabs the same way (Board/Tasks/Schedule
by their kind; Pending/Archived while any kind is on; an external source's tab while
its `externalSources[].feature` is on — `isExternalSourceOn`) and hides the NavBar's Work
Items item when all three are off. Plugin sources' flags pass through `resolveFeatures`
(`Features` is the built-ins plus any string key); `ExternalSourcePage` shows
`FeatureOffNotice sourceLabel=…` for a switched-off source.
Config's Workflows tab is gated inside `ConfigPage` (it isn't its own route element),
which renders `FeatureOffNotice` there while Stories are off.
`components/FeatureGate.tsx`: `App.tsx` wraps every page of a gated kind in
`FeatureRoute` (or `WorkDefFormRoute` for `/work-defs/new?type=`), which renders
`FeatureOffNotice` ("turned off — enable it in Config") instead of the page;
`/work-defs/:id` isn't wrapped (its kind is known only once loaded), so
`WorkDefDetailPage` shows the notice on the daemon's 403. The triage page disables
Accept/Edit for a proposal of a disabled kind. The phone view has no work-kind entry
points, so it's unaffected.

- `components/NavBar.tsx` — Center-column nav: **Thoughts · Work**, then pause/resume, Usage, Help, Config (lit for every `/config/*` route, Workflows and Context included), and the theme toggle. The Pizza Team (home) link's icon carries two count badges — `queuedCount` (READY, neutral) and `unreadInboxCount` (unread COMPLETE/FAILED, accent) from one shared `/api/status` poll (10s, also feeding the pause toggle), hidden at zero, capped at 99+ (`lib/inbox.ts` `badgeLabel`); the Inbox fires `lib/inbox.ts` `INBOX_CHANGED_EVENT` after read/unread so they refetch at once. The lit tab comes from `lib/nav-section.ts` `navSectionForPath` (first-segment match): Work for `/work/*`, story/task pages, and the legacy list URLs; on `/work-defs/:id` the bar fetches the WorkDef's type to pick the section (Solitary/Scheduled/Board/External → Work, Triage → Thoughts), and `/work-defs/new` uses `?type=`. The same module gives the WorkDef pages' Back fallback (`workDefHomePath` — the type's Work sub-tab) and `BackButton`'s in-app-history test (`canGoBackInApp`, from the router's `history.state.idx`).
- `components/RouteTabs.tsx` — Route-driven segmented tabs, used by RootPage (Queue/Inbox), `WorkItemsTabs.tsx` (Board/Tasks/Schedule/Pending/Archived), and ConfigPage (General/Teammates/Workflows/Context/Triage/Theme, from `lib/config-tabs.ts`).
- `components/TabbedPageLayout.tsx` — The shared frame for the Work and Configuration surfaces: title + tab bar pinned upper-left with fixed `p-6` padding, the tab's body below (left-aligned; it may cap its own width, e.g. `max-w-3xl`, while the Board stays full width). Each tab used to set its own centered container, so the header jumped between tabs. Work tabs use it through `WorkItemsLayout` (in `WorkItemsTabs.tsx`, titled "Work"); ConfigPage wraps every tab, including the embedded Workflows/workflow detail/Context pages. Guarded by `tests/tabbed-layout.test.ts`.
- `components/dock/SideDock.tsx` — The dock: header row (`NewWorkMenu` `+` → `lib/start-work.ts` destinations; `queue/QueueSummary.tsx` counts + hover preview; collapse), tab row (Assistant with presence dot + unread badge; Team with online count + amber dot; the active tab's actions), both bodies kept mounted, drag-resize (300–560px), collapsed icon rail, floating panel below `lg`. Owns `useAssistantStream`, `useTeamData`, and `useQueue` so badges stay live. `SideDockProvider.tsx` + `hooks/useSideDock.ts` hold open/tab state in `localStorage`.
- `components/assistant/*` — `AssistantPane` (the dock's and phone's Assistant body: `AssistantChat`, or in `assistant.chatMode: "terminal"` `AssistantTerminal` — `useTranscriptStream` + `AgentTerminal` pointed at the leader, composer always open; choice in `lib/assistant-mode.ts` `assistantView`, live from `useAssistantChatMode`, history sessions always as chat; tests/assistant-mode-ui.test.ts), `AssistantChat` (presentational, so collapsing can't drop the SSE connection), `MessageBubble`, `BubbleDialog`, `ThinkingBubble` → `ThoughtsPanel`, `Composer` (never locks; quoted replies), `QuotedMessage`, `SessionMenu`, `PersonaChips`. `hooks/useAssistantStream.ts` owns the SSE subscription plus a 15s reconcile poll; `hooks/useMediaQuery.ts` picks docked vs floating. On a touch screen (`(pointer: coarse)`) the composer's Enter is a newline and bubble actions show without hover.
- `components/team/TeamPanel.tsx`, `TeamParts.tsx` — The Team tab: teammate rows (never the leader) linking to `/teammates/:id`, pending and failed spawns, the version-skew banner with restart, offline members. Status is `StatusIcon`'s shape (person pairing · bot waiting · spinning loader working · cloud-off lost contact), `ModelName` the model, and `SessionStats` context fill and session cost; both are reused by the rail avatars and the teammate page header. `lib/team.ts` holds types, `roleOf`, `viewPath`, `harnessSkew`, and the wording rules (`statusLabel`, `formatContext`, `formatTokens`, `formatCost`, `modelTitle`).
- `components/TeamSizeDialog.tsx` — Declared team size over `/api/teammate-pool` (online/starting counts, default indicator, **Use default**, no-leader warning).
- `components/SpawnDialog.tsx` — Spawn one teammate in a chosen directory (a `spawn` directive with `cwd`).

**Pages.**

- `pages/RootPage.tsx` — Home tabs: **Queue** (`/queue`, `QueuePage.tsx`: At risk → Waiting → Working, with stall banner — the list is `QueueList`, fed by its host, so the phone view reuses it; `hooks/useQueue.ts`, `lib/queue.ts`) and **Inbox** (`/`, `InboxPage.tsx`: paginated terminal WorkItems, unread by default, each deep-linked to its WorkDef's Thread tab — board tasks via `/task/:storyId/:id`, standalone via `/work-defs/:id`; `lib/work-item-link.ts`).
- **Work** (`/work/*`, `lib/work-items.ts`, tested in `tests/work-items-ui.test.ts`) — one surface with route-driven sub-tabs (`components/WorkItemsTabs.tsx`): **Board** `/work/board`, **Tasks** `/work/tasks`, **Schedule** `/work/schedule`, **Pending** `/work/pending`, **Archived** `/work/archived`; `/work` lands on the first enabled tab (`defaultWorkItemsPath`). Each registered external Work Source adds a read-only tab, `/work/source/:sourceId` (`workItemsTabLinks`, between Schedule and Pending; none when `/api/status` `externalSources` is empty — `hooks/useFeatures.ts useExternalSources`), rendered by `pages/ExternalSourcePage.tsx`: its mirrored defs (title, Open in <source>, revision, latest WorkItem state, run count; **Show archived**, **Sync now**), helpers in `lib/external-sources.ts` (tested in `tests/external-sources-ui.test.ts`). A mirrored def opens on the ordinary `WorkDefDetailPage` with `WorkDefDefinition readOnlyNote` (no Edit/Delete), an Open in <source> link, and Back to its source's tab. Board, Tasks, and Schedule list **active** work only; pending and archived work of every kind lives on the last two tabs. The old `/board`, `/tasks`, `/schedule`, `/pending`, `/backlog`, `/archived` (and `/templates[/:id]` → Tasks) redirect with `replace` (`legacyWorkItemsPath`).
- `pages/BoardPage.tsx` — Work → Board. Story swimlanes (`board/StorySwimlane.tsx`) of task cards (`board/TaskCard.tsx`: title, assignee, cost, WorkItem chip, `details →`). Drag-to-move posts `/api/tasks/:id/move`; the drag MIME type (`board/task-drag.ts`) carries the story id so lanes only accept their own tasks. The board body (`StoryBoard`) lists active stories only; each lane has ⌛ **Make pending** via `POST /api/stories/:id/pending` (activate it again from the Pending tab), plus a `pending` badge. Todo/done bucket columns can be hidden per story (`localStorage`). Lanes collapse to their header row via a chevron, with **Expand all / Collapse all** in the toolbar; that state is lifted into the page (`hooks/useStoryCollapse.ts`) so bulk changes reach every lane, and persisted per story by `lib/storyCollapse.ts` (tested in `tests/story-collapse.test.ts`).
- `pages/LifecyclePage.tsx` (`state="pending"|"archived"`) — Work → Pending / Archived, each **one mixed list** of stories, Solitary tasks, and scheduled jobs; rows, kind chips, search, and newest-first order come from the pure `lib/lifecycle-list.ts` (tested in `tests/lifecycle-list.test.ts`). Composed client-side from the existing endpoints — Pending: `/api/stories` (pending), `/api/work-defs` (pending Solitary; Scheduled jobs whose definition or Schedule is pending, `isActiveScheduledJob`), `/api/schedules`; Archived: `/api/archived`, `/api/work-defs?status=archived` — rather than a new aggregate route, since the lists are small. A switched-off kind isn't fetched (`useApi(null)`) and its chip is hidden. Pending rows: **Activate** (`/api/stories/:id/activate`; a WorkDef's `/activate` while its definition is pending, else `/api/schedules/:id/activate`) and **Archive**. Archived rows: **Restore** / **Delete** for WorkDefs; stories have no unarchive route, so their row expands to the synopsis. Board tasks aren't separate rows (a pending one holds its place in its story's swimlane). Timestamps: `archivedAt` for stories, otherwise a WorkDef's `lastRunAt` or its Schedule's `lastEnqueuedAt` — the API has no "became pending" time.
- `pages/WorkflowsPage.tsx`, `pages/WorkflowDetailPage.tsx` — Config's **Workflows** tab (`/config/workflows`, `/config/workflows/:name`): list/create workflows and edit states (saved through `PUT /api/config`), set the default, and edit personas (`workflow/PersonaEditor.tsx`, via the instructions API with lint warnings).
- `pages/NewStoryPage.tsx`, `pages/StoryDetailPage.tsx`, `pages/NewTaskPage.tsx` — Story creation (workflow, directory, context, inline tasks; **Save tasks as pending**), story editing (title, description, directory, context, task order, archive, delete; a header **Make pending** / **Activate** toggle that applies at once), and task creation in a story (**Save as pending**). The pending buttons are a second submit button; the handler reads `SubmitEvent.submitter`.
- `components/WorkDefDefinition.tsx` — The Details tab's definition section shared by both WorkDef pages: read-only when active (with the "comment + re-run" hint), and while pending a banner with **Edit** (the form, `PUT /api/work-defs/:id`) and **Activate** (`POST …/activate`). Also `PendingBadge`, used on headers, list rows, and board cards (`board/TaskCard.tsx`).
- `pages/TaskDetailPage.tsx` — A board task (a WorkDef with a story parent): **Details** / **Thread** tabs (`ui/detail-tabs.tsx`, `?tab=`), the definition via `WorkDefDefinition`, plus breadcrumb, workflow status + move, and delete (`DELETE /api/tasks/:id`).
- `pages/TasksPage.tsx`, `pages/SchedulePage.tsx` — Work → Tasks / Schedule: **active** Solitary and Scheduled WorkDefs (filtered by derived type; Tasks drops pending ones via `lib/pending.ts` `filterByPending`, tested in `tests/pending-ui.test.ts`), with Run / Run now, per-row cost, and Archive (to the Archived tab). Tasks has a per-row run count, the **Never run** filter, and a run-count sort (`lib/run-count.ts`, tested in `tests/run-count.test.ts`). Schedule joins `/api/schedules` for cron and shows the run count and last run (falling back to the Schedule's `lastEnqueuedAt`); a job whose definition *or* Schedule is pending is on the Pending tab instead; each row's **Make pending** pauses its Schedule (`WorkDefDetailPage` has a Make pending / Activate toggle in its header). `WorkDefDetailPage` and `TaskDetailPage` show the count as a header badge.
- `pages/NewWorkDefPage.tsx` — Shared create form (`/work-defs/new?type=Solitary|Scheduled`; any other type, incl. the retired `Template`, is Solitary): cron presets and auto-created Schedule for Scheduled, "enqueue now" for Solitary. Acceptance criteria use `ui/acceptance-criteria-editor.tsx` (RFC 2119 scoring).
- `pages/WorkDefDetailPage.tsx` — Standalone WorkDef page with Details (`WorkDefDefinition`, plus a separately saved cron for Scheduled) / Thread tabs and Run now (disabled while pending). A triage-mode mirror adds a leading, default **Triage** tab (`?tab=triage`; `components/triage/MirrorTriagePanel.tsx`) and its Run is **Triage now** (disabled while a run is in flight or it's archived — `lib/triage.ts mirrorTriageNowBlocked`).
- `pages/NewWorkDefPage.tsx` also offers **Save as pending**.
- `pages/ContextPage.tsx` — Config's **Context** tab (`/config/context`): the context library (`board/ContextSelector.tsx` attaches entries elsewhere).
- `pages/TriagePage.tsx` — A note's triage page (`/thoughts/:id/triage`): where a note becomes work — the note, the latest analysis, Accept / Edit / Reject per proposal, earlier rounds, Triage now. See "Thoughts" above.
- `components/triage/TriageAnalysis.tsx` — The analysis half of every triage view (`LatestAnalysis`: latest analysis, pending proposals with Accept / Edit / Reject, decisions; `EarlierAnalyses`), shared by `TriagePage` and `MirrorTriagePanel`; its decision state is `hooks/useProposalDecisions.ts` (the caller supplies the accept/reject URL).
- `components/triage/MirrorTriagePanel.tsx` — A triage-mode external item's Triage tab: the item read-only with Open in <source>, beside `LatestAnalysis`, then `EarlierAnalyses`; decisions go to `/api/work-defs/:id/triage/proposals/:pid/…`.
- `pages/ThoughtsPage.tsx` — Thoughts: owns the notes, groups, and every mutation, and switches between two views (**Canvas | List**, `mpt.thoughts.view` in `localStorage`), carrying the selection across. Both sit under one shared toolbar row the page renders — **+ Note** first, then the view's own tools (canvas: Group, Tidy, Select, Map; list: Folder), and at the right zoom (canvas only), Archived, and the switch — so the fixed controls never move when you change view. The **canvas** is this page: pan/zoom (`lib/wheelGesture.ts`), drag/multi-select/marquee, keyboard shortcuts, minimap + group chips, uniform cards, group plates, drag-and-drop membership, Tidy, archived drawer; geometry in `lib/thoughtGeometry.ts`, colors in `lib/thoughtColors.ts`, checklist toggling in `lib/taskMarkers.ts`. The **list** is `thoughts/ThoughtsList.tsx`: folders (groups, alphabetical, collapsible — `mpt.thoughts.collapsedFolders`) then ungrouped notes, search, ↑/↓, drag a row onto a folder to file it, and the selected note in a pane. Its rules (titles/snippets, ordering, search, keyboard order, and where a note lands on the canvas when the list files it — `placeForGroupChange`, `slotInPlate`, `slotBelowAll`) are pure in `lib/thoughtList.ts`. Both views edit through `thoughts/NoteEditor.tsx`: framed by `thoughts/NoteDialog.tsx` on the canvas (saves on close) and inline in the list (autosaves). `thoughts/CopyId.tsx` is the copy-id chip.
- `pages/UsagePage.tsx` — Tiles, a 53-week contribution grid, the split by kind, and a collapsed glossary. Token figures exclude cache reads unless "Include cached" is on (localStorage `mpt.usage.includeCached`); pure helpers (`tokensOf`, `metricOf`, `peakDay`, grid math) in `lib/usage.ts`.
- `pages/TeammatePage.tsx` — A teammate's live transcript with Pair and Resume / Complete / Fail. The body is `transcript/AgentTerminal.tsx` (`transcript/TranscriptView.tsx` + `transcript/PairComposer.tsx`, fed by `hooks/useTranscriptStream.ts`, `lib/transcript-types.ts`), shared with the assistant's terminal mode so the two views can't drift; the composer shows only while paired.
- `pages/ConfigPage.tsx` — Route-driven tabs (`lib/config-tabs.ts`, pure and tested in tests/config-tabs.test.ts: `CONFIG_TABS`, `configTabFromPath`, `visibleConfigTabs` — Workflows hidden while Stories are off — `tabSavesConfig`, `workflowPath`, and `legacyConfigPath`, which `App.tsx` uses to redirect the old `/context`, `/workflows`, `/workflows/:name` URLs with `replace`). The config.json draft lives above the tabs, so General/Teammates/Triage edits save together with the one **Save Configuration** button (shown only on those tabs); the save sends the daemon's current `workflows` rather than the draft's, since the Workflows tab saves them separately. **General** (the **Assistant** chat-mode radio — `assistant.chatMode`, chat/terminal; the **Work items** feature toggles — a toggle that's on and in use is disabled with `featureUsage`'s "archive or delete … first", an external source still holding mirrors instead offers **Turn off and archive N items** (confirm dialog → `POST /api/work-sources/:id/disconnect`), the list is built from `featureSources` (`lib/features.ts` `featureToggleRows`), a 409 is shown inline, and `features` is only sent when a toggle changed so an unrelated save doesn't write the block; port, tmux session, max/min teammates, default workflow, readiness probe, favorite directories — saved immediately via `/api/directories/favorites`, autosave), **Teammates** (name nouns; the `exclusiveDirectories` "One teammate per directory" checkbox; experimental harnesses + default harness — off resets the default to Pi), **Workflows** and **Context** (the pages above, embedded; own saves), **Triage** (auto-triage `triage` settings with the page's Save, plus the `triage.md` editor saved via `PUT /api/triage/instructions`), **Theme** (palette; client-side via `lib/theme.ts` and `ThemeToggle.tsx`).
- `pages/HelpPage.tsx` — Renders `GUIDE.md`, copied to `src/content/guide.md` by the `prebuild` script.

**Phone view** (`/m`, docs/DESIGN.md "A Phone Is a Peek"). Its own shell, built from
the desktop's parts; no daemon routes of its own.

- `mobile/MobileShell.tsx` — Header (pause state, theme, 🖥 desktop view), a queue summary strip, the active tab, and bottom tabs **Team · Chat · Thoughts · Inbox** with live badges (at-risk / attention dot, unread chat via `lib/unread.ts`, unread Inbox count). Owns `useAssistantStream`, `useTeamData`, `useQueue`, `/api/status`, and the unread Inbox count; keeps all four tabs mounted. Tab from path: `lib/mobile.ts` `mobileTabOf`. Safe-area padding (`env(safe-area-inset-*)`, with `viewport-fit=cover` in `index.html`).
- `mobile/MobileTeam.tsx` — Teammates (`TeammateRow` with `href` to `/m/teammates/:id` and no actions; spawn summaries) and the queue (`pages/QueuePage.tsx` `QueueList`). `/m/teammates/:id` renders `TeammatePage` under a back link.
- `mobile/MobileChat.tsx` — Presence + `SessionMenu` over `AssistantPane` (its `active` prop re-scrolls when the tab is shown).
- `mobile/MobileThoughts.tsx` — The list (`buildThoughtTree`: collapsible folders, search, `TriageBadge`) and `/m/thoughts/:id`: Preview (tappable checklists) / Edit (a textarea, autosaving 600ms after typing and on leave), color, pin, archive, delete. New notes: `POST /api/thoughts` with `nextRotatedColor`, placed by the daemon.
- `mobile/MobileInbox.tsx` — Latest 30 finished items; a row opens in place, marks read, and shows the run's closing comment from `GET /api/work-defs/:id/comments` (`inboxOutcome`, `outcomeBody`), with Open full. Opened rows are retained across polls (`mergeInboxRows`).
- `lib/mobile.ts` — The pure rules: `isMobilePath`, `shouldRedirectToMobile`, the view preference, `mobileTabOf`, `inboxOutcome`, `outcomeBody`, `mergeInboxRows`. `lib/unread.ts` — `countUnread`, shared with the dock.

**Shared UI.** `viewer/FileViewer.tsx` (attachment lightbox) and `viewer/DiffViewer.tsx`
(line-comment review); `components/ui/*` (shadcn primitives plus markdown, title,
directory, and back-button fields — `ui/directory-input.tsx` is the one directory
picker: favorites then recent from `GET /api/directories`, a star per row, ordering in
`lib/directories.ts`, and a window event that keeps every mounted picker in sync); the **big editor** — `ui/full-editor.tsx`
(`useFullEditor` hook + full-screen overlay: preview, submit plumbing; and the
shared pieces `CodeEditorSurface`, `useVimPref` — one vim setting synced live across
editors — `VimSwitch`, `VimStatus`) lazy-loading `ui/code-editor.tsx` (CodeMirror 6
+ `@replit/codemirror-vim`, line numbers; `:w`/`:wq`/`:x`/`:q` routed per editor
view to the host's `EditorCommands`), with its pure rules (vim default, `/editor`
parsing) in `lib/editorPrefs.ts`. Full-screen in `Composer` and `PairComposer`; **inline** as the Edit mode of
`ui/markdown-field.tsx` (grows with its content, `minLines`) and `NoteEditor`, where
`NoteDialog` cancels Esc from inside a vim editor (`[data-vim="on"]`)
(docs/DESIGN.md "The Big Editor"); `hooks/useApi.ts` (fetch + optional polling);
`lib/assistant-types.ts` (hand-mirrored wire types).

### harnesses/pi/

A **pure HTTP client** of the daemon with no server-side code; it owns no state.
Roles are chosen by flag: `--ppt-lead` (leader) or `--ppt-worker` (teammate), with
`--ppt-name`, `--ppt-daemon`, `--ppt-tmux-session`, `--ppt-tmux-window`.

```
src/
├── index.ts        — Role detection, flag registration, teammate commands, wiring
├── leader.ts       — Leader: registration, directive polling (fallback spawns, reset-session → /new), /ppt-* commands, the chat mirror, the transcript mirror
├── teammate.ts     — TeammateLoop: poll → claim → run the prompt → comment → set state; pairing and fresh sessions
├── chat.ts         — ChatMirror: daemon inbox → Pi (via `onDeliver`: steer, or the message's queue/steer mode), Pi prose → bubbles, terminal input → chat
├── session-transcript.ts — The ONE wiring of a TranscriptMirror to Pi events (`attachTranscriptMirror`) and of a web
│                     message into Pi (`deliverWebMessage`: tagged `web`, queue → followUp / steer mid-run), used by
│                     both the teammate (index.ts) and the leader (leader.ts) — tests/session-transcript.test.mjs
├── tools.ts        — LLM tools (role-specific): fail, stories/tasks/schedules (each with an optional `pending`), get/edit/activate a pending task, thoughts, workflows, context, team status, attachments
├── features.ts     — Feature toggles: the leader tools each kind owns, `applyFeatureTools` (keeps a switched-off kind's tools out of `pi.setActiveTools`), `featurePromptNote`
├── permissions.ts  — Autonomous permission handling via @gotgenes/pi-permission-system (optional; warns when absent)
├── runtime/        — Harness-agnostic protocol code: no external imports, no relative value imports,
│   │                 no mention of Pi (tests/runtime-purity.test.ts)
│   ├── client.ts     — DaemonClient: every HTTP call; `featuresFromStatus`, `featureDisabledMessage` (a 403 `{ feature }` → `DaemonError.feature`)
│   ├── transcript.ts — TranscriptMirror: streams the session while watched
│   ├── bubbles.ts    — Splits prose into chat bubbles (fence/list aware)
│   ├── pairing.ts    — WebPairing: pause/message/release from the browser
│   ├── usage.ts      — Summarises a run's token usage
│   └── session-stats.ts — Model, context fill, session cost (Pi's footer numbers), reported after every turn
└── shared/types.ts — GENERATED from shared/types.ts by `npm run sync-shared`
```

The extension's own detail is in `harnesses/pi/README.md` and `harnesses/pi/docs/`.

### desktop/, scripts/, CI

- `desktop/macos/` — SwiftUI menu-bar app (`Sources/App.swift`, `Sources/DaemonManager.swift`): launches the npm-installed mpt (it bundles none): the saved Node from `~/.config/mpt/runtime.json` (or `MPT_NODE`) running the package entry found from `<dirname(node)>/mpt` → realpath, else from that Node's `npm root -g`; failing that, `mpt` on the login shell's PATH (`$SHELL -lc`, whose PATH it also passes to the daemon). With nothing found the menu says to `npm i -g my-pizza-team` and `mpt setup`. It polls `/health` (including `tmuxSession` and `leaderPresent`), start/stop/restart, open UI in a chosen browser, team-dir picker, reveal in Finder, open in a chosen terminal, and **Launch Leader** via an editable command template (`{session}`/`{dir}`/`{port}`/`{url}`). `Package.swift`; `scripts/package-macos-menubar.sh` builds it universal (arm64 + x86_64) into `desktop/macos/dist/My Pizza Team.app` (not the root `dist/`, which `npm run build` wipes) and injects the bundle's version from `package.json`. No entitlements: the app embeds no JS runtime.
- `desktop/windows/` — `tray.ps1` system-tray app and `My Pizza Team.bat` launcher (see its README). It runs `mpt` from PATH (`mpt.cmd`, npm's shim); it is no longer a release asset.
- `scripts/package-macos-menubar.sh`, `generate-icns.swift`, `publish.sh` (bump version, sync generated copies, tag — the tag triggers the release workflow, which publishes to npm), `legacy-bridge.sh` (published by the release workflow as `mpt-{darwin,linux}-{arm64,x64}` + `checksums.sha256`, the names an old compiled binary's `mpt upgrade` downloads; finds a Node >=24, installs the package with that Node's npm — `--force` when npm's `mpt` link is its own path, only from a terminal — saves that Node to `runtime.json` itself if none is, runs `adopt-legacy-internal … service` from a terminal (hiding the complaint of a package version that predates it), and execs `<node> <global>/my-pizza-team/dist/main.js`; when it can't, it restores the checksum-verified v0.27.0 binary over itself and runs that), `sync-version.ts`, `sync-shared.ts`, `ci-annotate.py` (failed tests → GitHub annotations).
- Root `package.json` / `package-lock.json` / `tsconfig.json` — mpt runs on Node.js (>=24) only. `package.json` owns the version and the npm scripts (`dev`, `start`, `mpt`, `check`, `test`, …); in a checkout Node runs the `.ts` sources directly by type stripping. `tsconfig.json` (`npm run typecheck`) checks the daemon/CLI/shared/scripts/tests with `erasableSyntaxOnly`, so the code stays runnable under Node's type stripping (no enums, namespaces, or constructor parameter properties), and as ESM with bundler-style resolution, since `harnesses/pi/` has no package.json `"type"` and `nodenext` would misread it as CommonJS. `harnesses/pi/package.json`'s and the lockfile's versions are `sync-version` copies of `package.json`'s.
- npm packaging — `npm run build` builds the UI (`ui:ci-build`) and compiles `main.ts`, `agent/`, `cli/`, `daemon/`, `shared/` (and the two `harnesses/pi/src/runtime/` modules they import) (and `plugin/`) to JS in `dist/` with `tsconfig.build.json`, then the `.d.ts` files for the `./plugin` export with `tsconfig.plugin-types.json` (declarations for `plugin/index.ts` and the modules its types come from only); Node won't strip types under `node_modules`, so the package must ship JS. `prepack` runs the build. The package's `bin` is `mpt` → `dist/main.js`; `exports` maps `./plugin` to `dist/plugin/index.js` (`types`: `index.d.ts`), and keeps `./package.json` and every other path (`./*`) reachable as before; `files` ships `dist/`, `ui/dist/` (`ui/.npmignore` stops npm applying `ui/.gitignore`, which excludes it), `harnesses/pi/package.json` + `src/` (what `cli/extension.ts` writes out), README and LICENSE. Runtime asset lookups go through `shared/paths.ts`, so the same code works from the checkout and from `<prefix>/lib/node_modules/my-pizza-team/`.
- `.github/workflows/ci.yml` runs every gate on Node 24 (`npm ci`): typecheck + fast tests + generated-files check, e2e (with real tmux), the extension's typecheck + tests, and the UI's `tsc -b` + lint. `release.yml` runs on `v*` tags: checks the tag matches `package.json`, runs `npm run check` + `npm test`, installs the `npm pack` tarball into a scratch prefix and checks `mpt setup --dry-run` finds the bundled Pi extension, then `npm publish --provenance` via npm Trusted Publishing (OIDC, no token; skipped when the version is already on npm); a best-effort job builds, signs and notarizes the menu-bar DMG; the GitHub Release carries generated notes, the npm tarball, the DMG, and `scripts/legacy-bridge.sh` under the old binary asset names with their `checksums.sha256` — no binaries or checksums.

### tests/

`npm test` runs `tests/*.test.ts` with `node --test`, one file at a time (daemon, CLI, and pure UI helpers such as
`thought-geometry`, `thought-list`, `mobile`, `acp` (against the fake agent), `usage-grid`, `wheel-gesture`, `harness-skew`) using
`tests/_config.ts`'s `TEST_CONFIG` (autosave off). `tests/e2e/` holds the slow suites
on the `_sandbox.ts` harness: CLI lifecycle, tmux lifecycle, git sync, readiness
probe, entry points (every way of starting the daemon gets the same daemon), and `agent` (`mpt agent` end to end against `tests/fixtures/fake-acp-agent.ts`: the gate, completion, fresh sessions, permissions, usage, `mpt agent fail`, a crash). Guard tests worth knowing: `version.test.ts` (extension version in step),
`protocol-version.test.ts`, `runtime-purity.test.ts`, `build-embeds.test.ts`,
`doctor-coherence.test.ts`. Assertions come from `tests/_assert.ts` (the `@std/assert`
names the suites were written with, on `node:assert/strict`; `assertEquals` treats
`node:sqlite`'s null-prototype rows like plain objects), and `tests/_globals.d.ts` gives
tests `Response.json(): Promise<any>`. The extension's suites are in `harnesses/pi/tests/`
(`npm run test:ext`).

## Agent Lifecycle

```
1. POST /api/agents/register          → {protocolVersion, harness, harnessVersion, directory, metadata}
2. GET  /api/agents/next-work?agentId → { workItem: {id, title} | null }   (null while paused)
3. POST /api/agents/claim/:id         → lease (→ IN_PROGRESS) + { workItem: {id}, prompt }
                                         (409 if its directory is leased meanwhile)
4. (the agent works, in the ref's directory, and posts its own comment)
5. POST /api/agents/work-items/:id/state {state: COMPLETE|FAILED}
6. POST /api/agents/:id/usage         → one line in the ledger
   POST /api/agents/:id/session-stats → after every turn: context fill + session cost (Team tab)
   POST /api/agents/heartbeat         → keep-alive; restores this agent's MORIBUND items
```

Members and assignments are **connection state**: cleared on daemon boot
(`resetConnectionsForBoot`), with any `IN_PROGRESS` item moved to `MORIBUND` (its
`member_id` kept, so the same agent can still complete it). A heartbeat from an
agent the daemon no longer knows gets `reregister` (a restart forgot it); one that
was explicitly dismissed (`DELETE /api/agents/:id?dismiss=true`) gets `dismissed`
and shuts down. A plain `DELETE` is a clean self-deregister and leaves no
tombstone. This keeps restarts and upgrades from silently killing teammates.

**Dismissing closes the window.** Spawn types `cd … && <harness>` into the
window's shell, so a harness that exits leaves a shell prompt behind. A dismiss
(`?dismiss=true`, from the UI or the leader's `/ppt-dismiss`) therefore also queues
a `dismiss` directive naming the member's window. The daemon waits for the agent to
exit by itself (a Pi teammate exits ~0.5s after hearing `dismissed`; an `mpt agent`
supervisor deregisters first), then sends C-c and kills the window on a later pass —
normally a few seconds after the agent's next heartbeat, and within ~30s even if it
never answers. When the daemon can't reach tmux, the leader is handed the directive
once it is ready and does the same (C-c, kill 2s later). Any other exit — a crash, a
user quitting, a plain self-deregister — leaves its window open so the error stays
readable.

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
queue. Templates are being deprecated: the web UI no longer shows them (no
Templates tab, no "task from template"; `/templates[/:id]` redirects to Work →
Tasks), while the API, CLI, and data are untouched.

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

**Auto triage** (docs/DESIGN.md "Auto Triage: a Note Is a Parent"). `daemon/triage.ts`
holds the pure rules — `triageSkipReason` (archived / empty / in-flight / unchanged /
too-fresh), the `triage-<noteId>` id, and the WorkItem title. The mechanics are the
Thought Work Source (`daemon/sources/thought.ts`): the sweep (its `tick`, on its own
timer every `triage.intervalMinutes`, default 60), **Triage now** (overrides
quiet/unchanged, refuses in-flight), the lazy WorkDef, and the status; the Store's
`runTriageSweep`, `triageNow`, `ensureTriageWorkDef`, and `triageStatusFor` delegate to
it, and the Store keeps `get/setTriageInstructions` (`triage.md`). The note's
frontmatter carries `triagedVersion`, stamped when a run is *enqueued* — the source
enqueues through `ctx.enqueueRevision` with `updatedAt` as the revision and that
frontmatter field as the cursor. `buildTriagePrompt` (daemon/prompt.ts, with
`DEFAULT_TRIAGE_INSTRUCTIONS`) assembles instructions + the note + its group name +
open stories + earlier analysis; the source's `buildPrompt` calls it, replacing the
base prompt. Archive/restore/delete of a note cascades to its WorkDef; the generic
`PUT`/`DELETE` WorkDef routes refuse one, and `enqueue` (Run) is Triage now.

**Triage subjects.** A note is one of two triage subjects; the other is a
**triage-mode external item** (DESIGN.md "Auto Triage" "The subject is a note or a
triage-mode mirror", and "External sources" "Triage mode"). There the read-only
mirrored WorkDef is the subject — no container — and the sync loop is the
enqueuer: `ingestExternalDefs` runs `enqueueRevision` as for any mirror, and
`sources/external-triage.ts` supplies the title, directory, prompt
(`buildExternalTriagePrompt` → the same `renderTriagePrompt` body `buildTriagePrompt` uses, with the
mirror's content in place of the note's), and Triage now. Everything from
`propose_work` on is the WorkDef-keyed half of the proposal layer below. The
end-to-end path is covered by `tests/external-triage.test.ts` (with the fixture
source's `mode: triage` frontmatter), and the mpt-demo-team repo's demo-tracker
plugin seeds a triage-mode issue that its `run-e2e.sh` checks against a live
daemon.

**Proposals.** An analysis is a `Comment` with `outcome` + `proposals`; a decision is
a `TriageDecision` line in the same `comments.jsonl`. `getThreadEntries` reads every
line, `getCommentsForRef` filters decisions out (so existing readers are unchanged),
and `appendThreadEntry` is the only writer. Pure helpers in `daemon/triage.ts`:
`validateAnalysis`/`validateProposal` (messages written to be actionable by the
agent), `foldProposals`, `latestAnalysis`, `pendingProposals`, `triageBadge`,
`decisionSummary` (fed to the next run's prompt). The Store adds
`addTriageAnalysis`, `getTriageThread`, `getTriageBadges`, `acceptProposal` (creates
`task`/`story-task`/`story`/`schedule`, stamps `origin` frontmatter, appends the
decision; `existingWorkDefId`/`overrides` serve the UI's "Edit" path),
`rejectProposal`, and `triageDecisionSummary`; both return a `ProposalResult` whose
failure carries a `code` so routes map it to 404/409 without reading the message.
Each note-keyed method is a thin wrapper over a WorkDef-keyed one —
`triageSubjectOf` (a note's container, a triage-mode mirror, or null),
`addTriageAnalysisForWorkDef`, `getTriageThreadForWorkDef`, `acceptProposalOn`,
`rejectProposalOn`, `triageDecisionSummaryForWorkDef` — which is what a triage-mode
external item uses (its `origin` is `{ workDef, proposal }`, frontmatter
`originWorkDef`). The teammate posts through `propose_work`
(harnesses/pi/src/tools.ts → `POST /api/agents/work-items/:id/proposals`,
holder-only and triage-only — the item's WorkDef must be a triage subject).

**UI.** `pages/TriagePage.tsx` (`/thoughts/:id/triage`) is the whole surface: the note
read-only, the latest analysis, pending proposals with Accept / Edit (an override form
built from `editableFields`, reusing `AcceptanceCriteriaEditor` and `DirectoryInput`) /
Reject, earlier rounds, and **Triage now**. `thoughts/TriageBadge.tsx` is a note's only
triage footprint on the canvas card and list row, fed by one `/api/triage/badges` poll
in `ThoughtsPage`. Wording and the hand-mirrored wire types live in `lib/triage.ts`
(`badgeTitle`, `outcomeLabel`, `kindLabel`, `editableFields`, `triageNowBlocked`,
`analysesWithDecisions`); `lib/work-item-link.ts` routes a `thought`-parented item to
the triage page (`hasThreadTab` is false for it, so the Inbox doesn't deep-link a
Thread tab it hasn't got). The analysis/proposal components are
`components/triage/TriageAnalysis.tsx` (with `hooks/useProposalDecisions.ts`), shared
with a triage-mode external item's **Triage** tab on its WorkDef page
(`components/triage/MirrorTriagePanel.tsx`, `GET /api/work-defs/:id/triage`); that
item's row on its source's Work tab wears the same `TriageBadge` (`to` +
`subject: "item"`, fed by the row's `triageBadge`), and `lib/work-item-link.ts` sends
its runs (`triage: true`) to `/work-defs/:id?tab=triage` (`mirrorTriagePath`). The
phone has no triage page for either subject: its Inbox shows the analysis and
**Open full** goes to the desktop view. `ThoughtsPage` accepts `?note=<id>` to select and centre one
note (adjusted during render — React's "adjusting state when a prop changes" — since
the notes load asynchronously). Config's General tab holds the sweep settings and the
`triage.md` editor (saved on its own, like a workflow persona).

## Feature toggles

`config.features` (`{ stories?, tasks?, schedules? }`) switches whole work-item kinds
off (DESIGN.md "Feature Toggles"). `resolveFeatures` applies the defaults: a missing
block or flag is **on**, so teams that predate the toggles are unchanged and nothing
is migrated. `DEFAULT_CONFIG` has no `features` (it is merged *under* every existing
config); `mpt setup` writes `newTeamConfig()` — `features: { tasks: true, stories:
false, schedules: false }` — when it creates a team dir. A team dir with no
`config.json` (e.g. one `mpt start` created) counts as existing: all on.

**Gating** is one module, `daemon/features.ts`, installed before the route modules. It
names no kind: every switchable feature is a registered Work Source's `toggle`
(`SourceToggle`: the `features.<name>` key, extra `routes`, optional `activeItems`), and
Thought declares none. The built-ins map to the historical keys:

| Feature | Gated routes |
|---|---|
| `stories` | `/api/stories*` (incl. `/:storyId/tasks*`), `/api/tasks/*`, `/api/archived`; `/api/work-defs/:id` (+ `archive`/`restore`/`activate`/`enqueue`) for a Board WorkDef; accepting a `story`/`story-task` proposal |
| `tasks` | `/api/templates*`; `POST /api/work-defs` (not Scheduled); `/api/work-defs/:id…` for a Solitary WorkDef; accepting a `task` proposal |
| `schedules` | `/api/schedules*`; `POST /api/work-defs` with `type: "Scheduled"`; `/api/work-defs/:id…` for a Scheduled WorkDef; accepting a `schedule` proposal |

A refused request gets **403** `{ success: false, error: "feature '<name>' is
disabled", feature }` — 403, not 404, so a client can tell "switched off" from "no
such item". `GET /api/work-defs` omits the disabled kinds' WorkDefs. **Never gated:**
`/api/work-items*` (Queue, Inbox, recovery), `/api/agents/*` (claim, comment,
complete — so work already queued finishes), the WorkDef thread surface
(`/api/work-defs/:id/comments|comment|attachments|token-usage`), triage WorkDefs,
Thoughts, Context, and the timers (the scheduler, admission). The gates read the live
config per request, so a `PUT /api/config` applies without a restart.

**Turning a kind off** through `PUT /api/config` is refused with **409** while it has
active items (`activeFeatureItems`, i.e. the source's `toggle.activeItems`): stories in `stories/` (pending ones included); active
Solitary WorkDefs plus every Template; active Scheduled WorkDefs. Pending WorkDefs count;
archived WorkDefs and stories don't. The message names the count ("Can't turn off
stories: archive or delete 3 stories first"). An already-off kind staying off, and
turning a kind on, are never refused. An object is a partial update stored in full;
`null` removes the block (all on). The resolved toggles are on `GET /api/status` and
`GET /api/config` as `features`; `GET /api/config` also carries `featureUsage`
(`featureUsage(store)`: each kind's `activeFeatureItems`), which the Config page uses
to disable a toggle the guard would refuse, and `featureSources` (`featureSources(store)`:
each toggle's `{ feature, sourceId, label, external }`, in display order), from which
it builds the list.

**External sources** get a toggle by default (`sources/registry.ts`
`effectiveToggle`: `{ feature: <id>, routes: [/api/work-sources/<id>/defs,
/api/work-sources/<id>/sync] }` when a `sync`-declaring source has no `toggle`;
`toggle: null` opts out). The effective toggle is stored on the `SourceEntry`
(`entry.toggle`) — features.ts reads only that — and the registry refuses a reserved
built-in name or one another source uses. While off, `SyncRunner` skips the source
(`skipped: "disabled"`, even when forced; a result landing after the switch is
dropped), the registry skips its `tick`, and its `SourceContext`'s `upsertDef` /
`enqueue` / `enqueueRevision` return null. A `PUT /api/config` that turns one on
fires a forced sync. The 409 for an external source names **`POST
/api/work-sources/:id/disconnect`** (`disconnectSource`): it sets the feature off in
the live config, then `Store.archiveExternalMirrors` archives each non-archived
mirror (marking `disconnected:<defId>` in its kv, which `upsertMirror` treats like
`vanished:` — restore on re-report), cancels READY items, leaves in-flight ones,
and saves config.json; 404 for a non-external source, 400 for `toggle: null`. The
web UI's side is under "ui/src/" (Feature toggles).

**Clients.** The Pi leader registers every tool but keeps a switched-off kind's
out of the model's active set (`harnesses/pi/src/features.ts`: Stories →
`create_story`/`edit_story`/`add_task`/`list_workflows`/`list_context`, Tasks →
`create_task`, Schedules → `create_schedule`/`set_schedule_pending`, all off → also `get_task`/`edit_task`/
`activate_task`), re-reading `/api/status` at session start, before every run, and
on its 10s poll, and adds a system-prompt note naming what's off; `propose_work`
refuses proposals of a switched-off kind. `DaemonClient` turns the 403 into
`DaemonError.feature` + "Stories are disabled — enable them in Config
(features.stories)" (`featureDisabledMessage`), the same wording `mpt status` and
`cli/features.ts` use. Detail: harnesses/pi/docs/ARCHITECTURE.md.

## Scheduler readiness gating

The Schedule Work Source (`daemon/sources/schedule.ts`, ticked every 30s; `Store.runScheduler` runs it on demand) enqueues each due Schedule's active child WorkDefs, deduped
per minute via `lastEnqueuedAt`, through `ctx.enqueue` (the single `enqueueFor`). `ctx.readiness.canEnqueueNow()` (the Store's `canScheduleNow()`) allows it when no agent is online
or the team is ready (`TeamReadiness`, set by the daemon's probe or
`POST /api/readiness`; unreported = ready). Otherwise the Schedule is marked
`heldForReadiness` without advancing its cursor, and fires once on recovery.
Rationale: DESIGN.md "Readiness Gating".

A **pending** Schedule is skipped before any of this: no firing, no hold, no
cursor advance; going pending clears `heldForReadiness`. The cron cursor is
`scheduleCursor(sched)` — the later of `lastEnqueuedAt` and `resumedAt` (stamped
on pending → active by `store/schedules.ts updateSchedule`) — so a reactivated
Schedule resumes at its next occurrence with no catch-up. A child WorkDef that is
itself pending is left out of an active Schedule's firing. Rationale: DESIGN.md
"Pending schedules: reversible, no catch-up".

The same readiness gates **automatic retries**: `getNextWorkItem` skips a READY item
with `attempt > 1` until its `retry_at` passes and the team is ready
(`isRetryDue`). `work_items` gained `attempt` (default 1), `retry_at`, and `error`
(migrated in place); `/api/work-items` returns them as `attempt`/`retryAt`/`error`.
Rationale: DESIGN.md "Errored Sessions Retry".

## API Routes

When a token is configured, every path except `/health` requires it. A route of a
switched-off kind answers 403 (see "Feature toggles").

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `status`, `uptime`, `agents` (online), `queueDepth`, `memory`, `lastCommitTime`, `tmuxSession`, `leaderPresent`, `notReady` (readiness when not ready, else null), `spawning` (spawn capability) |
| GET | `/api/status` | Story/task/member counts, `paused`, `queuedCount` (READY WorkItems), `unreadInboxCount` (unread COMPLETE/FAILED), `defaultWorkflow`, `workflows`, `features` (resolved toggles), `externalSources` (`[{ id, label }]`, the registered external Work Sources), `assistantChatMode` (`"chat"` \| `"terminal"`, `resolveAssistantChatMode`) |
| GET | `/api/work-sources` | The registered external (pull-only) sources and each plugin package's load status, `{ sources: [{ id, label }], plugins: [{ identity, spec, state: "loaded" \| "error", error?, sources }] }` |
| GET | `/api/work-sources/:id/defs` | Its mirrored defs (`?status=active` default, `archived`, `all`): `id`, `title`, `externalId`, `url`, `revision`, `status`, `latestState` (newest WorkItem, CANCELED included), `runCount`, `lastRunAt`, `mode` (`"triage"` for a triage-mode item), `triageBadge` (triage-mode items only). 404 for an unknown source |
| POST | `/api/work-sources/:id/sync` | Sync now, ignoring a failure backoff; returns the `SyncOutcome` (`mirrored`, `enqueued`, `archived`, `held`). 409 if one is already running, 502 if it failed |
| POST | `/api/control/pause` \| `/api/control/resume` | Pause/resume distribution (next-work returns null while paused) |
| GET | `/api/config` | Config + loaded `workflows` + `defaultNouns`; `features` is the resolved toggles; `featureUsage` is each kind's active items (`{ count, description }`, `activeFeatureItems`) |
| GET | `/api/directories` | `{ favorites, recent }` — favorites in the user's order; recent = online teammates' dirs, then recent WorkItem dirs, then story dirs (normalized, deduped, favorites excluded, max 20) |
| POST | `/api/directories/favorites` | `{ directory }` — append a favorite (normalized; no-op if present); 400 if empty |
| PUT | `/api/directories/favorites` | `{ directories }` — replace/reorder the list; 400 unless an array of non-empty strings |
| DELETE | `/api/directories/favorites?directory=` | Remove one (matched after normalization); 404 if not a favorite |
| PUT | `/api/config` | Update config (ignores `favoriteDirectories` — edited only via `/api/directories/favorites`, so a stale Config draft can't undo a star); requires `workflows` + a valid `defaultWorkflow`; validates and saves each workflow to `workflows/<name>/workflow.json`; `exclusiveDirectories` (boolean, `null` = default on; 400 otherwise), `experimental` and `defaultHarness` (a known harness; `""`/`"pi"` = unset; 400 for an unknown one or a non-Pi default without `experimental.harnesses`), `features` (partial object of booleans, `null` = all on; 400 for an unknown key or non-boolean, **409** when switching off a kind that still has active items — see "Feature toggles"), `assistant` (`{ chatMode: "chat" \| "terminal" }`, `null` = default chat; 400 otherwise — the persona route composes the leader's framing from it per request, so it applies on the leader's next run), applied live; reconciles the pool |
| GET | `/api/teammate-pool` | `{ minTeammates (effective), isDefault, maxTeammates, online, pending, leaderPresent }` |
| PUT | `/api/teammate-pool` | `{ minTeammates }` (non-negative integer, clamped to max; `null` = default) — persists and reconciles |
| GET | `/api/readiness` | `{ readiness }` (null if never reported) |
| POST | `/api/readiness` | Report `{ ready, reason? }` (the daemon's own probe also writes this) |
| GET | `/api/workflows` | Summaries: name, stateCount, agentCount, manualCount, isDefault |
| GET | `/api/workflows/:name` | Full `WorkflowConfig` |
| GET/PUT | `/api/workflows/:name/instructions/:state` | Read/write a persona; PUT lints (errors → 400; warnings returned) |
| GET/PUT | `/api/triage/instructions` | The team's `triage.md`; GET also returns the built-in `default`. Empty content clears it |
| POST | `/api/thoughts/:id/triage` | **Triage now**: enqueue a run for this note, skipping the quiet period and the unchanged rule (409 when one is in flight) |
| GET | `/api/thoughts/:id/triage` | The triage page's payload: the note, thread entries, proposals folded with decisions, `pending`, `badge`, `latestOutcome`, `skipReason` |
| GET | `/api/triage/badges` | `{ noteId: badge }` for every note with one (the canvas/list badges) |
| POST | `/api/thoughts/:id/proposals/:pid/accept` | Create the proposed work + record the decision. Optional `workDefId` (record work the author created via the normal form) and `overrides` (its edits). 404 unknown, 409 already decided |
| POST | `/api/thoughts/:id/proposals/:pid/reject` | Record a rejection (no reason, not a turn) |
| GET | `/api/work-defs/:id/triage` | Any triage subject by WorkDef id (a triage-mode mirror, or a note's container): `subject` (`thought` \| `mirror`), `thoughtId`, `mirror`, thread `entries`, `proposals` folded with decisions, `pending`, `badge`, `latestOutcome`, `latestState` (newest WorkItem's state, null if never run — the page's in-flight hint). 404 unknown, 409 not a triage subject |
| POST | `/api/work-defs/:id/triage/proposals/:pid/accept` | As the note route: create the work (never start it), append the decision to the def's thread. 404 unknown, 409 already decided; feature-gated by the proposal's kind |
| POST | `/api/work-defs/:id/triage/proposals/:pid/reject` | Record a rejection |

### Stories and board tasks

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/stories` | List (with tasks) / create (optionally with tasks) |
| PUT/DELETE | `/api/stories/:id` | Update (incl. `pending`; deprecated alias `paused`) / delete. `POST /api/stories` also takes `pending`; `GET /api/stories` views carry `pending` |
| POST | `/api/stories/:id/pending`, `/api/stories/:id/activate` | Make the story pending (nothing new admitted or handed out; an in-flight task finishes) / active again (re-runs admission). 404 unknown |
| POST | `/api/stories/:id/archive` | Archive (writes `archived/<id>.json` with a synopsis) |
| GET | `/api/archived` | List archived stories |
| POST | `/api/stories/:storyId/tasks` | Create a board task in a story (`pending:true` → a pending task that holds its place; deprecated alias `draft:true`). `GET /api/stories` task views carry `pending` |
| POST | `/api/stories/:storyId/tasks/reorder` | `{ order: [taskId, …] }` |
| POST | `/api/tasks/:taskId/move` | Judgment move to any position (buckets included) |
| DELETE | `/api/tasks/:taskId` | Delete (drops it from the story; frees the CONWIP token) |

### WorkDefs, Schedules, Templates, WorkItems

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/work-defs` | List (`?status=active` default, `archived`, `all`; each view has `pending`, `executionCount` — WorkItems created for it, CANCELED excluded — and `lastRunAt`, ISO or null) / create (enqueues unless `enqueue:false`; `pending:true` saves it pending, never enqueued; deprecated alias `draft:true`) |
| GET/PUT/DELETE | `/api/work-defs/:id` | Get / update / delete any WorkDef. PUT of a definition field is 409 unless it's pending; a cron-only PUT is always accepted. A mirrored (External) def: PUT and DELETE are 409 (pull only) |
| POST | `/api/work-defs/:id/activate` | End pending (409 if not pending; `/publish` is a deprecated alias for one release): locks it; Solitary is enqueued unless `{enqueue:false}`, Board runs admission (or enqueues in place), Scheduled waits for its cron. Returns `workItemId` (or null) |
| POST | `/api/work-defs/:id/enqueue` | Enqueue a READY WorkItem (409 while pending). On a triage-mode mirror (or a note's container) it's **Triage now**: force a run of the current revision (409 in flight / archived) |
| POST | `/api/work-defs/:id/archive` \| `/restore` | Archive (also stops cron firing) / restore |
| GET | `/api/work-defs/:id/comments` | The thread |
| POST | `/api/work-defs/:id/comment` | Add a comment |
| GET/POST | `/api/work-defs/:id/attachments` | List / upload |
| GET/DELETE | `/api/work-defs/:id/attachments/:filename` | Serve raw / delete |
| POST | `/api/work-defs/:id/token-usage` | Record usage on the ref (prefers harness `costUsd`) |
| GET | `/api/schedules`, `/api/schedules/:id` | List / get (`id, title, cron, lastEnqueuedAt, pending`) |
| PUT/DELETE | `/api/schedules/:id` | Update (`title`, `cron` validated, `pending` boolean) / delete |
| POST | `/api/schedules/:id/pending`, `/api/schedules/:id/activate` | Make the Schedule pending / active (reversible; activating resumes at the next cron occurrence). Returns `{ success, schedule }` |
| GET/POST | `/api/templates` | List / create |
| GET/PUT/DELETE | `/api/templates/:id` | Get / update / delete |
| GET | `/api/work-items` | List (`?state=`, `?read=`, `?limit=&offset=`) — Queue, Inbox, dock. A READY item held back by a directory lease carries `blockedBy: { workItemId, title, directory, memberId, memberName }`; a run on a triage-mode external item carries `triage: true` |
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
| GET | `/api/agents/next-work?agentId=` | Next READY item by directory affinity, skipping items whose directory is leased |
| POST | `/api/agents/claim/:workItemId` | Lease + prompt (409 if not claimable, including "directory busy" when an overlapping item is in flight) |
| POST | `/api/agents/work-items/:workItemId/state` | COMPLETE (advances a board task) or FAILED; only the holder (403 otherwise); posts no comment. FAILED + `sessionError` (the agent's model call failed) instead retries: the daemon posts `[retry]`/`[failed]` and returns `retry: { workItemId, attempt, maxAttempts, retryAt }` when it enqueued one |
| GET/POST | `/api/agents/comments/:workItemId` | Read / post comments on the item's ref |
| POST | `/api/agents/work-items/:workItemId/attachments` | Upload to the ref |
| POST | `/api/agents/work-items/:workItemId/proposals` | `propose_work`: an analysis (`body`, `outcome`, `proposals`) on a triage item — a note's, or a triage-mode external item's (returns `workDefId`, plus `thoughtId` for a note). Holder-only (403), triage-only (400), validated (400 with a fixable message) |
| POST | `/api/agents/:id/session-stats` | After every turn and on a model switch: `contextTokens`, `contextWindow`, `contextPercent` (each nullable), `costUsd` (the session's running total), `model` (`{id, name, provider}` or null). In memory; cleared on (re)register. Optional — an agent that never sends it shows no numbers |
| POST | `/api/agents/:id/usage` | One run: tokens incl. cache, `costUsd`, `model`, `kind` (`work`\|`pairing`\|`chat`\|`other`), optional `workItemId` |
| GET | `/api/agents` | Members (with handshake fields and `session` — the last session stats, or null) + the daemon's `protocolVersion` and `daemonVersion` |
| DELETE | `/api/agents/:id` | Unregister. `?dismiss=true` leaves a tombstone and queues a `dismiss` directive that closes its tmux window once it exits (never the leader's). A dismissed id deregistering on its way out gets 200 |
| GET | `/api/agents/:id/directives` | Self-handled directives (`new-session`, `resume-session`) |
| PUT | `/api/agents/:id/directives/:directiveId` | Mark one done/failed |
| GET/POST | `/api/leader/directives` | Pending queue (self-handled actions excluded; `dismiss` only when the daemon can't drive tmux and its agent has exited or its deadline passed) / create (`spawn` gets a generated `params.name`; an experimental `params.harness` is refused with 400 unless opted in) |
| PUT | `/api/leader/directives/:id` | Update status |
| GET | `/api/spawn-requests` | `{ requests (pending spawns), failed (failed spawns with reasons) }` |
| DELETE | `/api/spawn-requests/:id` | Mark a spawn directive `cancelled` (stops a pending one; clears a failed one from the list) |
| GET | `/api/agents/:id/transcript/stream` | SSE; subscribing is watching. `hello {entries}` then `entry` upserts |
| GET | `/api/agents/:id/transcript/watch` | Agent: `{ watched }` |
| POST | `/api/agents/:id/transcript` | Agent: batched `{ entries }`; recorded only while watched |
| GET | `/api/agents/:id/transcript` | Snapshot `{ entries, watched }` |
| POST | `/api/agents/:id/pair` | Start pairing (404 unknown, 400 leader) |
| POST | `/api/agents/:id/messages` | `{ text, mode: "queue"\|"steer" }` (409 unless paired). For the leader (assistant terminal mode): no pairing — always accepted (even offline) and appended to the assistant inbox as a `web` message carrying `mode`; pair/release stay teammate-only |
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
| GET/PUT | `/api/assistant/persona` | Active persona + effective system prompt (the `assistant.chatMode` framing — `ASSISTANT_CHAT_FRAMING` or `ASSISTANT_TERMINAL_FRAMING` — then the persona) / swap (ends + snapshots the session; `null` = default) |

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

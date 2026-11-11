# TODO

Known code issues and deferred work. Each item names a symbol rather than a line
number. Delete an item when it's done.

## Code health

- **Remove deprecated `worker` aliases (worker→teammate rename):** the persona kind
  `worker` became `teammate` (docs/DESIGN.md "Personas", "`worker` became `teammate`"),
  and the old spellings still work as deprecated aliases, each warning once per run:
  `kinds: [worker]` and `GET /api/personas?kind=worker` (→ `teammate`), `builtin:worker`
  (→ `builtin:teammate`), and Pi's `--ppt-worker` (→ `--ppt-teammate`). Removing them
  is the `remove-worker-aliases` story, in a future version: delete everything marked
  `DEPRECATED(worker→teammate)` (`rg 'DEPRECATED\(worker'` — `shared/types.ts`
  `LEGACY_PERSONA_*_ALIASES`, `daemon/personas/aliases.ts`, `shared/protocol.ts`,
  `ui/src/lib/personas.ts` `currentPersonaId`, `harnesses/pi/src/teammate-flag.ts`)
  with `tests/persona-aliases.test.ts` and `harnesses/pi/tests/teammate-flag.test.mjs`;
  switch the demo's `tracker-worker.md` (here in `tests/fixtures/demo/` and in
  mpt-demo-team) to `kinds: [teammate]`; and drop the "Deprecated: `worker`" notes in
  README.md and docs/guide/06-personas.md. Removing them is a breaking change — say
  so in the release notes.

- **herdr server under systemd:** `daemon/terminal/herdr.ts` `realHerdrLaunch` starts
  `herdr server` as a plain detached child, so under the systemd service it lives in the
  unit's cgroup and `systemctl --user stop|restart` takes every herdr agent with it (tmux
  started by the daemon has the same exposure). docs/herdr.md "Ensuring a server…"
  recommends `systemd-run --user --collect` when `$INVOCATION_ID` is set; it needs the
  server's environment passed explicitly, since a pane gets the server's env.

- **herdr's agent-state detection as a signal:** herdr detects what a pane's agent is
  doing (working, waiting for input, done; docs at herdr.dev "agent automation") and
  can report it per pane. mpt ignores it: liveness is the agent's own heartbeat, and
  `daemon/terminal/herdr.ts` only uses `pane process-info` to tell a restored empty
  shell from a running agent. A future signal could feed the Team tab ("waiting on a
  prompt" for a teammate stuck at a permission question) or the reaper. It would be a
  herdr-only optional `TerminalBackend` method, never required for correctness.
- **macOS menu bar app's Launch Leader is tmux-only:** `desktop/macos/Sources/DaemonManager.swift`
  still defaults to a `tmux new-session … pi --ppt-lead` template, starting the leader
  outside the daemon. It should call `POST /api/assistant/start` (which picks the
  team's terminal, tmux or herdr) and show its `attach` command.

- **Helper copies outside `shared/`:** `harnesses/pi/src/leader.ts` writes
  `err instanceof Error ? err.message : String(err)` inline, because the Pi
  extension can't import `shared/`. (`ui/src/lib/structural.ts` keeps its own
  `isPlainObject` on purpose: it also rejects non-plain prototypes.)
- **UI shapes with no protocol type yet:** `GET /api/config` (the `ConfigData` in `lib/config-draft.ts`
  for ConfigPage, and WorkflowsPage's and WorkflowDetailPage's own), `/api/workflows`, `/api/usage`,
  and `/api/spawn-requests` are still typed by local slices in `ui/src/`; add them
  to `shared/protocol.ts`. TaskDetailPage reads a `transitions` map on
  `/api/status` `workflows` that the daemon never sends, so its Move buttons never
  render — remove or implement them.
- **RunThread composer differences:** `components/RunThread.tsx` keeps each
  page's historical composer: a board task posts as `lead`, untrimmed, with
  ⌘+Enter; a WorkDef page posts as `you`, trimmed, without the shortcut
  (`author`, `trimBody`, `sendOnCmdEnter`). A board task's thread also keeps the
  stored order reversed rather than `newestFirst`. Unify when a behavior change
  is acceptable.
- **Extension views of non-agent routes:** `runtime/client.ts` still
  declares the fields its tools read from stories, thoughts, personas, workflows and
  WorkDefs (`PersonaSummary`, `Thought`, `WorkDefSummary`, `CreateStoryResponse`, …)
  by hand. The agent protocol itself comes from `shared/agent-protocol.ts`
  (generated); these could move there too, as narrow views the daemon's types extend.
- **`(e as Error).message`** in `catch` blocks across `cli/`, `agent/` and `daemon/`
  prints `undefined` for a non-`Error` throw; `errorMessage` (`shared/util.ts`) would
  stringify it instead. Left as is because switching changes that (edge-case) output.
- **`/api/work-sources` alias:** the external-source routes merged into `/api/sources`
  (`GET /api/sources` carries `plugins`; `/api/sources/:id/defs|sync|disconnect`).
  `daemon/routes/sources.ts` still answers the old `/api/work-sources` list (its old
  shape, `WorkSourcesResponse`) and sub-routes, and `defaultExternalToggle` gates
  both, so an older CLI or script keeps working. Remove the alias, the
  `WorkSourcesResponse` type and the extra toggle routes after a release.
- **Deprecated request aliases:** `draft` (WorkDef / board-task create) and
  `POST /api/work-defs/:id/publish`, and story `paused`
  (`daemon/routes/work-defs.ts` `requestsPending`, `routes/stories.ts`
  `requestsStoryPending`) are still accepted "for one release". They're request
  shapes, not team layouts, so the pre-0.36.0 cutoff didn't remove them; drop
  them (and the `@deprecated` protocol fields) with the alias above.
- **Pre-0.36.0 refusal:** `daemon/layout-check.ts` and
  `daemon/store/schema.ts` `preCutoffSchemaFindings` refuse layouts older than
  0.36.0 (docs/DESIGN.md "Upgrading from before 0.36.0"). When the cutoff moves
  up, raise `MIN_UPGRADE_FROM_VERSION` / `PRE_CUTOFF_UPGRADE_MESSAGE`; once it is
  past 0.36.x, `preCutoffSchemaFindings` can refuse every version-0 database
  outright (migration 1 stays — shipped migrations aren't edited). The context-library notice
  (`Store.getNotices`) can go once no supported team can still carry one.
- **tmux prefix-matches session targets:** `daemon/terminal/tmux.ts` passes `-t <session>`
  (`hasSession`, `listWindows`, `session:window` targets). With no exact match tmux
  accepts a unique *prefix*, so with `tmuxSession: "mpt"` not yet running and a
  session `mpt-services` up, `mpt lead` (and a daemon spawn) would put its window in
  `mpt-services`. Use exact targets (`=<session>`) throughout, updating the argv
  assertions in `tests/tmux.test.ts` / `tests/spawner.test.ts`.

## Work Sources as plugins — package loading — built

Third-party Work Sources load from plugin packages declared per team in
`config.json` `packages` (npm, git with `@ref`, local paths, or `{ source, config }`),
installed by `mpt plugins add|list|remove|update` into `<teamDir>/packages/`, loaded
at startup by `daemon/plugins/loader.ts` from each package's `"mpt": { "sources": [...] }`,
with types and constants from the host's `my-pizza-team/plugin` export (peer
dependency, resolved to the running daemon by a resolve hook). The design is in
docs/DESIGN.md "Plugin packages"; the author guide is docs/PLUGINS.md "Writing a Work Source
plugin". What's left:

- **Isolation:** plugins run with the daemon's full permissions. The core already
  bounds what it can: each `sync()` has a timeout, a failing source backs off,
  syncs never overlap, `onComment`/`onItemTerminal` are fire-and-forget
  (`daemon/sources/sync.ts`), and import/factory have a load timeout. What's left is
  in-process: a plugin that blocks the event loop synchronously still stalls the
  daemon. Consider one Worker per plugin (Node `worker_threads`), or a
  subprocess speaking JSON-RPC over stdio (as with ACP in `agent/acp.ts`). Either way,
  plugins only reach the daemon through `SourceContext`.
- **Install-on-start blocks startup:** `installMissingPackages` (daemon/plugins/install.ts)
  runs npm/git with `spawnSync` before the HTTP server listens, so a slow first
  install (bounded by `MPT_PLUGIN_INSTALL_TIMEOUT_MS`, default 10 min per command)
  delays the daemon coming up. An async install that loads each package as it lands
  would need the loader to register sources after `startTimers`.
- **Hot reload:** plugins load once at startup; any change (package list, a
  plugin's code or `config`) needs a daemon restart. A reload would have to
  deregister a source (stop its timers, drop its registry entry) and re-import
  under a fresh URL, since Node caches ES modules.
- **First real external plugins:** Jira / Asana / Taskei, as packages outside this
  repo. Pull only: no creating external issues from MPT.
- **Mirror ids on case-insensitive file systems:** a mirror's directory is
  `<sourceId>~<externalId>` (escaped), so two external ids differing only in case
  collide on macOS/Windows default volumes. Fine for Jira-style keys; revisit
  (e.g. a hash suffix) if a source's ids are case-sensitive.
- **A mirrored thread in the prompts:** comments pulled from the source
  (`ExternalDef.comments`, docs/DESIGN.md "A mirrored thread") are in the
  mirror's thread and UI, but neither prompt surfaces them yet — the work
  prompt shows only lead comments, and the triage prompt leaves them out of
  "Earlier Analysis". A ticket's correspondence is often the most useful
  context; add a bounded "Comments in <source>" section (newest N, by channel).
- **Edited / deleted external comments:** the thread merge is append-only by
  comment id, so an edit or delete in the source isn't reflected.

## Personas — built (docs/DESIGN.md "Personas: One Library, Selected by Reference")

One persona library (`personas/<id>.md`, `builtin:*`, package `<name>/<id>`)
replaces workflow state files, `triage.md`, the assistant's context-library persona,
and the context library itself; everything selects a persona by id through
`resolvePersona`. Shipped in the Unified Personas story: the library and built-ins,
the API, the on-load migration (0.34–0.36; removed since — pre-0.36.0 teams are refused), WorkDef `persona`, the WorkItem snapshot
(recorded at claim), every prompt path, the Pi tools (`list_personas`, `persona`
params), Work Source personas, the UI (Config → Personas, pickers, the
triage-persona-required state, in-flight chips, the notices strip), persona packages
(the loader's `mpt.personas`, `mpt plugins` and the doctor), and the demo team
(mpt-demo-team's fixtures, the pre-0.36.0 refusal check and persona package).
Deferred on purpose:

- **Composition / inheritance:** a persona that extends another (a team "reviewer"
  built on a package's, picking up its updates). Today Duplicate copies and never
  tracks the source (`duplicatedFrom` is informational only).
- **Templating variables:** `{state}`, `{directory}`, `{story}` in a persona body.
  Today a body is static text, which is why `builtin:teammate` is worded without the
  state name.
- **Per-board-task persona override:** board tasks take the workflow state's persona;
  `persona` on a board WorkDef is refused (400).
- **Shared registry / marketplace UI:** a shared index of persona packages, browsed
  and installed from the web UI. Today it's `mpt plugins add <spec>`.
- **Hot reload of package personas:** like sources, they load once at startup
  (see "Hot reload" above).
- **Richer persona globs:** `mpt.personas` supports a `*` in the last path segment
  only (`personas/*.md`), no `**` or braces; add them if a package needs nested
  folders.
- **Persona on the Inbox and board cards:** the chip shows on in-flight work (Team,
  Queue, the watch header) and a task's **Runs**; the Inbox rows and board task
  cards don't carry it yet (the data is on every WorkItem, so it's UI-only).

Open questions (decide while building, or leave as-is and record why):

- **Persona in the usage ledger:** should `usage/*.jsonl` carry the persona id, so
  cost can be broken down per persona? Not needed for the chip (that's the WorkItem
  snapshot); additive if wanted.
- **`kinds` beyond pickers:** should the triage picker *hide* non-triage personas
  rather than sort them last? The design says sort, never restrict.
- **Delete with re-pointing:** a "replace with…" action on delete-in-use (re-point
  every `usedBy` reference in one step) instead of a plain 409.
- **Package personas and `config`:** a package might want per-team values in its
  persona text (a team name, a queue URL); that's templating, deferred above.
- **Notices surface:** the (0.34–0.36) migration notice is the only `/api/status` `notices`
  entry (dismissed with `DELETE /api/notices/:id`, held in SQLite `settings`); if a
  second kind appears, give notices their own store.

## Auto Triage — built

A teammate reads each note whose text you've changed and proposes what should become
work; you accept, edit, or reject from the note's triage page. Shipped in three
stages; the design now lives in docs/DESIGN.md "Auto Triage: a Note Is a Parent" and
docs/ARCHITECTURE.md "Thoughts", with the user-facing half in docs/guide/05-thoughts-and-triage.md.

Tests: tests/triage.test.ts (42), tests/triage-ui.test.ts (8),
harnesses/pi/tests/tools.test.mjs.

Known gaps / ideas, none blocking:

- **No cross-note list of pending proposals.** Badges and Inbox rows are the only way
  in. If it's wanted, it's probably an Inbox filter rather than a third Thoughts view.
- **`intervalMinutes` only re-arms on daemon restart** (the timer is created in
  `startTimers`). Enabling/disabling and the quiet period take effect next sweep.
- **A story proposal's tasks aren't editable before accepting** — only its title and
  directory are; edit the tasks on the story afterwards.
- **The badge polls every 60s** (`/api/triage/badges`), so a newly finished run can
  take a minute to show up on the board. The Inbox is quicker.
- **`Select` renders its raw value** rather than the item's label in Config's Autosave
  card ("true"/"false" instead of Yes/No) — pre-existing, not triage's, but the reason
  the triage toggle is a checkbox.

### Triage mode for external sources — built

A Work Source (or one of its items) can declare `mode: "triage"`: the read-only
mirror is the triage subject, a new revision is the turn, and proposals are decided on
the mirror's Triage tab (docs/DESIGN.md "External sources" — "Triage mode"; docs/guide/07-sources.md
"Triage-mode sources" and docs/PLUGINS.md "Writing a Work Source plugin"). Tests:
tests/external-triage.test.ts, tests/e2e/demo-tracker.test.ts; demo: mpt-demo-team's
demo-tracker plugin (`DEMO-3`). What's left:

- **Proposal write-back to the external system.** Analyses and decisions live only
  in MPT: they aren't comments, so `onComment` never sees them, and there is no hook
  for "a proposal was posted / accepted / rejected". A ticket's watchers can't see the
  triage outcome (or what work it became) without opening MPT. Likely shape: an
  optional `WorkSource.onTriage(def, event, ctx)` hook (analysis posted, proposal
  decided, with the created WorkDef id), fire-and-forget like the others, so a
  plugin can comment on or relabel the ticket. Additive, so `apiVersion` stays 1.
- **Answering a question means editing the external item.** A mirror is read-only,
  so there's no in-MPT turn; if that proves awkward, a reply passed to the next
  run's prompt (Triage now without a new revision) is the obvious addition.

## Phone View — built

`/m`: Team (teammates + queue), Chat, Thoughts, Inbox — docs/DESIGN.md "A Phone Is a
Peek", docs/ARCHITECTURE.md "Phone view", docs/guide/09-phone.md. Tests:
tests/mobile.test.ts. Checked in headless Chrome with iPhone emulation.

Known gaps / ideas, none blocking:

- **Not yet tried on a real iPhone.** Watch for the keyboard covering the chat
  composer: iOS Safari ignores `interactive-widget=resizes-content`, so it may need a
  `visualViewport` listener.
- **No home-screen icon or manifest.** The `apple-mobile-web-app-*` tags are there,
  but there's no `apple-touch-icon` or `manifest.webmanifest`.
- **No notifications.** "An item is at risk" or "the leader replied" would need web
  push (home-screen PWAs only on iOS), and would be the first reason to build native.
- **Desktop-only links:** a note's triage badge, a queue item's title, and the
  teammate page's "working on" link open desktop pages. A phone triage page (accept /
  reject) is the obvious next tab-level feature.
- **A note can't change folder from the phone** (it needs `placeForGroupChange`).

## Other harnesses (Kiro, Claude Code) over ACP — experimental

**Built** (behind `experimental.harnesses`): `mpt agent` (agent/), `mpt setup --harness`,
the registration and spawn gates, the Spawn dialog's harness choice, doctor checks, and
tests/e2e/agent.test.ts against a fake ACP agent. Exercised by hand with real Kiro 2.11.1
and Claude Code (adapter 0.81.2): each completed a small job end to end.

**Still to do:**
- **Pairing** from the web UI: poll `/api/agents/:id/pairing`; queue = next prompt,
  steer = Claude's prompt queueing or cancel-and-reprompt for Kiro; forward
  `request_permission` to the web UI while paired. The UI disables Pair for them and the
  daemon refuses it until then.
- **Leading** (the chat mirror over ACP; typing in the tmux window has no path in yet).
- **Graduating** a harness out of the flag once it has been used for real work.

Background: both agents speak the **Agent Client Protocol** (JSON-RPC 2.0 over stdio,
one object per line). The design as built is in docs/DESIGN.md "Harness Tiers, and Why
Not MCP" and docs/ARCHITECTURE.md "agent/"; what the spike verified, and the
decisions, are kept below for reference.

### Verified (spike, 2026-09-27; about $1 of Claude and 5.6 Kiro credits)

Driven with a throwaway ACP client (no SDK) in a scratch project, answering
permission requests as the client.

| | Kiro (`kiro-cli acp`, 2.11.1, native) | Claude Code (`@agentclientprotocol/claude-agent-acp` 0.81.2) |
|---|---|---|
| Runs a prompt; tool calls stream as `tool_call` / `tool_call_update`; ends `end_turn` | ✓ | ✓ |
| `session/request_permission` sent to the client | ✓ (`-a` suppresses it) | ✓ unless the mode allows it; modes: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` via `session/set_mode` |
| `session/load` in a **new process** keeps context | ✓ (replays history as updates) | ✓ |
| `session/cancel` → `stopReason: "cancelled"` promptly | ✓ | ✓ |
| Second `session/prompt` mid-run | ✗ error `Prompt already in progress` | ✓ queued into the run (`promptQueueing: true`); reply covered both |
| Usage / cost | `_kiro.dev/metadata`: `meteringUsage` in **credits** per turn, `contextUsagePercentage` | `session/prompt` result `usage` (input/output/**cache read/write**) + `usage_update` with `cost` in **USD** |
| Uses your installed `claude` (auth, Bedrock) | — | ✓ via `CLAUDE_CODE_EXECUTABLE` |

Gotchas found:
- `@zed-industries/claude-code-acp` is **deprecated** (renamed); it reports no usage. Use
  `@agentclientprotocol/claude-agent-acp`.
- The Claude adapter honors the user's `~/.claude/settings.json`. With
  `permissions.defaultMode: "auto"` it wrote "**Auto mode unavailable** … using Accept
  edits instead." *into the agent's reply text* — it would end up in a completion
  summary. Set the mode explicitly (`session/set_mode`) right after `session/new`.
- Kiro sends extension methods (`_kiro.dev/metadata`, `_kiro.dev/session/update`,
  `…/commands/available`, `…/mcp/server_initialized`); a client must ignore unknown
  notifications and answer unknown requests with "method not found".

### Decisions (2026-09-27)

1. **No credits in the usage ledger.** Nobody knows what a credit is worth. Kiro runs
   record what they can in tokens, or nothing.
2. **Harness choice is per spawn for now** (Spawn dialog; `defaultHarness` for the
   pool), and **non-Pi harnesses sit behind an experimental flag** in team config until
   they're better vetted.
3. **`mpt setup` installs the Claude adapter** (pinned), rather than relying on `npx`.
4. **A fake ACP agent drives the e2e tests**; real agents are exercised by hand.

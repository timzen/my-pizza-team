# TODO

Known code issues and deferred work. Each item names a symbol rather than a line
number. Delete an item when it's done.

## Bugs

- **Deregistering a member orphans its in-flight WorkItem** (`Store.removeMember`):
  `member_id` is set to NULL but the item stays `IN_PROGRESS`, and the reaper only walks
  members, so it is never reaped to MORIBUND. A Pi teammate deregisters on shutdown even
  mid-item. (`mpt agent` fails its item before deregistering, so it avoids this.) Fix:
  move the member's in-flight items to MORIBUND in `removeMember`.

## Work Sources as plugins — package loading — built

Third-party Work Sources load from plugin packages declared per team in
`config.json` `packages` (npm, git with `@ref`, local paths, or `{ source, config }`),
installed by `mpt plugins add|list|remove|update` into `<teamDir>/packages/`, loaded
at startup by `daemon/plugins/loader.ts` from each package's `"mpt": { "sources": [...] }`,
with types and constants from the host's `my-pizza-team/plugin` export (peer
dependency, resolved to the running daemon by a resolve hook). The design is in
docs/DESIGN.md "Plugin packages"; the author guide is GUIDE.md "Writing a Work Source
plugin". What's left:

- **Isolation:** plugins run with the daemon's full permissions. The core already
  bounds what it can: each `sync()` has a timeout, a failing source backs off,
  syncs never overlap, `onComment`/`onItemTerminal` are fire-and-forget
  (`daemon/sources/sync.ts`), and import/factory have a load timeout. What's left is
  in-process: a plugin that blocks the event loop synchronously still stalls the
  daemon. Consider one Worker per plugin (Node `worker_threads`), or a
  subprocess speaking JSON-RPC over stdio (as with ACP in `agent/acp.ts`). Either way,
  plugins only reach the daemon through `SourceContext`.
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

## Auto Triage — built

A teammate reads each note whose text you've changed and proposes what should become
work; you accept, edit, or reject from the note's triage page. Shipped in three
stages; the design now lives in docs/DESIGN.md "Auto Triage: a Note Is a Parent" and
docs/ARCHITECTURE.md "Thoughts", with the user-facing half in GUIDE.md.

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
the mirror's Triage tab (docs/DESIGN.md "External sources" — "Triage mode"; GUIDE.md
"Triage-mode sources" and "Writing a Work Source plugin"). Tests:
tests/external-triage.test.ts; demo: mpt-demo-team's demo-tracker plugin (`DEMO-3`,
checked by `run-e2e.sh`). What's left:

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
Peek", docs/ARCHITECTURE.md "Phone view", GUIDE.md "On Your Phone". Tests:
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

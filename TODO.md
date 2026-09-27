# TODO

Code issues found while reconciling the docs with the source (docs consolidation,
v0.20.0). Each item names a symbol rather than a line number. Delete an item when it's
fixed.

## Bugs

- **`deno task dev` / `deno task start` run a different daemon from `mpt start`.**
  `daemon/main.ts` never calls `probeSpawnCapability`/`realizePending` or
  `startReadinessLoop`; only `cli/start-daemon.ts` does. Under `deno task dev`,
  `/health` reports spawning as "not probed", spawns fall to the leader, and a
  configured readiness probe never runs. Have `daemon/main.ts` delegate to
  `startDaemonInProcess` (keeping `--watch`).

- **`mpt start --daemon` pipes the child's stdout/stderr and never reads them**
  (`cmdStart`). The parent exits right away, so daemon output is lost; check whether
  later writes hit a broken pipe. Redirect to a log file in the team dir (its names
  are already in `RUNTIME_FILES`) or to `null`.

## Stale code comments

- `TeamConfig.readinessProbe` — "The leader runs this on each heartbeat" (the daemon
  runs it every 30s). Same in `Store.setTeamReadiness` ("reported by the leader's
  probe"), the `teamReadiness` field comment, and the readiness block in
  `routes/shared.ts`.
- `/health` in `routes/shared.ts` — "Hosts whose leader reported not-ready".
- `Schedule.heldForReadiness` — "no ready agent could take its work … a teammate …
  reported not-ready" (it's team readiness).
- `server.ts` header — `tasks:` lists "comments, attachments, token usage" (moved to
  work-defs); `agents:` lists "release, spawn".
- `shared/types.ts` header — "P1c-7 folds its remaining local type copy" (done).
- `WorkItem` doc — "a polymorphic `ref` (a story task, or a standalone WorkDef)"; the
  ref is always a WorkDef id.
- `Store.reapOfflineAgents` doc — "Release any tasks it has claimed" (they go
  MORIBUND).
- `harnesses/pi/src/leader.ts` still carries its own copy of the Pi teammate template
  (`{workArgs}`) and a `"pi-pizza-team"` tmux-session fallback, for the leader-driven
  spawn path. Worth deriving from `DEFAULT_HARNESS_TEMPLATES` / the daemon config.

## Dead code and leftovers

- `DaemonClient.reportReadiness`, `getComments`, and `reportTokenUsage`
  (`harnesses/pi/src/runtime/client.ts`) have no callers.
- `POST /api/agents/work-items/:id/token-usage` — no current harness calls it
  (usage goes through `/api/agents/:id/usage`). `PUT /api/tasks/:taskId` — the UI
  edits through `PUT /api/work-defs/:id`. Remove both with a protocol bump, or keep
  and document why.
- SQLite columns `stories.requirements` and `members.capabilities` are still created
  and migrated in `initSchema`, though matching is directory-only.
- `countPendingTeammateSpawns` skips `reason: "assistant"` rows from the retired
  assistant role; a one-time cleanup could delete them instead.
- `deno.lock` still pins `jsr:@db/sqlite` although the store uses `node:sqlite`.
  Likewise `mpt.entitlements`' `disable-library-validation` existed for that FFI
  `.dylib`; check whether a signed build still needs it.
- `mpt --help`'s **Commands** list omits `setup`, `doctor`, and `lead` (they appear
  only under Examples) and its Environment section omits `HOST`.

## Deferred: a second harness (Kiro, Tier 0/1)

Designed, not built. Verified with kiro-cli 2.11.1: `kiro-cli chat --no-interactive
"<prompt>"` runs one task and exits; `--trust-all-tools` suppresses permission
prompts; it executes shell commands. Proposed shape:

1. `mpt work complete <id>`, `mpt work fail <id> "<why>"`, `mpt work comment <id>
   "<text>"` over the existing agent routes, with `MPT_AGENT_ID` / `MPT_DAEMON_URL`
   set in the spawned command's environment — a reporting channel for *any*
   shell-capable agent.
2. Tier 0 teammates registered by the daemon at spawn (`harness: "kiro"`), with "its
   tmux window exists" standing in for heartbeats.
3. A daemon-side loop per idle Tier 0 teammate: claim (same affinity matching),
   render prompt + `mpt work` instructions, run a per-task `task` template
   (`{prompt}` shell-quoted) plus a `tier: 0` marker; if the process exits with the
   item still IN_PROGRESS, mark it FAILED ("exited without reporting").
4. `DEFAULT_HARNESS_TEMPLATES.kiro` (no `leader`), a `doctor` check for `kiro-cli`, and
   README notes on what it gives up (no live transcript, usage ledger, pairing, or
   leading).

Open: one-shot per task (recommended) vs a persistent session nudged with
`send-keys`; e2e uses a stand-in script, real Kiro by hand only.

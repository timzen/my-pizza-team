# Batteries Included — Task Breakdown

Executable tasks for [BATTERIES_INCLUDED.md](BATTERIES_INCLUDED.md). That doc
states the intent and the design decisions; this one is the grounded worklist
after tracing the code.

**Conventions.** Task IDs are stable (`P0-1`, `P1a-3`, …) so they can be
referenced from commits and follow-ups. Line numbers drift, so each task anchors
on a **symbol or quoted string** instead, following the pattern `TODO.md` used.
Every task lists its own acceptance check; a phase is done when all of its tasks
pass *and* its Definition of Done is met.

**The one hard ordering rule.** `P1b` (handshake) must land before `P1c`
(protocol break). Removing `/api/hosts/:hostId/leader/directives` without a
version gate makes an old leader poll a 404 forever and silently never spawn
anyone — the exact failure this plan exists to kill. Nothing else in the plan has
a safety-critical order, though phases are sequenced for reviewability.

---

## Phase 0 — Safety net and desk-clearing

No behavior change. Goal: a type-check exists before anything moves.

### P0-1 — Type-check the extension

The blocker: `pi-pizza-team` has no `tsconfig.json` and no `scripts` field, so
nothing validates 4,555 lines of TypeScript. `P1c` rewires every import in that
package; this is the safety net for it.

- Add `pi-pizza-team/tsconfig.json`: `strict`, `noEmit`, `moduleResolution`
  suited to Pi's loader, `allowImportingTsExtensions` (the source imports
  `./shared/types.ts` with the extension).
- Types come from `@earendil-works/pi-coding-agent` and `typebox`. Every Pi
  import in the package is `import type`, so a `devDependencies` entry is enough
  — do **not** add a runtime dependency.
- Add `scripts`: `"typecheck": "tsc --noEmit"` and
  `"test": "node --test tests/*.mjs"`.

**Acceptance:** `npm run typecheck` exits 0. `npm test` reports 286 passing
assertions across 13 files. (Note `node --test tests/*.ts` silently reports 0
tests — the wrong glob is why this was never noticed.)

### P0-2 — Extend `deno task check` to `tests/`

`check` covers only `daemon/main.ts`, `daemon/server.ts`, `daemon/store.ts`,
`cli/main.ts`. `tests/` is 4,595 unchecked lines.

**Acceptance:** `deno task check` includes `tests/` and exits 0.

### P0-3 — Archive shipped plans

Roughly 1,235 of 2,665 lines in `docs/` are historical. Move to `docs/history/`
with a one-line index explaining each is retained for rationale, not currency:

| File | Lines | Why |
| --- | --- | --- |
| `ASSISTANT_CHAT_V2.md` | 508 | "Status: **implemented**" |
| `FRONTIER_ENGINEER_REFACTOR_PLAN.md` | 410 | superseded by `WORKDEF_UNIFICATION.md` |
| `FRONTIER_ENGINEER_REFACTOR.md` | 132 | intent doc for the above |
| `THOUGHTS-PORT-DIFF.md` | 115 | a bring-over plan |

Repoint inbound references — `ARCHITECTURE.md` and `WORK-MODEL.md` both link
into these, and `store.ts` cites `docs/ASSISTANT_CHAT_V2.md §10`.

**Acceptance:** no broken relative links (`grep -ro '](\w*\.md' docs/` resolves);
`docs/` root holds only living docs.

### P0-4 — Execute and delete `TODO.md`

93 lines of curated stale docs and comments, each with a quoted anchor. Fix them,
then delete the file.

**Acceptance:** `TODO.md` gone; no remaining prose describing the retired
assistant role.

### P0-5 — Fix the stale `server.ts` header

Its route-module list claims `teammate: legacy teammate protocol (next-task,
claim, status, team)`. There is no `registerTeammateRoutes` and no `next-task`
route anywhere.

**Acceptance:** every module named in the header comment exists.

### P0-6 — Drop the unused `pi-tui` peerDependency

`@earendil-works/pi-tui` is declared but never imported. (`typebox` is real —
`tools.ts` imports `Type`.)

**Acceptance:** each remaining peerDependency appears in an import.

**Phase 0 DoD:** `deno task test` (261 tests) green, `deno task check` green,
`npm run typecheck` green in the extension, `docs/` navigable.

---

## Phase 1a — One repo (move only, zero refactor)

Goal: the tree is merged and green with **no semantic change**. Resist all
cleanup here; that's what makes this reviewable.

### P1a-1 — Subtree-merge the extension

`git subtree add --prefix=harnesses/pi <pi-pizza-team> main`, preserving history.
Leave `harnesses/pi/src/shared/types.ts` in place — `P1c` handles it.

**Acceptance:** `git log -- harnesses/pi` shows pre-merge history.

### P1a-2 — Delete `mpt-mcp-server`

Tag `archive/mpt-mcp-server` first. It calls endpoints that no longer exist
(`/api/assistant/notes`, `/api/agents/release/:taskId`,
`/api/spawn-requests/:id/ack`), and `mpt-demo-team/run-e2e-kiro.sh` invokes
`src/runners/kiro/runner.mjs`, deleted in `fbba4ac`.

**Acceptance:** tag pushed; directory gone; no references outside `docs/`.

### P1a-3 — Single version, generated at build

Root `deno.json` `version` becomes the only version. Generate
`harnesses/pi/package.json`'s `version` during build so it cannot drift from
`0.17.2`/`0.2.0` again. Fold the extension's publish path into
`scripts/publish.sh`.

**Acceptance:** a build stamps a matching version into the extension manifest;
one command releases both.

### P1a-4 — Wire extension tasks into the root

Add `deno task test:ext` and `deno task check:ext` delegating to `P0-1`'s scripts.

**Acceptance:** both run from the repo root.

### P1a-5 — Retire the MCP-compat routes

`routes/work-defs.ts` states the task-scoped attachment routes are "kept for
compat" with mpt-mcp-server. With `P1a-2` done they have no client: remove
`/api/tasks/:taskId/attachments`, `/api/tasks/:taskId/attachments/:filename`, and
`/api/tasks/:taskId/token-usage`. The UI uses the `/api/work-defs/:id/…`
equivalents (`DiffViewer.tsx`, `FileViewer.tsx`, `TaskDetailPage.tsx`).

**Acceptance:** `tests/attachments.test.ts` updated and green; no client
references the removed paths.

### P1a-6 — Update project docs for the merge

`AGENTS.md` (root) says "four separate projects" — now two (the monorepo and
mpt-demo-team). Update `README.md` install instructions, `ARCHITECTURE.md`'s
module map, and mpt-demo-team's scripts including the broken `run-e2e-kiro.sh`.

**Acceptance:** `run-e2e.sh` passes; no doc references `pi-pizza-team` as a
separate repo.

**Phase 1a DoD:** all suites green from the root; a clean clone builds; nothing
behaves differently.

---

## Phase 1b — Version handshake

Small, and required before `P1c`.

### P1b-1 — `PROTOCOL_VERSION` in `shared/`

An integer bumped only on breaking protocol change, exported from
`shared/protocol.ts` and imported by both halves.

### P1b-2 — Extend registration

`POST /api/agents/register` accepts `{ protocolVersion, harness, harnessVersion }`.
Persist on the member (`Member` in `shared/types.ts`; the `members` table in
`store.ts`). `harness` is one line now and avoids versioning the handshake twice
when Tier 0 arrives.

**Acceptance:** a register without the fields is treated as legacy and flagged,
not rejected.

### P1b-3 — Gate on protocol, report build

Refuse a `protocolVersion` the daemon can't serve, with a message naming the fix.
Build-version differences are **informational only** — gate on them and every
daemon patch nags the whole team until people learn to ignore the banner.

**Acceptance:** a test asserts refusal on incompatible protocol and tolerance of
a build-version difference.

### P1b-4 — Surface skew in the UI

A Team-tab row indicator plus a banner: *"swift-ripley runs extension 0.16.0; the
daemon is 0.17.0 — restart it."* Touches `ui/src/lib/team.ts`,
`components/team/TeamParts.tsx`.

### P1b-5 — Send the handshake from the extension

`harnesses/pi/src/client.ts` `register()` sends all three fields.

**Acceptance:** an intentionally-wrong `PROTOCOL_VERSION` in the extension
produces a clear startup error, not a silent partial failure.

**Phase 1b DoD:** skew is visible in the UI; an incompatible extension fails
loudly.

---

## Phase 1c — Drop multi-host; extract the agent runtime

The big net deletion. Requires `P1b`.

### P1c-1 — Collapse the leader-directive channel

`/api/hosts/:hostId/leader/directives{,/:id}` → `/api/leader/directives{,/:id}`
(`routes/agents.ts`). In `store.ts`, `createLeaderDirective`,
`getLeaderDirectives`, and the `leader_directives.host_id` column lose their host
key. Update `shared/protocol.ts`'s "Leader Directives (the single daemon->leader
work queue, per host)" block, `harnesses/pi/src/client.ts`, and
`ui/src/hooks/useTeamData.ts`.

**Acceptance:** `tests/leader-directives.test.ts` (166 lines) updated and green;
spawn and `reset-session` both work end-to-end.

### P1c-2 — Delete host routing

Remove `hosts` config and `HostConfig` (`shared/types.ts`), `pickPoolSpawnHost`,
the `hostId` rollup in `canScheduleForDirectory`, `Member.hostId`,
`GET /api/hosts/:hostId`, and `GET /api/hosts-readiness`. In the UI, remove the
`SpawnDialog.tsx` host picker (12 references — it forces a choice from a list that
holds one entry and errors when empty) and the `hostId` gating at
`TeamParts.tsx`'s `onReset` and `useTeamData.ts`.

**Acceptance:** `tests/hosts.test.ts` (94 lines) retired; `teammate-pool.test.ts`
green; spawning needs no host.

### P1c-3 — Re-key readiness to the team

`HostReadiness` → `TeamReadiness`; `setHostReadiness`/`getHostReadiness`/
`isHostReady` lose the host key. Keep the *behavior* — a due scheduled child is
held, `heldForReadiness` is set, and it re-fires exactly once on recovery
(ARCHITECTURE.md's "Scheduler readiness gating"). Leave the probe agent-reported
for now; `P3-2` moves it into the daemon.

**Acceptance:** the hold-and-single-refire test still passes with no host
involved.

### P1c-4 — Delete chat-agent designation

With one leader there is nothing to designate: remove `chatAgentId`,
`getChatAgent`'s stickiness, and the `chat: true|false` flag that stopped
non-designated leaders from double-answering (`store.ts`, `routes/assistant.ts`,
`store/assistant-chat.ts`). This makes DESIGN.md's "One Agent to Talk To" true
rather than approximated.

**Acceptance:** `tests/assistant.test.ts` updated; the leader answers the chat
with no designation step.

### P1c-5 — Delete the chat v1 migration

No v1 data exists (BATTERIES_INCLUDED §7). Remove `migrateLegacyMessages()` and
its call site, and the `status`/`turn_id` columns marked `DEPRECATED (v1 turn
model)`.

**Acceptance:** a fresh database initializes without the columns; no `legacy-*`
session code remains.

### P1c-6 — Delete ignored config fields

`shared/types.ts` has fields marked `@deprecated … Accepted and ignored`.

### P1c-7 — Unify shared types

`harnesses/pi/src/shared/types.ts` (33 lines, "a minimal subset") is deleted; the
extension imports from `shared/`.

**Acceptance:** one definition of each protocol type in the tree.

### P1c-8 — Extract `agent-runtime/`

Move the Pi-free modules out of `harnesses/pi/src/`:

| Module | Lines |
| --- | --- |
| `client.ts` | 841 |
| `transcript.ts` | 265 |
| `bubbles.ts` | 129 |
| `pairing.ts` | 96 |
| `usage.ts` | 66 |
| `readiness.ts` | 64 |
| **total** | **1,461** |

`client.ts` already has zero Pi imports. What stays is Pi-coupled: `leader.ts`
(713), `tools.ts` (703), `index.ts` (496), `permissions.ts` (438),
`teammate.ts` (412), `chat.ts` (299).

**Acceptance:** `npm run typecheck` and both test suites green; the extension
starts and a teammate completes a task.

### P1c-9 — Enforce runtime purity

`agent-runtime/` must import under both Deno and Pi's Node type-stripping loader:
no dependencies, no `Deno.*`, no `node:*` — `fetch` and types only. Add a check
to CI so it can't regress.

**Acceptance:** the check fails on a deliberately-added `node:fs` import.

**Phase 1c DoD:** all suites green; `agent-runtime/` type-checks under both
runtimes; ARCHITECTURE.md and DESIGN.md updated for one-host/one-leader (the
"Scheduler readiness gating" note, the chat-agent designation note, and
DESIGN.md's per-host leader paragraph).

---

## Phase 2 — `mpt` carries the extension; `mpt setup`

### P2-1 — Embed the extension

Extend `deno compile --include` (already used for `ui/dist/`) to carry
`harnesses/pi/`. Nothing else is needed: the extension declares no
`dependencies`, and its peerDeps are packages Pi supplies — so there is **no
`npm install` step**.

### P2-2 — `mpt doctor`

Read-only checklist, one fix printed per problem: Pi present and at or above
`TESTED_PI_VERSION` (**warn**, don't block); tmux; extension version vs. the
daemon's; **exactly one** extension registration; the permission system; team dir
exists and the folder is trusted; daemon running, leader connected, service
installed; `GITHUB_TOKEN` (hint only).

**Acceptance:** each check has a test; each failure prints an actionable command.

### P2-3 — Write and register the managed extension

Write to `~/.my-pizza-team/pi-extension/` — a **stable** path, because Pi
identifies local packages by resolved absolute path, so a per-team path would
mint one package identity per team. Register it in `~/.pi/agent/settings.json`'s
`packages` array.

**Acceptance:** re-running is idempotent (no duplicate array entries).

### P2-4 — Resolve conflicting registrations

The double-load hazard: a managed directory and a dev checkout are distinct
identities, so registering both loads the extension **twice** — duplicate tools
and commands, two directive pollers, two heartbeats per agent. Setup must remove
the other entry or refuse to proceed, and must also clear pre-1a
`pi-pizza-team` paths. A dev checkout is detected and left alone — but then the
managed entry is *not* added.

**Acceptance:** a settings file seeded with both entries ends with exactly one;
`doctor` reports the conflict.

### P2-5 — `mpt setup`

Compose: run `doctor`'s checks, fix what's fixable, write and register the
extension (`P2-3`/`P2-4`), create the team dir as `mpt start` does, offer
`mpt install`, print the next step. Idempotent.

### P2-6 — Reversible uninstall

`mpt setup --uninstall` removes the managed directory and its package entry,
restoring Pi's settings as found. Because setup edits the user's Pi
configuration, record a manifest of what was changed.

**Acceptance:** settings.json is byte-identical before setup and after uninstall.

### P2-7 — `mpt upgrade` moves both halves

Rewrite the managed directory after replacing the binary. Per §7 the rewrite
alone suffices — Pi loads from the path without copying, so no re-registration.

### P2-8 — Warn when the permission system is missing

The extension already degrades gracefully via the
`Symbol.for("@gotgenes/pi-permission-system:service")` slot, but *silently*. Warn
loudly at teammate start when the slot is empty and yolo was requested. Setup
does **not** auto-install it — that would couple `mpt setup` to a third party's
publishing.

**Acceptance:** starting a yolo teammate without the package emits a visible
warning naming the install command.

### P2-9 — Restart teammates from the UI

Mostly built already: `reset-session` is mapped to Pi's `/new`
(`harnesses/pi/src/leader.ts`), is in the directive schema (`store.ts`), and the
UI already fires it per-teammate (`useTeamData.ts`). Remaining work is a
**restart-all** action plus surfacing it when `P1b-4` reports skew.

**Acceptance:** one click rolls every online teammate; the skew banner clears as
they re-register.

**Phase 2 DoD:** on a clean machine, `mpt setup` then `mpt lead` yields a working
team; `--uninstall` leaves no trace; README rewritten around `mpt setup` (this is
the phase that pays off §1.1).

---

## Phase 3 — `mpt lead` and daemon-owned tmux

### P3-1 — Move tmux into the daemon

Port session/window management and `send-keys` out of
`harnesses/pi/src/leader.ts` (three `execSync` call sites) into the daemon, and
turn the hardcoded `DEFAULT_HARNESS_TEMPLATES` constant into team config.

**Acceptance:** spawning works with the template supplied by config; the
extension no longer shells out to tmux.

### P3-2 — Daemon-side readiness probe

With tmux and health checks in the daemon, run the probe on cron and drop
`POST /readiness`. This also fixes a latent inversion: today readiness is
reported *by an agent on the host*, and an unreported host counts as ready — so a
box too wedged for the leader to start is treated as healthy.

**Acceptance:** readiness is reported with zero agents connected.

### P3-3 — `mpt lead`

Ensure the tmux session exists, open a window in the project dir, run the harness
with the right flags. First real consumer of `P3-1`.

**Phase 3 DoD:** `mpt` is the only command needed day to day; Tier 0 exists even
though only Pi uses it.

---

## Phase 4 — A second harness

### P4-1 — Pick a harness and add a Tier 0 template

Config plus a spawn template; no new integration. Prove spawn, prompt delivery,
and dismiss.

### P4-2 — Decide on Tier 1

Whether a tool surface is worth building for that harness, and whether it's
generated from `shared/` — the previous MCP server drifted precisely because it
was hand-maintained.

---

## Dependency summary

```
P0  ──▶ P1a ──▶ P1b ──▶ P1c ──▶ P2 ──▶ P3 ──▶ P4
        │               ▲
        └─ P1a-5 needs P1a-2 (delete unblocks route removal)
                        └─ HARD GATE: handshake before protocol break
```

Within a phase, tasks are mostly independent; the exceptions are noted inline
(`P1a-5` after `P1a-2`; `P1c-8` after `P1c-7`; `P2-5` after `P2-3`/`P2-4`;
`P3-3` after `P3-1`).

## Per-phase documentation obligation

Per root `AGENTS.md`, every phase updates `README.md` (user-facing behavior,
commands, setup), `docs/ARCHITECTURE.md` (modules, routes, data flow, schema),
and `docs/DESIGN.md` (new or changed rationale) **in the same commit**. The
heaviest doc debt lands in `P1c` (one-host/one-leader invalidates three existing
design notes) and `P2` (setup replaces the §1.1 scavenger hunt).

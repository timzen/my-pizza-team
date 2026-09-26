# Batteries Included — Plan

Make `mpt` the one thing you install. Today a working team needs a daemon *and* a
Pi extension installed, configured, and kept in lockstep by hand — and only Pi
works at all. This plan folds the extension (`pi-pizza-team`) into this repo and
this binary, moves the agent supervisor from the extension into `mpt`, and drops
the unused multi-host machinery. Setup becomes `mpt setup`, upgrades can't leave
the two halves out of step, and a non-Pi harness becomes a config entry instead
of a second integration.

Status: **proposal** — nothing here is built yet. Each phase stands on its own
and ships separately.

---

## 1. The problem

### 1.1 Setup is a scavenger hunt

Getting from nothing to a working team today:

1. Install the `mpt` binary; `mpt start` in a team dir.
2. Install Pi.
3. `pi install` pi-pizza-team (a path or a git URL).
4. `pi install npm:@gotgenes/pi-permission-system` — yolo mode quietly depends
   on it; without it, autonomous teammates stop on permission prompts.
5. Have tmux; trust the project folder; start a leader by running `pi` in the
   team dir.
6. Optionally `mpt install` (service) and a GitHub token (for `mpt upgrade` on
   shared-IP machines).

None of these steps checks the others. A missing piece shows up later as a
symptom (a teammate stuck on a prompt, a chat nobody answers), not as an error.

### 1.2 Two halves that must match, and nothing that notices when they don't

The daemon (`0.17.2`) and the extension (`0.2.0`) ship separately but are one
protocol. Real examples from recent work:

- The teammate watch view (docs/TEAMMATE_CHAT.md) needs the extension's
  transcript mirror; teammates started before the extension update streamed
  nothing, with no hint why.
- The usage ledger's `POST /api/agents/:id/usage` is only called by the new
  extension; an old one keeps working but silently records no chat/pairing
  usage and no cache tokens.
- A feature spanning both (teammate chat, usage) is a dozen commits across two
  repos that have to be released and installed together.

Shared protocol types are also duplicated (`shared/types.ts` here and
`pi-pizza-team/src/shared/types.ts`).

### 1.3 Pi is the only harness, and the MCP attempt showed why

`mpt-mcp-server` was meant to bring Claude, Codex, and Kiro to the team. It is
now fully dead, in two distinct ways — and the second one is the lesson.

**It drifted a protocol generation behind.** It still calls endpoints the daemon
no longer has: `/api/assistant/notes` and `/api/assistant/notes/search` (so its
memory tools are inert), `/api/agents/release/:taskId`, and
`/api/spawn-requests/:id/ack` (only `DELETE /api/spawn-requests/:id` exists).
mpt-demo-team's `run-e2e-kiro.sh` invokes `src/runners/kiro/runner.mjs`, deleted
in `fbba4ac`. Nothing in that repo runs.

**More fundamentally, an MCP server can only expose tools.** Compare what the Pi
extension actually does beyond tools: directive polling, `readiness.ts`,
`transcript.ts` (the mirror), `pairing.ts`, `usage.ts`, `permissions.ts`,
`bubbles.ts`. That is a *supervisory loop* that drives an agent. MCP is passive —
the model calls a tool if and when it decides to. Nothing in MCP can poll for a
directive and make the agent act on it, mirror a transcript, or auto-approve a
permission prompt.

So "Pi works, the others are flaky" is really: **Pi is the only harness with a
host process running the loop.** Repairing the MCP server's URLs would not have
changed that. It is deleted (tagged `archive/mpt-mcp-server`), and §2.1 explains
what replaces it.

### 1.4 Multi-host was never used, and it taxes everything

`hostId` exists throughout the daemon, but nothing configures it: neither `hosts`
nor `readinessProbe` appears in any config file or demo fixture in the tree. The
pool spawner doesn't route anywhere — `pickPoolSpawnHost()` (`store.ts:2466`)
finds *the* leader and returns its host. `SpawnDialog.tsx` makes the user pick
from a dropdown that in practice holds exactly one entry and errors when empty.

The cost isn't just dead code. Because leaders are notionally per-host, the
daemon must *designate* one of them as the chat agent and keep that designation
sticky (`chatAgentId`, `store.ts:217` and `:2291`; the `chat: true|false` flag in
`routes/assistant.ts` so non-designated leaders don't double-answer). All of that
exists only to work around a plurality that never existed.

## 2. The target experience

```bash
# install mpt (one binary), then, in your project:
mpt setup     # checks + fixes prerequisites, installs the Pi extension, creates the team dir
mpt lead      # starts the leader in tmux
```

`mpt upgrade` updates the daemon **and** the extension together. `mpt doctor`
re-runs the checks any time something seems off.

---

## 3. Design shifts

Three decisions shape the phases. They are the reason this is a re-plan and not
just a repo move.

### 3.1 The supervisor moves from the extension into `mpt`

Today every tmux action lives in the Pi extension: `execSync` of `send-keys` at
`leader.ts:606`, `:664`, `:674`, and the harness command templates as a hardcoded
constant at `leader.ts:49`. The daemon knows tmux only as config and types; it
never touches it.

Moving session management, window spawning, prompt injection, and the health
probe into `mpt` changes what a harness *is*:

- **Harness templates become team config, not extension constants.** Adding a
  harness stops being an extension release.
- **A non-Pi teammate needs no adapter at all.** `mpt` creates the window,
  `send-keys` the instructions, and probes for liveness. Degraded — no transcript
  mirror, no usage ledger, no permission auto-approval — but functional.
- **The extension shrinks to what only Pi can do:** in-process transcript
  mirroring, permission leases, chat bubbles, `/new` session control.

This is Tier 0 below, and it was already prototyped once: the deleted
`runners/kiro/runner.mjs` was a Node process driving `kiro-cli` in tmux. The idea
was right; it lived in the MCP repo, so it inherited MCP's passive framing and
died with it. Rebuilt inside `mpt`, it isn't a sidecar — it's just what the
daemon does.

### 3.2 Harness support is tiered, not all-or-nothing

| Tier | Mechanism | What you get | Harnesses |
| --- | --- | --- | --- |
| **0 — text-driven** | `mpt` owns tmux; prompts in via `send-keys`; health probe for liveness | spawn, dismiss, prompt delivery | any CLI agent |
| **1 — reporting** | + a tool surface so the agent claims work and posts comments | real task state | anything with MCP/tools |
| **2 — native** | + in-process adapter: transcript, usage, pairing, permissions | full fidelity | Pi |

Tier 0 falls out of §3.1 for free. Tier 1 is where an MCP surface earns its place
— as the *tool half* of an integration whose loop already exists, which is
exactly what the old server lacked. Tier 2 stays Pi-only for the foreseeable
future.

The leader does **not** have to be Pi. It is the agent you chat with (DESIGN.md
"One Agent to Talk To"), but once `mpt` owns tmux and the daemon owns the
directive channel, nothing about leading requires Pi specifically.

### 3.3 One host, one leader

Multi-host is removed (§1.4). `hostId` currently does three jobs; only one dies.

| Job | Fate |
| --- | --- |
| Cross-machine routing and affinity | **Delete.** Never configured, never routed. |
| The leader-directive channel | **Collapse to singular.** `/api/hosts/:hostId/leader/directives` → `/api/leader/directives`. Still the live daemon→leader mechanism; it just stops pretending to be plural. |
| Readiness gating | **Keep the feature, re-key it to the team, move the probe into `mpt`.** |

Readiness gating is worth defending. Its motivating case is real
(ARCHITECTURE.md:107): expired `mwinit` on a cloud desktop shouldn't pile up
FAILED cron runs overnight, and the held Schedule re-fires exactly once on
recovery. That feature is about "can this machine work right now," not about
having several machines. So `HostReadiness` becomes `TeamReadiness`, and per §3.1
the daemon runs the probe itself on cron — no `POST /readiness`, no leader
involvement.

That also fixes a latent inversion. Today readiness is reported *by an agent on
the host*, and an unreported host is treated as ready. If a box is wedged badly
enough that the leader can't start, nobody reports "not ready" and the daemon
cheerfully enqueues into it. A daemon-side probe works with zero agents
connected, which is precisely when it matters.

Collapsing to one leader also deletes the chat-agent designation path outright,
making "One Agent to Talk To" true rather than approximated.

---

## 4. Phases

### Phase 0 — Safety net and desk-clearing

No behavior change, so it can't conflict with anything later. Justified by one
finding: **the extension is never type-checked.** `pi-pizza-team` has no
`tsconfig.json`, no `deno.json`, and no `scripts` field — nothing validates its
4,555 lines of TypeScript. Pi strips types at load; the tests are `.mjs`, so they
exercise stripped JS. There isn't even a documented way to run them
(`node --test tests/*.ts` silently reports 0 tests; the working incantation is
`node --test tests/*.mjs`, which yields 286 passing assertions across 13 files).

Phase 1c moves 1,461 lines out of that package and rewires every import. A
type-check is the safety net for that refactor; without it, a bad import path
surfaces as a teammate mysteriously failing to start.

1. Add `tsconfig.json` and `scripts.test` to `pi-pizza-team` — type-check plus a
   documented test command.
2. Extend `deno task check` to cover `tests/` (today it checks four entrypoints:
   `daemon/main.ts`, `server.ts`, `store.ts`, `cli/main.ts`).
3. `docs/history/` — move the shipped and superseded plans, with a one-line
   index. Roughly 1,235 of 2,665 doc lines are archaeology:
   `ASSISTANT_CHAT_V2.md` (508, "implemented"),
   `FRONTIER_ENGINEER_REFACTOR_PLAN.md` (410, superseded by
   `WORKDEF_UNIFICATION.md`), `FRONTIER_ENGINEER_REFACTOR.md` (132),
   `THOUGHTS-PORT-DIFF.md` (115). A newcomer can't currently tell current from
   historical, and per AGENTS.md every agent reads this directory.
4. Execute `TODO.md` — it's already a curated list of stale docs and comments
   with quoted anchors — then delete it.
5. Fix `server.ts:9`, which documents a route module that doesn't exist
   ("teammate: legacy teammate protocol (next-task, claim, status, team)"). There
   is no `registerTeammateRoutes` and no `next-task` route.

Explicitly **not** in scope: `daemon/store.ts` (2,936 lines) is the one real
hotspot, but splitting it while also moving repos and breaking the protocol is
how a weekend disappears. Phase 1c already carves out `pickPoolSpawnHost`, host
affinity, and readiness — take the free reduction first, then reassess with a
type-check in place.

### Phase 1a — One repo (move only, zero refactor)

- `git subtree add --prefix=harnesses/pi` from pi-pizza-team, preserving history.
- Delete mpt-mcp-server (tag `archive/mpt-mcp-server` first).
- Root `deno.json` version becomes *the* version; generate
  `harnesses/pi/package.json`'s version at build time so it can't drift. One
  `scripts/publish.sh`, one release.
- `deno task test:ext` keeps running the extension's Node suites.
- Leave `harnesses/pi/src/shared/types.ts` alone — that's 1c's job.
- Update `AGENTS.md` ("four separate projects" → two) and mpt-demo-team's
  scripts, including the broken `run-e2e-kiro.sh`.
- The extension stays publishable as a Pi package from this repo (its
  `package.json` with the `pi-package` keyword moves with it), so
  `pi install git:…` keeps working standalone.

Deletions that come free here: `work-defs.ts:124` notes the task-scoped
attachment routes are "kept for compat" with mpt-mcp-server, so
`/api/tasks/:taskId/attachments`, `/attachments/:filename`, and
`/api/tasks/:taskId/token-usage` lose their last client.

Green build, nothing else changed.

### Phase 1b — Version handshake

Trivial once there's one version number, and it **must land before any protocol
break**.

- `PROTOCOL_VERSION` lives in `shared/`. `POST /api/agents/register` accepts
  `{ protocolVersion, harness, harnessVersion }`.
- Gate hard on **protocol** version only; a version the daemon can't serve is
  refused with a clear error rather than half-working. Report build version
  informationally — gate on it and every daemon patch nags the whole team until
  people learn to ignore the banner.
- A mismatch shows in the UI (the Team tab row, and a banner): *"swift-ripley
  runs extension 0.16.0; the daemon is 0.17.0 — restart it."*
- The `harness` field costs one line now and saves versioning the handshake twice
  when Tier 0/1 arrive.

### Phase 1c — Drop multi-host; extract the agent runtime

Ordered after 1b because removing `/api/hosts/:hostId/leader/directives` breaks
*silently* in the worst way: an old leader polls a now-404 endpoint forever and
simply never spawns anyone. No error, no teammates — the exact failure mode this
document exists to kill. With the handshake in place it fails loudly instead.

**Remove (per §3.3):** `hosts` config and `HostConfig`, `pickPoolSpawnHost`, host
affinity rollup in `canScheduleForDirectory`, the three `/api/hosts*` routes plus
`/api/hosts-readiness`, the `SpawnDialog` host picker, and the whole chat-agent
designation path. Re-key readiness to the team.

**Extract:** `harnesses/pi/src/shared/types.ts` starts importing from `shared/`;
then the Pi-free modules move to `agent-runtime/`.

| Pi-free → `agent-runtime/` | | Pi-coupled → stays in `harnesses/pi/` | |
| --- | --- | --- | --- |
| `client.ts` | 841 | `leader.ts` | 713 |
| `transcript.ts` | 265 | `tools.ts` | 703 |
| `bubbles.ts` | 129 | `index.ts` | 496 |
| `pairing.ts` | 96 | `permissions.ts` | 438 |
| `usage.ts` | 66 | `teammate.ts` | 412 |
| `readiness.ts` | 64 | `chat.ts` | 299 |
| **total** | **1,461** | **total** | **3,094** |

`client.ts` — the entire protocol client — already has zero Pi imports. The seam
exists; this phase just makes it explicit.

**Constraint:** `agent-runtime/` must import cleanly under both Deno (daemon,
tests) and Pi's Node type-stripping loader. So: zero dependencies, no `Deno.*`,
no `node:*` — `fetch` and types only. `client.ts` already qualifies; add a purity
check so it stays that way.

Bundle here, since the protocol is already breaking: the chat v1 migration
(`store.ts:412-413` DEPRECATED columns, `assistant-chat.ts:495`
`migrateLegacyMessages()`) and the deprecated config fields at
`shared/types.ts:35-40` ("accepted and ignored"). Open question in §6.

### Phase 2 — `mpt` carries the extension; `mpt setup`

The binary already embeds `ui/dist/` (`deno compile --include`); embed the
extension's source the same way.

- **`mpt setup`** (idempotent — safe to re-run):
  1. Runs the Phase 1b/doctor checks and fixes what it can: installs
     `@gotgenes/pi-permission-system` if missing, offers to trust the folder.
  2. Writes the embedded extension to a managed, versioned directory
     (`~/.my-pizza-team/pi-extension/`) and registers that path in Pi's package
     list, replacing any older pi-pizza-team entry so there's exactly one.
  3. Creates the team dir (as `mpt start` does today) and offers `mpt install`
     for the service.
  4. Prints the next step (`mpt lead`).
- **`mpt doctor`** — the same checks, read-only, printing one fix per problem: Pi
  installed and a supported version; tmux; extension version vs. the daemon's;
  the permission system; team dir exists and the folder is trusted; daemon
  running, leader connected, service installed; `GITHUB_TOKEN` (a hint only).
- **`mpt upgrade`** rewrites the managed extension directory after replacing the
  binary, so both halves move together. Running agents pick it up on their next
  Pi restart, and the 1b handshake shows which ones haven't yet.
- **`mpt setup --uninstall`** removes the managed extension and its Pi package
  entry, restoring Pi's settings as found. Because setup edits the user's Pi
  configuration, it records a manifest of what it changed.
- **Development** is unchanged: point Pi at the checkout
  (`pi install /path/to/my-pizza-team/harnesses/pi`); `mpt setup` detects a dev
  path and leaves it alone.

Constraint: Pi loads extensions as TypeScript files from disk, so "bundled" means
*mpt writes them out* — the extension can't run inside the binary. That's fine;
it just means setup must be careful and reversible.

### Phase 3 — `mpt lead` and daemon-owned tmux

Start the leader: ensure the tmux session exists, open a window in the project
dir, run the harness with the right flags. After this, `mpt` is the only command
a user has to remember.

This is also where §3.1 lands: session management, `send-keys`, and the health
probe move out of `leader.ts` and into the daemon, and harness templates become
team config. `mpt lead` is the first real exercise of that code — a natural Tier 0
dry run with the harness that already works.

### Phase 4 — A second harness

With §3.1 done, this is config plus a spawn template, not a new integration. Pick
one harness, get it to Tier 0 (spawn, prompt delivery, dismiss), then decide
whether Tier 1's tool surface is worth building for it.

---

## 5. Order and payoff

| Phase | Effort | Payoff |
| --- | --- | --- |
| 0. Safety net + desk-clearing | small | The refactor has a type-check; docs stop misleading readers |
| 1a. One repo, one version | medium (mechanical) | Atomic cross-cutting changes; one release |
| 1b. Version handshake | small | Skew becomes visible; required before any break |
| 1c. Drop multi-host + extract runtime | medium | Large net deletion; the harness seam becomes explicit |
| 2. Embedded extension + `setup`/`doctor` | medium | Setup is one command; upgrades keep both halves in step |
| 3. `mpt lead` + daemon-owned tmux | medium | One entry point; Tier 0 exists |
| 4. Second harness | small per harness | Multi-harness support, incrementally |

After Phase 2, setup is: install `mpt`, run `mpt setup` in your project, then
`mpt lead`.

## 6. Open questions

- **Does `pi install <path>` re-read from disk at agent start, or snapshot at
  install time?** If it snapshots, Phase 2's `mpt upgrade` rewriting the managed
  directory won't roll agents even after a restart, and setup has to re-register
  the path on every upgrade. This needs answering before Phase 2 is designed.
- **The permission-system dependency.** Keep depending on
  `@gotgenes/pi-permission-system` and install it in `mpt setup`, or make the
  extension degrade explicitly — warn loudly at teammate start that autonomous
  runs will prompt? Bundling a third-party install means setup can break when
  someone else publishes. Leaning toward: explicit degradation, with `doctor`
  offering the command rather than silently installing.
- **Restarting a running team after `mpt upgrade`.** Agents keep the old
  extension until their Pi restarts, so an upgrade trades silent skew for visible
  skew with no remedy. Should the daemon offer a per-member `reset-session`-style
  directive so the UI can roll the whole team? Small, and it completes the
  upgrade story.
- **Does any real user have chat v1 data?** If not, Phase 1c drops
  `migrateLegacyMessages()` and the deprecated columns outright rather than
  carrying them.
- **Where does the managed extension live?** Under `~/.my-pizza-team/` (one copy
  per machine, shared by every team) vs. inside the team dir (per team,
  committed?). Home is the natural fit: the extension is per-machine tooling, the
  team dir is team data.
- **Pi version compatibility.** The extension targets a Pi extension API;
  `doctor` should check a minimum Pi version, and releases should state which Pi
  versions they were tested against.

## 7. Resolved

- **Multi-host is out** (§3.3). It was added early, never configured, and taxed
  the chat-agent path for nothing. One host, one leader.
- **`mpt-mcp-server` is deleted** (§1.3). MCP alone can't supervise an agent;
  Tier 0/1 replaces it.
- **The leader need not be Pi** (§3.2).
- **Move then extract** (Phases 1a → 1c), so the mechanical move reviews cleanly
  on its own.

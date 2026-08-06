# Architecture

This document explains how pi-pizza-team is structured internally, for developers who want to modify or extend the codebase.

## Overview

pi-pizza-team is a **thin Pi extension** that connects to the my-pizza-team daemon. It does NOT own any state — all data operations go through the daemon's HTTP API.

The extension operates in one of three roles:

```
┌─────────────────────────────────────────────────────────────┐
│  Extension loads (src/index.ts)                              │
│                                                              │
│  Which --ppt-* flag is set?                                 │
│  ├── --ppt-lead → setupLeader()                             │
│  │         • Register with daemon as "leader" agent          │
│  │         • Poll leader directives → tmux                    │
│  │         • Register LLM tools + slash commands             │
│  │         • Show status widget                              │
│  │                                                          │
│  ├── --ppt-assistant → setupAssistantRole()                 │
│  │         • Register with daemon as "assistant" agent       │
│  │         • Advertise the `persona` capability             │
│  │         • Poll assistant turns → claim → execute          │
│  │         • Inject daemon-vended persona as system prompt   │
│  │                                                          │
│  ├── --ppt-worker → setupTeammateRole()                     │
│  │         • Register with daemon as "teammate" agent        │
│  │         • Poll for work → claim → execute → done       │
│  │         • Register permission bypass                      │
│  │         • Listen for agent_end to capture results         │
│  │                                                          │
│  └── (none) → Extension is inactive                         │
└─────────────────────────────────────────────────────────────┘
```

## Module Map

```
src/
├── index.ts              # Entry point: flag registration, role detection, setup
├── client.ts             # DaemonClient: unified HTTP client for all daemon API calls
├── leader.ts             # Leader role: tmux management, spawn polling, slash commands, host readiness probe
├── teammate.ts           # TeammateLoop: poll → claim → work → set-state (COMPLETE/FAILED) → fresh session loop
├── assistant.ts          # AssistantLoop: poll turn → claim → stream bubbles → complete
├── tools.ts              # LLM-callable tools (shared across roles, all via daemon API)
├── permissions.ts        # Dynamic yoloMode toggling + ppt-autonomous authorizer chain link
├── readiness.ts          # Host readiness probe (leader-run): exit 0 = ready, non-zero = not ready
└── shared/
    └── types.ts          # Minimal types: WorkflowConfig, DEFAULT_DAEMON_URL, helpers
```

## Data Flow

All state is owned by the **my-pizza-team daemon**. The extension is a pure client.

### Teammate (agent protocol)

```
┌─────────────────────────────────────────────────────────┐
│  TeammateLoop  (work model: workers never move tasks)   │
│                                                          │
│  1. GET  /api/agents/next-work?agentId=X                 │
│     └── a READY WorkItem (chosen by directory affinity)  │
│  2. POST /api/agents/claim/:workItemId  (→ IN_PROGRESS)  │
│  3. pi.sendUserMessage(claim.prompt)                     │
│     └── daemon-assembled prompt (state persona + task), │
│         delivered verbatim; agent cds to the story dir   │
│  4. agent_end event fires                                │
│     └── handleAgentComplete(lastAssistantMessage)        │
│         ├── item failed via the `fail` tool → skip       │
│         └── else POST .../work-items/:id/state COMPLETE  │
│             └── daemon advances the task mechanically    │
│  5. Back to step 1                                       │
└─────────────────────────────────────────────────────────┘
```

Rework needs no special path: a human moves the task back into an agent state,
which enqueues a fresh READY WorkItem, and the next poll discovers it like new
work — with the human's comments in the prompt. "Giving up" is the agent
composing a comment + `FAILED` (the `fail` tool); the task is left stuck for a
human. See the daemon's docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.

### Leader (spawn management)

```
┌─────────────────────────────────────────────────────────┐
│  Leader                                                  │
│                                                          │
│  1. POST /api/agents/register (role=leader)             │
│     └── adopts daemon config: tmuxSession, directories, │
│         harness templates (syncDaemonConfig)            │
│  2. Poll GET /api/hosts/:hostId/leader/directives (5s) │
│     └── For each request: spawn tmux window + ack       │
│  3. User tools → POST /api/stories, /api/stories/:id/tasks │
│  4. (opt) Run host readiness probe → POST                │
│     /api/hosts/:hostId/readiness on each heartbeat       │
└─────────────────────────────────────────────────────────┘
```

**Host readiness probe (leader-owned).** The leader is the per-host singleton,
so it also owns the optional *host readiness probe* — a host-level check
(credentials, VPN, network). Configured via the daemon's **Config page** (the
recommended way — `readinessProbe` in config.json, with per-host override at
`hosts[hostId].readinessProbe`), or the `--ppt-readiness-probe` flag /
`PPT_READINESS_PROBE` env var (highest-priority override for local dev/testing).
The leader resolves: **flag > host-specific config > default config**. On each
heartbeat it runs the command (exit 0 = ready; non-zero = not ready, stdout's
first line is the reason) and reports the result to `POST
/api/hosts/:hostId/readiness`. The daemon uses this to **hold** scheduled work
destined for the host instead of failing it — e.g. while cloud-desktop `mwinit`
credentials are expired — and fires the held job once when the host recovers
(see the daemon's docs/ARCHITECTURE.md "Scheduler readiness gating"). No probe
configured → the host is always considered ready (fully backward compatible).
Because the leader re-syncs daemon config on each heartbeat, changing the probe
in the UI takes effect within 30 seconds without restarting the leader.

**Config sync is retryable, not one-shot.** The leader starts with a
hardcoded fallback `tmuxSession` ("pi-pizza-team") that must be replaced by
the daemon-configured value before any spawn is realized. Because the leader
may start while the daemon is down — or the daemon may restart and forget the
registration — `syncDaemonConfig()` is retried from the heartbeat loop until
it succeeds, re-runs whenever a heartbeat reports `dismissed` (daemon
restart), and the directive poll refuses to dispatch until at least one sync
has succeeded. This prevents agents from being spawned into the fallback
session when the daemon was merely unreachable at leader startup.

### Assistant (chat response turns)

```
┌─────────────────────────────────────────────────────────┐
│  AssistantLoop                                           │
│                                                          │
│  1. GET  /api/assistant/next   (a response turn, or null │
│     while one is processing / nothing unanswered / the   │
│     pre-claim debounce hasn't elapsed)                   │
│  2. POST /api/assistant/messages/:id/claim               │
│     └── coalesced user messages flip to `read`           │
│  3. refresh persona → pi.sendUserMessage(item.prompt)    │
│  4. agent replies by calling the `send_message` tool,    │
│     once per chat bubble:                                │
│        POST /api/assistant/messages/:id/say  (× N)       │
│     └── bubbles appear in the web UI progressively       │
│  5. agent_end → POST /api/assistant/messages/:id/complete│
│     └── `result` is only a fallback if no bubbles sent   │
│  6. Back to step 1                                       │
└─────────────────────────────────────────────────────────┘
```

**Chat model.** The daemon owns a real chat (see its DESIGN.md "Assistant chat
 model"): append-only messages, decoupled from response *turns*. The extension
never batches or splits text itself — it hands the prompt to Pi, and the agent
produces the bubbles by calling `send_message` (wired to the active turn id).
The batching guidance and the `send_message` contract come from the daemon's
`ASSISTANT_CHAT_FRAMING`, injected ahead of every persona.

**Persona injection.** The assistant registers with a `persona` capability so the
web UI knows this build can adopt a persona. It caches the daemon's active
persona (`GET /api/assistant/persona`, refreshed each turn) and a
`before_agent_start` hook appends the persona entry's body to the system prompt.
Swapping a persona in the UI resets the session (via the `reset-session`
directive), so the next turn starts fresh under the new persona.

## Daemon API (consumed by this extension)

The extension communicates with the my-pizza-team daemon (default: `http://localhost:7437`).

### Agent Protocol Routes (new)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/agents/register` | POST | Register agent (name, working `directory`, metadata) |
| `/api/agents/heartbeat` | POST | Agent keepalive (restores this agent's MORIBUND items) |
| `/api/agents/next-work?agentId=X` | GET | Poll for a `READY` WorkItem (directory affinity) |
| `/api/agents/claim/:workItemId` | POST | Lease the WorkItem (→ IN_PROGRESS) + get the daemon prompt |
| `/api/agents/work-items/:workItemId/state` | POST | Set COMPLETE (advance task) or FAILED (leave stuck) |
| `/api/agents/work-items/:workItemId/token-usage` | POST | Report token usage + the harness's real `costUsd` (pi's cache-aware total; daemon estimates only if omitted) |
| `/api/agents/work-items/:workItemId/attachments` | POST | Upload an attachment (resolved to the ref) |

### Task Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/tasks/:id/comment` | POST | Post a comment |
| `/api/tasks/:id/comments` | GET | Get task comments |
| `/api/tasks/:id/token-usage` | POST | Record token usage |
| `/api/tasks/:id/attachments` | POST | Upload file attachment |

### Story/Task Management (leader tools)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/stories` | POST | Create story (accepts `context`: entry ids attached story-wide) |
| `/api/stories/:id` | PUT | Update story |
| `/api/stories/:storyId/tasks` | POST | Add task to story (accepts `context`: entry ids for that task) |
| `/api/workflows` | GET | List workflows for the `list_workflows` tool (name, counts, isDefault) |
| `/api/context` | GET | List context-library entries for the `list_context` tool |
| `/api/assistant/messages` | POST | Send a message to the assistant |

The leader and assistant tool sets both expose planning tools: `create_story`
and `add_task` take an optional `context` array (context-library entry ids to
attach), and `list_workflows` / `list_context` are read-only helpers so a
planner can pick a valid workflow and choose which context to attach before
creating anything. Agents still never create or edit context entries — those
are authored in the UI/daemon.

### Assistant Conversation
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/assistant/next` | GET | Next response turn (coalesced unanswered user messages), or null while one is processing |
| `/api/assistant/messages/:id/claim` | POST | Claim a turn (marks its user messages `read`) |
| `/api/assistant/messages/:id/say` | POST | Append one chat bubble to the active turn (the `send_message` tool; call repeatedly to batch) |
| `/api/assistant/messages/:id/complete` | POST | Close the turn (`result` is a fallback bubble used only if none were sent) |
| `/api/assistant/persona` | GET | Effective system prompt (daemon-vended: chat framing + selected persona or default) |
| `/api/scratchpad` | GET | Read the user's scratch pad (todos + notes) for the read_scratchpad tool |

### Spawn / Config
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/hosts/:hostId/leader/directives` | GET | Poll the leader's directive queue |
| `/api/hosts/:hostId/leader/directives/:id` | PUT | Mark a directive done |
| `/api/config` | GET | Get daemon config |
| `/api/hosts/:hostId` | GET | Host-specific config |
| `/health` | GET | Health check |
| `/api/status` | GET | Dashboard summary |

## CLI Flags

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `--ppt-lead` | boolean | false | Run as team leader |
| `--ppt-worker` | boolean | false | Run as teammate |
| `--ppt-assistant` | boolean | false | Run as assistant |
| `--ppt-daemon` | string | `http://localhost:7437` | Daemon URL |
| `--ppt-name` | string | (auto) | Agent name |

### Teammate work selection: directory affinity

Teammates are generalists — no capability/skill or work-mode configuration.
`setupTeammate()` registers the teammate's working directory (its pi cwd) via
`DaemonClient.register({ name, directory })`. The daemon biases work by
directory (my-dir → un-homed → other-dir-if-nobody-homed-there); the teammate
never reasons about matching. A teammate on work whose directory it can't reach
just fails that item.

Spawn requests carry only a `cwd` (the teammate's working directory). There is
no story binding or skills argument — `spawnAgent()` leaves the `{workArgs}`
placeholder empty. The spawn cwd is where the teammate homes (and thus what it's
biased toward).

`spawnAgent()` is idempotent by tmux window name: because tmux does **not**
enforce unique window names, `new-window -n <name>` would create a duplicate
window every time it runs. Before creating a window, `spawnAgent()` checks
`listWindows()` and returns early (no window created) if one with that name
already exists. This prevents retried spawn directives — e.g. when
`completeLeaderDirective()` fails to reach the daemon and the poll loop re-runs
the same directive — from filling the session with identically-named, empty
windows.

**Spawn robustness.** `spawnAgent()` validates the working directory
(`validateSpawnCwd()`) **before** touching tmux and throws if it's missing or
not a directory — so an accidental/half-typed cwd can't create an orphan
window. Writing the permissive Pi config (`ensurePermissiveConfig()`) is treated
as best-effort: a failure (e.g. a read-only cwd) is caught and logged rather
than aborting the spawn. When realizing a directive throws, the poll loop marks
it **failed** via `client.failLeaderDirective()` (PUT status `failed`) instead
of leaving it pending — otherwise an ask that can never succeed (like a bad cwd)
would be retried every poll cycle forever. `/ppt-spawn` also validates the cwd
up front and reports the error without creating a directive at all.

### Agent control intents (daemon → leader → tmux)

The daemon expresses out-of-band intents (e.g. `reset-session`) without knowing
how they're realized. At spawn time the leader passes each agent its tmux
session/window (`--ppt-tmux-session/--ppt-tmux-window`); the agent reports those
as opaque `metadata` on registration. The leader polls its single directive
queue and `dispatchDirective()` realizes each one; `deliverAgentCommand()` maps a
control intent to Pi keystrokes — `reset-session`
becomes `/new` sent to the agent's window — then acks. This is where all
harness/tmux mechanism lives; the daemon stays agnostic.

## Permission System Integration

Uses `@gotgenes/pi-permission-system`'s `yoloMode` flag, read fresh on every tool call, plus a registered **authorizer chain link**.

File: `<cwd>/.pi/extensions/pi-permission-system/config.json`

- **Created at spawn time** by leader's tmux spawner with `yoloMode: true` + `authorizerChain: ["ppt-autonomous"]`
- **Toggled dynamically** by `permissions.ts`:
  - Interactive input detected → rewrite with `yoloMode: false` + pause loop
  - `/ppt-worker-resume` → rewrite with `yoloMode: true` + resume loop
- **Authorizer chain link** (`ppt-autonomous`, registered by `registerAutonomousAuthorizer`): yoloMode alone cannot approve the permission system's fail-closed asks — as of v24 its bash **wrapper floor** clamps any `allow` (yolo included) back to `ask` for indirection wrappers (`timeout`, `nohup`, `sudo`, `env`, `xargs`, ...). The link answers those asks: `allow` while autonomous, `defer` (normal prompting) while pairing. It resolves the service via the `Symbol.for("@gotgenes/pi-permission-system:service")` globalThis slot (no hard dependency; degrades gracefully when absent), re-registers on every `permissions:ready` broadcast, and writes a `ppt.autonomous_auto_allow` audit entry per auto-allowed ask. The chain owner caps its authority: an allow on the `path`/`external_directory` surfaces downgrades to defer.

## tmux Integration (leader only)

- Polls its directive queue via `/api/hosts/:hostId/leader/directives`
- Creates tmux windows with `pi -a --ppt-worker --ppt-daemon=<url> --ppt-name=<name>`
- Identity is daemon-owned: the leader names each tmux window (and the `--ppt-name`) after the directive's `params.name`, never inventing one. Teammate spawns carry a generated adjective-noun name; assistant spawns (`reason: "assistant"`) carry the reserved singleton name `assistant` and use the `pi-assistant` template — which differs only in the `--ppt-assistant` **role** flag, still threading `{name}`. This is why the tmux window, registered name, and MPT UI label always match.
- `-a` (`--approve`) trusts the teammate's project cwd non-interactively, so a spawn into a folder outside a trusted parent (`~/.pi/agent/trust.json`) doesn't block on pi's "Trust project folder?" prompt
- Writes permissive permission config to teammate's cwd before launching (only applied once the project is trusted, hence `-a`)

## Key Design Decisions

1. **Extension is a thin client** — no SQLite, no HTTP server, no state ownership
2. **Daemon owns all state** — stories, tasks, workflows, context library, assistant conversation
3. **Agent protocol for teammates** — `/api/agents/*` routes: claim (lease) → set-state (COMPLETE/FAILED); workers never move tasks (the daemon reacts to a terminal WorkItem — advance + admit; see the daemon's FRONTIER_ENGINEER_REFACTOR_PLAN.md)
4. **Workflow-agnostic teammate** — never hardcodes state names; the state persona in the claim prompt tells it what role it plays
5. **Task execution uses sendUserMessage** — keeps teammate interactive for pairing
6. **Daemon owns the prompt** — the teammate sends `claim.prompt` verbatim and never augments it; all prompt content/wording lives in the daemon so every harness stays consistent (session-specific framing, if ever needed, would be the harness's only addition)
7. **`fail` over sentinel parsing** — giving up is the agent composing two primitives (a comment + set the WorkItem `FAILED`), never a magic string in the agent's output
8. **Permission toggle is file-based** — leverages permission system's runtime config reload
9. **One leader directive queue** — leader polls `/api/hosts/:hostId/leader/directives` and realizes each (spawn, reset-session) locally over tmux
10. **Task-level comments** — lead ↔ teammate via `/api/tasks/:id/comment[s]`, not a chat stream
11. **Assistant replies as chat bubbles** — the assistant answers by calling the `send_message` tool once per bubble (`.../say`), not by returning one blob. Batching guidance lives in the daemon's `ASSISTANT_CHAT_FRAMING` (injected ahead of every persona), so the extension never splits/batches text itself; it just wires `send_message` to the active turn id and lets the daemon own the chat model.
12. **Fresh session per work item** — after each COMPLETE/FAILED the teammate queues `/ppt-fresh-session` (a command, because session control only exists on command contexts) which calls `ctx.newSession()`; the reload re-runs `session_start`, re-registering the same member with a clean context. The shutdown for a self-reset skips deregistration so the member never flickers offline in the UI (the daemon's heartbeat timeout still covers a reset that dies mid-way). Self-managed by the teammate — the daemon/leader `reset-session` directive remains only for manual resets from the UI.

## Extending

### Adding a new tool
1. Add to `src/tools.ts` inside `registerTools()`
2. Use the `client` parameter for all daemon API calls
3. Add response type to `src/client.ts` if needed

### Adding a new slash command (leader)
1. Add to `src/leader.ts` inside `setupLeader()`
2. Use `client` for data access

### Modifying the work loop
1. Edit `src/teammate.ts` (`TeammateLoop` class)
2. All daemon communication goes through `this.client`

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
│  │         • Poll for work → claim → execute → transition    │
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
├── leader.ts             # Leader role: tmux management, spawn polling, slash commands
├── teammate.ts           # TeammateLoop: poll → claim → execute → transition work loop
├── assistant.ts          # AssistantLoop: poll next → claim → execute → complete
├── tools.ts              # LLM-callable tools (shared across roles, all via daemon API)
├── permissions.ts        # Dynamic yoloMode toggling for permission system
└── shared/
    └── types.ts          # Minimal types: WorkflowConfig, DEFAULT_DAEMON_URL, helpers
```

## Data Flow

All state is owned by the **my-pizza-team daemon**. The extension is a pure client.

### Teammate (agent protocol)

```
┌─────────────────────────────────────────────────────────┐
│  TeammateLoop                                            │
│                                                          │
│  1. GET  /api/agents/next-work?agentId=X                │
│  2. POST /api/agents/claim/:taskId                      │
│  3. pi.sendUserMessage(claim.prompt)                     │
│     └── daemon-assembled prompt, delivered verbatim     │
│     └── Pi agent executes the task autonomously         │
│  4. agent_end event fires                               │
│     └── handleAgentComplete(lastAssistantMessage)       │
│         ├── If "NEEDS_INPUT:" → post comment + transition│
│         └── Else → transition to review + post summary  │
│  5. Back to step 1                                      │
└─────────────────────────────────────────────────────────┘
```

### Leader (spawn management)

```
┌─────────────────────────────────────────────────────────┐
│  Leader                                                  │
│                                                          │
│  1. POST /api/agents/register (role=leader)             │
│  2. Poll GET /api/hosts/:hostId/leader/directives (5s) │
│     └── For each request: spawn tmux window + ack       │
│  3. User tools → POST /api/stories, /api/stories/:id/tasks │
└─────────────────────────────────────────────────────────┘
```

### Assistant (conversation turns)

```
┌─────────────────────────────────────────────────────────┐
│  AssistantLoop                                           │
│                                                          │
│  1. GET  /api/assistant/next                            │
│  2. POST /api/assistant/messages/:id/claim                 │
│  3. refresh persona → pi.sendUserMessage(item.prompt)    │
│  4. agent_end → POST /api/assistant/messages/:id/complete  │
│  5. Back to step 1                                      │
└─────────────────────────────────────────────────────────┘
```

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
| `/api/agents/register` | POST | Register agent with daemon |
| `/api/agents/heartbeat` | POST | Agent keepalive |
| `/api/agents/next-work?agentId=X` | GET | Poll for unclaimed tasks |
| `/api/agents/claim/:taskId` | POST | Claim task ownership |
| `/api/agents/transition/:taskId` | POST | Advance task state |
| `/api/agents/release/:taskId` | POST | Release task |

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
| `/api/stories` | POST | Create story |
| `/api/stories/:id` | PUT | Update story |
| `/api/stories/:storyId/tasks` | POST | Add task to story |
| `/api/assistant/messages` | POST | Send a message to the assistant |

### Assistant Conversation
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/assistant/next` | GET | Next pending assistant turn |
| `/api/assistant/messages/:id/claim` | POST | Claim a turn |
| `/api/assistant/messages/:id/complete` | POST | Complete a turn |
| `/api/assistant/persona` | GET | Effective persona system prompt (daemon-vended; selected entry or default) |
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
| `--ppt-work-mode` | string | `eager-helper` | Teammate work selection (`eager-helper` \| `assigned-story`) |
| `--ppt-story` | string | (none) | Story to bind to for `assigned-story` mode |
| `--ppt-skills` | string | (none) | Comma-separated capabilities the teammate advertises |

### Teammate work selection

At registration `setupTeammate()` builds a capability map — `{ directory: cwd }`
plus each `--ppt-skills` entry (presence-only) — and sends it with the chosen
`workMode`/`assignedStoryId` via `DaemonClient.register()`. The daemon performs
all matching; the teammate never reasons about it.

For `assigned-story` mode, when the daemon archives the exhausted story it
returns `{ task: null, dismiss: true }` from `next-work`; `TeammateLoop.pollForWork`
detects `dismiss`, stops the loop, and fires `onDismissed` so the agent exits.

Spawn requests carrying a `storyId` are launched as assigned-story teammates:
`spawnAgent()` fills the `{workArgs}` placeholder in the pi harness template with
`--ppt-work-mode=assigned-story --ppt-story=<id>`, so a story-scoped spawn runs
its story and then dismisses itself automatically.

`spawnAgent()` is idempotent by tmux window name: because tmux does **not**
enforce unique window names, `new-window -n <name>` would create a duplicate
window every time it runs. Before creating a window, `spawnAgent()` checks
`listWindows()` and returns early (no window created) if one with that name
already exists. This prevents retried spawn directives — e.g. when
`completeLeaderDirective()` fails to reach the daemon and the poll loop re-runs
the same directive — from filling the session with identically-named, empty
windows.

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

Uses `@gotgenes/pi-permission-system`'s `yoloMode` flag, read fresh on every tool call.

File: `<cwd>/.pi/extensions/pi-permission-system/config.json`

- **Created at spawn time** by leader's tmux spawner with `yoloMode: true`
- **Toggled dynamically** by `permissions.ts`:
  - Interactive input detected → rewrite with `yoloMode: false` + pause loop
  - `/ppt-worker-resume` → rewrite with `yoloMode: true` + resume loop

## tmux Integration (leader only)

- Polls its directive queue via `/api/hosts/:hostId/leader/directives`
- Creates tmux windows with `pi --ppt-worker --ppt-daemon=<url> --ppt-name=<name>`
- Writes permissive permission config to teammate's cwd before launching

## Key Design Decisions

1. **Extension is a thin client** — no SQLite, no HTTP server, no state ownership
2. **Daemon owns all state** — stories, tasks, workflows, context library, assistant conversation
3. **Agent protocol for teammates** — `/api/agents/*` routes with claim/release semantics
4. **Workflow-agnostic teammate** — never hardcodes state names, uses daemon transitions
5. **Task execution uses sendUserMessage** — keeps teammate interactive for pairing
6. **Daemon owns the prompt** — the teammate sends `claim.prompt` verbatim and never augments it; all prompt content/wording lives in the daemon so every harness stays consistent (session-specific framing, if ever needed, would be the harness's only addition)
6. **Permission toggle is file-based** — leverages permission system's runtime config reload
7. **One leader directive queue** — leader polls `/api/hosts/:hostId/leader/directives` and realizes each (spawn, reset-session) locally over tmux
8. **Task-level comments** — lead ↔ teammate via `/api/tasks/:id/comment[s]`, not a chat stream

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

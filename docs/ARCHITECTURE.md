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
│  │         • Poll daemon for spawn requests → tmux           │
│  │         • Register LLM tools + slash commands             │
│  │         • Show status widget                              │
│  │                                                          │
│  ├── --ppt-assistant → setupAssistantRole()                 │
│  │         • Register with daemon as "assistant" agent       │
│  │         • Poll assistant queue → claim → execute          │
│  │         • Register save_memory + search_memory tools      │
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
├── assistant.ts          # AssistantLoop: poll queue → claim → execute → complete
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
│  3. pi.sendUserMessage(task.description)                │
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
│  2. Poll GET /api/spawn-requests?hostId=X (every 5s)   │
│     └── For each request: spawn tmux window + ack       │
│  3. User tools → POST /api/stories, /api/stories/:id/tasks │
└─────────────────────────────────────────────────────────┘
```

### Assistant (queue processing)

```
┌─────────────────────────────────────────────────────────┐
│  AssistantLoop                                           │
│                                                          │
│  1. GET  /api/assistant/next                            │
│  2. POST /api/assistant/queue/:id/claim                 │
│  3. pi.sendUserMessage(item.prompt)                     │
│  4. agent_end → POST /api/assistant/queue/:id/complete  │
│  5. Back to step 1                                      │
└─────────────────────────────────────────────────────────┘
```

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
| `/api/assistant/queue` | POST | Enqueue assistant request |

### Assistant Queue
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/assistant/next` | GET | Next pending item |
| `/api/assistant/queue/:id/claim` | POST | Claim item |
| `/api/assistant/queue/:id/complete` | POST | Complete item |
| `/api/assistant/notes` | POST | Save memory note |
| `/api/assistant/notes/search` | GET | Search notes |

### Spawn / Config
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/spawn-requests?hostId=X` | GET | Poll pending spawns |
| `/api/spawn-requests/:id/ack` | POST | Acknowledge spawn |
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

## Permission System Integration

Uses `@gotgenes/pi-permission-system`'s `yoloMode` flag, read fresh on every tool call.

File: `<cwd>/.pi/extensions/pi-permission-system/config.json`

- **Created at spawn time** by leader's tmux spawner with `yoloMode: true`
- **Toggled dynamically** by `permissions.ts`:
  - Interactive input detected → rewrite with `yoloMode: false` + pause loop
  - `/ppt-worker-resume` → rewrite with `yoloMode: true` + resume loop

## tmux Integration (leader only)

- Polls daemon for spawn requests via `/api/spawn-requests`
- Creates tmux windows with `pi --ppt-worker --ppt-daemon=<url> --ppt-name=<name>`
- Writes permissive permission config to teammate's cwd before launching

## Key Design Decisions

1. **Extension is a thin client** — no SQLite, no HTTP server, no state ownership
2. **Daemon owns all state** — stories, tasks, workflows, notes, queue
3. **Agent protocol for teammates** — `/api/agents/*` routes with claim/transition semantics
4. **Workflow-agnostic teammate** — never hardcodes state names, uses daemon transitions
5. **Task execution uses sendUserMessage** — keeps teammate interactive for pairing
6. **Permission toggle is file-based** — leverages permission system's runtime config reload
7. **Spawn via daemon requests** — leader polls for spawns, executes locally via tmux
8. **Comments replace messages** — daemon uses `/api/tasks/:id/comment[s]`

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

# Design

The design philosophy and rationale behind pi-pizza-team. This document describes
the current design, not a history of changes.

## Concept

pi-pizza-team models AI agents as a **team** working a **kanban board**:

- **Team Lead Pi** — orchestrates work and manages tmux windows on a host.
- **Teammate Pis** — autonomous workers, each in its own tmux window.
- **Assistant Pi** — a conversational helper (chat, memory, board edits).
- **You (the Mentor)** — review, guide, and pair when needed.

The name comes from Amazon's "two pizza teams" and the newer "one pizza team" — we
are a **π (3.14) pizza team**. 🍕

## Core Principles

### 1. Pure client; the daemon owns state
The extension holds **no** state. All stories, tasks, comments, config, and
knowledge base live in the [my-pizza-team](https://github.com/timzen/my-pizza-team)
daemon and are reached over HTTP via a single `DaemonClient`. There is no local
SQLite, no filesystem records, no server. This keeps the extension a thin, easily
reasoned-about adapter between Pi and the daemon.

### 2. Role detection at session start
A single extension entry point (`index.ts`) picks a role from flags / config and
wires only that role's behavior:
- `--ppt-worker` → **teammate** loop.
- `--ppt-assistant` → **assistant** loop.
- `--ppt-lead` (or a `.my-pizza-team/` config in cwd) → **leader**.

### 3. Autonomous work is a claim/release loop
A teammate polls the daemon for the next workable task, claims it, sends the task
as a message to its own Pi agent, and on completion releases it with a result
summary. The daemon owns all workflow-state transitions — the teammate never
reasons about workflow topology. If the lead sends a task back with comments, the
teammate rediscovers it on the next poll and picks it up again.

### 4. Two modes of mentoring
Every task belongs to a teammate; the variable is how much mentoring it needs:
- **Async** — the lead leaves task comments; the teammate reads them on (re)claim.
- **Sync (pairing)** — you hop into the teammate's tmux window and work directly.

### 5. The assistant is a chat
The assistant is a real chat, not a request/response form. It works one response
*turn* at a time: it polls for a turn (the coalesced batch of unanswered user
messages), claims it (marking them **read**), runs it in its persistent Pi
session (which retains context across turns), and replies by calling the
`send_message` tool once per chat bubble — so a reply arrives as several short
messages, iMessage-style. The daemon owns the chat model (append-only messages,
turns, read receipts, composer lock) and the batching guidance
(`ASSISTANT_CHAT_FRAMING`, injected ahead of every persona); the extension just
wires `send_message` to the active turn. It also exposes board and memory tools.

### 6. Work selection is capability-based
A teammate registers a **capability map** (its working `directory` plus any
`--ppt-skills`). The daemon only offers it stories whose **requirements** it
satisfies. A teammate can run as an `eager-helper` (any story it can do) or an
`assigned-story` agent (one story, then it dismisses itself). The extension never
implements matching — it just advertises capabilities and honors the daemon.

### 7. The leader realizes daemon intent over tmux
The daemon never knows about tmux or keystrokes; it enqueues **directives** ("an
ask to the leader to do something about an agent"). The leader polls one per-host
directive queue and realizes each: `spawn` → launch a tmux window; `reset-session`
→ send Pi's `/new`. It supplies each spawned agent its tmux window/session, which
the agent reports back as opaque `metadata` so later directives can target it.

### 8. Permission toggling by mode
The permission system (`@gotgenes/pi-permission-system`) follows the teammate's
mode: autonomous work runs with `yoloMode` on (no prompts); when you type into the
window it switches to pairing (`yoloMode` off, normal rules). `/ppt-worker-resume`
returns to autonomous.

## Interaction Model

### Teammate work loop
```
1. Poll   GET /api/agents/next-work        → next workable task (or { dismiss })
2. Claim  POST /api/agents/claim/:id        → daemon transitions to the working state
3. Execute (send the task to the Pi agent)
4. Release POST /api/agents/release/:id      → daemon advances state, stores result
5. Repeat (or shut down if dismissed)
```

### Permission toggling
| Mode | yoloMode | Behavior |
|------|----------|----------|
| Autonomous (working) | `true` | No prompts, full freedom |
| Pairing (human hopped in) | `false` | Normal permission rules |

Detection is automatic: interactive input → pairing; `/ppt-worker-resume` →
autonomous.

## Boundaries

Anything about *persistence* — stories/tasks/comments storage, workflows,
archiving, backlog, knowledge-base indexing, git checkpointing — is the **daemon's**
design, documented in the my-pizza-team repo. This extension only consumes the
daemon's HTTP API and turns intent into local action (tmux, Pi messages,
permissions).

## Future Directions

- TUI kanban board via `ctx.ui.custom()` with keyboard navigation.
- Richer capability matching hints surfaced in spawn/edit tools.
- Result summarization to compress task results for context passing.

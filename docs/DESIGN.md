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

### 3. Autonomous work is a claim/done loop
A teammate polls the daemon for a task sitting `ready` in an agent state, claims
it (a lease), sends the daemon-assembled prompt to its own Pi agent, and on
completion marks it done — the **daemon** advances the task; workers never move
tasks (see the daemon's docs/WORK-MODEL.md). If it can't proceed it uses the
`return_task` tool (back to `ready` + comment) instead of a magic output string.
Rework needs no special path: a human moves the task back, and the teammate
rediscovers it on the next poll like any new work — comments included.

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
returns to autonomous. Because the permission system's fail-closed bash wrapper
floor clamps even yolo allows back to `ask` (`timeout`/`nohup`/`sudo`/... wrapped
commands), the teammate also registers a `ppt-autonomous` authorizer chain link
that answers those asks — allow while autonomous, defer while pairing — with an
audit entry per auto-allow in the permission review log.

## Interaction Model

### Teammate work loop
```
1. Poll   GET /api/agents/next-work        → a ready agent-state task (or { dismiss })
2. Claim  POST /api/agents/claim/:id       → lease + state-persona prompt
3. Execute (send the prompt to the Pi agent)
4. Done   POST /api/agents/done/:id        → daemon advances state, stores result
   or:    POST /api/agents/return/:id      → blocked: back to ready + comment
5. Fresh session (queue /ppt-fresh-session → ctx.newSession()) — the new
   extension instance re-registers and repeats (or shuts down if dismissed)
```

Each work item runs in a fresh Pi session: after done/return the loop queues
the `ppt-fresh-session` command (session control only exists on command
contexts), which calls `ctx.newSession()`. Pi tears the old instance down and
re-runs `session_start`, so the teammate re-registers under the same identity
and polls again with an empty context — no bleed between tasks, enforced by
construction. A scheduled poll remains as a safety net in case the reset
fails.

### Permission toggling
| Mode | yoloMode | Authorizer link | Behavior |
|------|----------|-----------------|----------|
| Autonomous (working) | `true` | allows asks | No prompts, full freedom (including wrapper-floored asks) |
| Pairing (human hopped in) | `false` | defers | Normal permission rules |

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

# Design

## Philosophy

- **Simplicity first** — Minimal dependencies, clear module boundaries, no unnecessary abstraction.
- **Type safety** — Strict TypeScript with no `any` types. Shared interfaces ensure consistency across modules.
- **Testability** — Hono's `app.request()` enables fast integration tests without network I/O.
- **Documentation as code** — Every module, file, and public API is documented. Docs stay in sync with implementation.

## Principles

1. **One responsibility per file** — Each file has a single, clearly stated purpose in its header comment.
2. **Explicit over implicit** — Deno permissions are declared explicitly in task definitions. Dependencies are pinned in the import map.
3. **Layered architecture** — daemon handles HTTP, shared provides types, CLI consumes the API. No circular dependencies.
4. **Web Standards** — Use native `Request`/`Response`, `fetch`, and other Web APIs rather than Node.js-specific abstractions.

## Change Log

Design deviations from the original pi-pizza-team implementation. Agents or docs referencing the older patterns should follow the updated approach below.

### Leader Directives: one queue of asks to the leader (2026-07-11)

The daemon needs to ask the leader to act on agents out-of-band. This started as
two separate channels — `spawn_requests` ("create an agent") and `agent_commands`
("reset an agent") — which the leader had to poll separately. They're the same
thing: **an ask to the leader to do something about an agent.** They were
consolidated into a single per-host resource:

```
GET  /api/hosts/:hostId/leader/directives      # the leader's to-do queue (one poll)
POST /api/hosts/:hostId/leader/directives      # { action, memberId?, params? }
PUT  /api/hosts/:hostId/leader/directives/:id  # { status }  (mark done)
```

A directive has an `action` (`spawn`, `reset-session`, ...), optional `memberId`
(for actions on an existing agent), `params` (e.g. spawn `name`/`cwd`/`storyId`),
and `status`. Two principles hold:

1. **The daemon communicates intent, not mechanism.** It knows nothing about
   tmux, keystrokes, or `/new`. The **leader** polls its host's directives and
   realizes each one (`spawn` → tmux window; `reset-session` → send `/new`).
2. **The daemon stores opaque harness metadata.** `Member.metadata` is a bag
   supplied at registration that the daemon relays verbatim and never
   interprets. The leader puts its tmux window/session there at spawn time (via
   `--ppt-tmux-window/--ppt-tmux-session`); directives targeting a member carry
   that metadata back so the leader knows where to deliver. This replaced the
   tmux-specific `Member.tmuxWindow`, keeping the daemon harness-agnostic.

When the assistant conversation is cleared (`DELETE /api/assistant/messages`),
the daemon enqueues a `reset-session` directive for the assistant so its in-agent
context is dropped, not just the stored messages.

**Rationale**: One concept ("a directive"), one queue, one poll — new asks are
just new actions, not new endpoints. Keeping mechanism in the harness means the
same channel scales to any agent and any harness; the daemon stays a coordinator
that never reaches into how agents are run.

### Assistant: Queue → Chat Conversation (2026-07-11)

The assistant was a **queue**: each enqueued prompt produced a single result,
rendered as independent prompt/result cards. That doesn't match how people
actually work with an assistant — it's a conversation.

It is now a **chat**: an ordered list of `user`/`assistant` messages
(`assistant_messages` table). Sending a user message (`POST /api/assistant/messages`)
also creates a `pending` assistant message — the *turn* to be answered. The
assistant agent polls that turn (`GET /api/assistant/next`, unchanged `{id, prompt}`
shape where `prompt` is the most recent user message), claims it (-> `processing`),
runs it, and completes it (-> `done`/`failed`, filling the message content).

The UI (`AssistantPage`) renders iMessage-style bubbles — you on the right,
assistant on the left — with a typing indicator for pending/processing turns.

**Rationale**: The persistent assistant Pi process already retains conversation
context across turns, so the queue framing was only a UI/data-model limitation.
Modeling the data as a conversation makes the UI natural and keeps the agent's
claim/complete loop essentially unchanged (only endpoint paths moved from
`/api/assistant/queue/*` to `/api/assistant/messages/*`).

### Capability-Based Work Matching (2026-07-11)

Work matching used to be a special case: an agent had a `cwd`, a story had a
`dir`, and a task was only handed out if the two matched exactly. Skills/tools
were not modeled at all.

This has been generalized into a single, uniform capability model:

- An **agent** advertises a `capabilities` map (`Record<string, string | null>`).
- A **story** declares a `requirements` map of the same shape.
- Matching rule: for each `(name, requiredValue)` in the story's requirements,
  the agent must have `name` in its capabilities, and if `requiredValue` is
  non-null the agent's value must equal it exactly.

The working directory is **not** a special case — it is simply the well-known
`directory` capability (constant `DIRECTORY_CAP`) whose required value is matched
exactly. Directory values are normalized (trailing slash stripped, leading `~`
expanded) at write time so the matcher stays a dumb exact-string comparison.

| Concept | Old | New |
|---------|-----|-----|
| Agent working dir | `Member.cwd: string` | `capabilities.directory` (well-known key) |
| Story dir affinity | `Story.dir?: string` | `requirements.directory` |
| Skills / tools | (not modeled) | `requirements[name] = null` (presence-only) |
| Match logic | special-cased dir equality | uniform `meetsRequirements()` |

**Clean break**: there are no `dir`/`cwd` compatibility aliases. Stories use
`requirements` and agents register `capabilities` directly; the `directory` key
is the only place a working directory appears.

**Rationale**: One matcher, one mental model. "Run in this directory" and
"needs Python" are the same kind of constraint, so they use the same mechanism.

### Story Pause + Agent Work Modes (2026-07-11)

Two orthogonal knobs were added on top of capability matching:

- **`Story.paused`** — a *temporal* gate. When true, the story's tasks are never
  handed out, regardless of capabilities. It answers "not now", separate from
  the capability question of "can you".
- **`Member.workMode`** — how an agent selects work:
  - `eager-helper` (default): any story whose requirements it satisfies.
  - `assigned-story` (+ `assignedStoryId`): only its bound story; when that
    story's tasks are exhausted, `/api/agents/next-work` archives the story and
    returns `{ task: null, dismiss: true }`, and the agent shuts itself down.

There is deliberately no `working-directory` work mode: today's directory-scoped
behavior is just `eager-helper` plus a `directory` requirement on the story.

**Rationale**: Placement (which directory / what skills) belongs to the story's
requirements; lifecycle (work everything vs. one story then leave) belongs to
the agent's mode; and availability (pause) is a separate temporal switch.
Keeping the three concerns independent avoids overloading any one field.

### Recently Used Capabilities (2026-07-11)

The daemon remembers capabilities it has seen in `config.recentCapabilities`, a
map of **capability name → known values** (most-recent-first, deduped, capped at
50 values per key). Presence-only capabilities (e.g. `design`) map to an empty
array so the key itself is still remembered.

It is populated automatically:
- When a story is created/updated, its `requirements` are recorded.
- When an agent registers, its `capabilities` are recorded.

And editable explicitly via `GET/POST/DELETE /api/capabilities`. The `directory`
value is normalized on the way in so it matches agent registrations.

This **replaces the former `teammates.favoriteDirectories` / per-host
`favoriteDirectories`** config: recently used working directories are now just
the `directory` capability's values. Register and `/api/hosts/:hostId` return
them as `directories`, and the UI's directory picker reads them from
`/api/capabilities`.

**Rationale**: This drives autocomplete for both the capability *key* and its
*values* when authoring story requirements or spawning agents — the map shape
(name → values) mirrors the capability model itself. It lives in `config.json`
(not the SQLite index) because it is durable, human-editable team configuration,
and `Store.persistConfig()` writes the whole config losslessly.

### Messages → Comments (2026-06-05)

The original design used "messages" as a real-time communication channel between lead and teammates (`/api/tasks/:id/message`, `messages.jsonl`). This has been renamed to **comments** throughout:

- API routes: `/api/tasks/:id/comment`, `/api/tasks/:id/comments`, `/api/agents/comments/:taskId`
- On-disk storage: `comments.jsonl` (was `messages.jsonl`)
- SQLite tables: `comments`, `comments_loaded` (were `messages`, `messages_loaded`)
- Types: `Comment`, `CommentAttachment` (were `Message`, `MessageAttachment`)

**Rationale**: Comments are task-level annotations, not a real-time chat channel. Agents load them once when starting work (to see lead feedback or rework instructions), not by continuous polling.

### Agent Lifecycle: Simplified Claim/Release (2026-06-11)

The multi-transition ownership model (2026-06-05) was further simplified. Agents no longer call transition explicitly — the daemon handles all state management.

| Previous Pattern | Current Pattern |
|-----------------|----------------|
| `POST /api/agents/claim/:taskId` — assigns ownership only, no state change | `POST /api/agents/claim/:taskId` — assigns ownership AND transitions to working state |
| `POST /api/agents/transition/:taskId` — agent explicitly advances state | Removed — daemon advances state on claim and release |
| `POST /api/agents/release/:taskId` — agent parks task when blocked | `POST /api/agents/release/:taskId` — advances to next state, stores result, releases |

**Agent loop**:
```
1. Poll next-work → get unclaimed task with teammate transitions
2. Claim → daemon transitions to working state, returns task details + instructions
3. Do the work
4. Release (with result) → daemon advances to next state, releases ownership
5. Repeat
```

**Rationale**: Agents shouldn't need to understand workflow topology. The daemon knows the workflow graph and makes the correct transitions. This simplifies agent implementations to a pure claim/release loop and eliminates an entire class of bugs where agents call invalid transitions.

### Workflow Required on Story Creation (2026-06-11)

Stories no longer get a default workflow. The `workflow` field is required when creating a story via the API. The UI provides a workflow selector (toggle buttons) in the create story dialog.

**Rationale**: Implicit defaults led to confusion when multiple workflows existed. Making it explicit ensures the creator consciously chooses the right workflow for their story.

### Task Distribution: Workflow-Aware (2026-06-11)

`getNextAvailableTask` (used by `/api/next-task`) no longer only returns tasks in the initial state. It now finds any unassigned task that has a valid `teammate` or `any` transition from its current state.

Similarly, `/api/tasks/:taskId/claim` no longer hardcodes `in_progress` — it finds the first valid teammate transition from the task's current state.

**Rationale**: Custom workflows (e.g., doc-writing: idea→outline→write→edit→publish) have teammate transitions at various points, not just from the initial state.

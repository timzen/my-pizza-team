# Design

## Philosophy

- **Simplicity first** — Minimal dependencies, clear module boundaries, no unnecessary abstraction.
- **Type safety** — Strict TypeScript with no `any` types. Shared interfaces ensure consistency across modules.
- **Testability** — Hono's `app.request()` enables fast integration tests without network I/O.
- **Documentation as code** — Every module, file, and public API is documented. Docs describe the current state, not a history of changes.

## Principles

1. **One responsibility per file** — Each file has a single, clearly stated purpose in its header comment.
2. **Explicit over implicit** — Deno permissions are declared explicitly in task definitions. Dependencies are pinned in the import map.
3. **Layered architecture** — the daemon handles HTTP, `shared/` provides types, the CLI consumes the API. No circular dependencies.
4. **Web Standards** — Use native `Request`/`Response`, `fetch`, and other Web APIs rather than Node.js-specific abstractions.
5. **The daemon coordinates; harnesses execute** — The daemon owns all state and expresses *intent*. It never reaches into *how* agents run (tmux, keystrokes, processes). Harnesses (Pi, etc.) realize intent.

---

## Work Matching: Capabilities & Requirements

Which agent works which task is decided by a single, uniform capability model.

- An **agent** advertises a `capabilities` map: `Record<string, string | null>`.
- A **story** declares a `requirements` map of the same shape.
- **Match rule**: for each `(name, requiredValue)` in the story's requirements, the
  agent must have `name` in its capabilities; if `requiredValue` is non-null the
  agent's value must equal it exactly. `null` means "must have it, any value"
  (presence-only, e.g. a skill like `python`).

The working directory is **not** special-cased: it is the well-known `directory`
capability (constant `DIRECTORY_CAP`). Directory values are normalized (trailing
slash stripped, leading `~` expanded) at write time, so the matcher itself stays a
dumb exact-string comparison.

There are no directory/skill aliases: stories use `requirements`, agents register
`capabilities`, and `directory` is the only place a working directory appears.

*Why:* one matcher, one mental model. "Run in this directory" and "needs Python"
are the same kind of constraint, so they use the same mechanism.

## Work Modes & Pause

Three independent knobs sit on top of capability matching:

- **`Member.workMode`** — how an agent selects work:
  - `eager-helper` (default): any ready story whose requirements it satisfies.
  - `assigned-story` (+ `assignedStoryId`): only its bound story. When that story's
    tasks are exhausted, `/api/agents/next-work` archives the story and returns
    `{ task: null, dismiss: true }`, and the agent shuts itself down.
- **`Story.paused`** — a *temporal* gate: when true, the story's tasks are never
  handed out, regardless of capabilities ("not now" vs. "can you").

There is deliberately no `working-directory` work mode — that behavior is just
`eager-helper` plus a `directory` requirement on the story.

*Why:* placement (directory / skills) belongs to the story's requirements;
lifecycle (work everything vs. one story then leave) belongs to the agent's mode;
availability (pause) is a separate temporal switch. Keeping the three concerns
independent avoids overloading any one field.

## Recently Used Capabilities

`config.recentCapabilities` is a map of **capability name → known values**
(most-recent-first, deduped, capped at 50 values per key). Presence-only
capabilities map to an empty array so the key itself is remembered.

It is populated automatically when a story is created/updated (from its
`requirements`) and when an agent registers (from its `capabilities`), and edited
explicitly via `GET/POST/DELETE /api/capabilities`. The `directory` value is
normalized on the way in.

Recently used working directories are simply the `directory` capability's values —
there is no separate "favorite directories" config. Registration and
`/api/hosts/:hostId` expose them as `directories`, and the UI's directory picker
reads them from `/api/capabilities`.

*Why:* it drives autocomplete for both the capability *key* and its *values* when
authoring requirements or spawning agents — the `name → values` shape mirrors the
capability model. It lives in `config.json` (durable, human-editable), written
losslessly by `Store.persistConfig()`.

---

## Agent Lifecycle: Claim / Release

Agents run a pure claim/release loop; the daemon owns all workflow state.

```
1. Poll  GET  /api/agents/next-work   → an unclaimed task with a teammate/any transition
2. Claim POST /api/agents/claim/:id   → assigns ownership AND transitions to the working state
3. Do the work
4. Release POST /api/agents/release/:id (with result) → advances to the next state, releases
5. Repeat
```

Agents never call an explicit "transition" endpoint and never need to understand
workflow topology — the daemon knows the graph and makes the correct transitions.
This keeps agent implementations trivial and eliminates invalid-transition bugs.

Task distribution is workflow-aware: `next-work` and claim return/act on the first
unassigned task that has a valid `teammate`/`any` transition from its *current*
state (not only the initial state), so custom workflows work at any point in the
chain.

## Workflows

Workflows live as directories under `workflows/` (`workflow.json` + per-state
instruction markdown). A story must name its `workflow` at creation time — there is
no implicit default selection — and the UI offers a workflow picker. When no
workflows exist on disk, the built-in `DEFAULT_CONFIG.workflows` is used.

*Why:* implicit defaults caused confusion once multiple workflows existed; making
the choice explicit ensures the creator picks the right one.

## Comments

Lead ↔ teammate communication is **task-level comments**, not a real-time channel:
`/api/tasks/:id/comment(s)` and `/api/agents/comments/:taskId`, stored append-only
in `comments.jsonl` per task. Agents load comments when they start work (to see
feedback or rework instructions), rather than polling a chat stream.

## Assistant: a Chat Conversation

The assistant is a conversation, not a queue. `assistant_messages` is an ordered
list of `user`/`assistant` messages. Sending a user message
(`POST /api/assistant/messages`) also creates a `pending` assistant message — the
*turn* to answer. The assistant agent polls that turn (`GET /api/assistant/next`,
shape `{ id, prompt }` where `prompt` is the latest user message), claims it
(→ `processing`), runs it, and completes it (→ `done`/`failed`, filling content).
The UI renders iMessage-style bubbles with a typing indicator for in-flight turns.

*Why:* the persistent assistant Pi process already retains conversation context
across turns, so modeling the data as a conversation (rather than independent
prompt/result items) is what makes the UI natural; the agent's claim/complete loop
is unchanged.

## Leader Directives

The daemon asks a leader to act on agents out-of-band through one per-host queue —
"an ask to the leader to do something about an agent":

```
GET  /api/hosts/:hostId/leader/directives      # the leader's to-do queue (one poll)
POST /api/hosts/:hostId/leader/directives      # { action, memberId?, params? }
PUT  /api/hosts/:hostId/leader/directives/:id  # { status }  (mark done)
```

A directive has an `action` (`spawn`, `reset-session`, …), an optional `memberId`
(for actions on an existing agent), `params` (e.g. spawn `name`/`cwd`/`storyId`),
and `status`. Two rules hold:

1. **The daemon communicates intent, not mechanism.** It knows nothing about tmux,
   keystrokes, or `/new`. The leader polls its host's directives and realizes each
   (`spawn` → tmux window; `reset-session` → send `/new`).
2. **The daemon stores opaque harness metadata.** `Member.metadata` is a bag
   supplied at registration that the daemon relays verbatim and never interprets.
   The leader records its tmux window/session there at spawn time; directives
   targeting a member carry that metadata back so the leader knows where to
   deliver.

Clearing the assistant conversation (`DELETE /api/assistant/messages`) enqueues a
`reset-session` directive for the assistant, so its in-agent context is dropped —
not just the stored messages.

*Why:* one concept, one queue, one poll — new asks are new *actions*, not new
endpoints. Keeping mechanism in the harness lets the same channel scale to any
agent and any harness while the daemon stays a coordinator.

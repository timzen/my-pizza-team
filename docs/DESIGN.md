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

## Task Ordering: the Story Owns It

A task has three independent concerns: its **id** (a stable, opaque key like
`auth-3` — the number is a creation counter, not a position), its **name**
(`title`), and its **order** within the story. Order is owned by the story as
`taskOrder`, an array of task IDs in `story.json`. `getTasksForStory` reconciles
that array against the tasks actually on disk: listed tasks first, then any
orphan (not-yet-listed) tasks appended by creation `seq`, with dangling ids
ignored. Reordering rewrites just that one array.

Task directories are named by the **task id only** (`tasks/auth-3/`). The folder
name is pure identity: it never encodes order, and it never drifts when the
title changes. On load, `seq` is derived from the id and `slug` from the current
title — so directory browsing shows *creation* identity, while execution order
lives entirely in `taskOrder`.

*Why:* ordering is a property of the collection, not of each task. Keeping it in
one array (rather than a per-task field, a directory-name prefix, or a linked
list) means a reorder is a single-file write — atomic, easy to hand-edit, and
friendly to git merges — and it never forces task IDs, titles, or directories
(where comments/attachments live) to change. Reconcile-on-load makes the system
tolerant of manual edits to `story.json` or the tasks directory.

## The Daemon Owns the Prompt

When an agent claims a task, the claim response returns a `prompt`: the
complete, ready-to-use message (Story → Task → prior-task context → lead
comments → state guidance → transition instructions for leaving the previous
state and entering the working state), assembled by
`buildTaskPrompt` in the daemon. The response otherwise carries only minimal
structured `task` metadata (`id`/`storyId`/`status`) for harness bookkeeping.
Harnesses (pi-pizza-team, mpt-mcp-server, …) deliver the prompt verbatim rather
than re-assembling their own.

*Why:* the prompt is mostly workflow knowledge, which the daemon already owns
(stories, tasks, states, instruction files, exit criteria). Assembling it in
each harness caused drift and duplication (e.g. an entered state's instructions
rendered twice). Centralizing it gives one canonical, testable prompt that is
identical across harnesses; a wording/order change is a single edit. We also
don't return the raw ingredients (story/stateContext/instructions) separately —
they'd just duplicate what's already in the prompt. Session- or delivery-specific
framing (how to send it, reminders that only make sense for a persistent
conversation) is intentionally *not* baked in — that is the only thing a harness
may add, and today none is needed.

Because state instruction files are user-authored but embedded verbatim into the
prompt, we defend the prompt's structure two ways. The prompt builder
**normalizes** authored headings (fence-aware) so they nest under its own `##`
sections — the durable guarantee, since it can't be "gotten wrong" by an author.
And on save the daemon **lints** instruction files (`workflow-lint.ts`):
unbalanced code fences are hard errors (an unclosed fence would swallow the rest
of the prompt), while shallow headings and stray `---` rules are warnings. The
normalizer is the safety net; the linter is the authoring nudge.

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

## Assistant chat model (turns, not message pairs)

The assistant is a **real chat**, not a request/response form. Two rules make it feel like iMessage/WhatsApp:

1. **Messages are append-only; replies come from turns.** Sending a user message just appends it (`sent`). It does **not** create a paired assistant placeholder. Replies are produced by a *response turn* — the job of answering the batch of unanswered user messages. The agent polls a turn (`GET /api/assistant/next`), claims it (`.../claim`, which flips the coalesced user messages to `read` — the read receipt), streams any number of chat bubbles via `send_message` (`.../say`), then closes it (`.../complete`).

   *Why:* the old 1:1 "user message → one assistant placeholder" pairing hard-wired one bubble per message and blocked both batched assistant replies and multi-message user input. Decoupling messages from turns lets the user send N and the assistant send M.

2. **One turn at a time; the composer locks while it runs.** At most one turn is `processing`; `GET /api/assistant/messages` exposes it as `activeTurn`, which drives the typing indicator and disables the composer. Because the user can't send mid-turn, there is no message enqueue or ordering to reason about; whatever is unanswered when a turn is claimed is coalesced into that one turn's prompt. A stuck-turn timeout (`assistantTurnTimeoutSeconds`, default 300s) fails an abandoned turn so the composer can't lock forever.

**Pre-claim debounce: don't answer mid-thought.** Before a turn is claimed the daemon waits for the user to go quiet for `assistantTurnDebounceSeconds` (default 5s) — measured from the newest unanswered message *and* the last typing ping. The composer `POST`s `/api/assistant/typing` on keystroke (throttled ~1.5s) **and** on a 2s heartbeat whenever it holds an unsent draft — the heartbeat matters because keystroke pings go silent when the user pauses with half-written text (thinking, re-reading, about to backspace), and a pause longer than the debounce would otherwise let the assistant claim the turn. An unsent draft therefore means "I'm not done yet" and holds the turn indefinitely. The window keys off actual composing activity, not just send time, which is what makes it feel like "answer once I've clearly stopped." Set the config to `0` to disable (e.g. in tests). *Limitation:* with an **empty** composer, silence longer than the debounce is indistinguishable from "done," so a >debounce pause before starting the next message will let the current batch claim.

**Chat behavior is system-level, not per-persona.** The vended system prompt is always `ASSISTANT_CHAT_FRAMING` (the batching rules + the `send_message` contract) followed by the persona body — or `DEFAULT_ASSISTANT_PERSONA` when none is chosen. So every persona inherits the chat/batching behavior and none has to restate it. `send_message` content is the only thing shown to the user; `complete`'s `result` is just a fallback bubble used if a turn produced none.

*Why:* keeping the "chat is a chat" framing in one daemon-owned constant means personas are about *voice/role*, not delivery mechanics, and the behavior stays consistent across every persona and harness.

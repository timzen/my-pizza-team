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
6. **Workers never move tasks** — Teammates execute work; the daemon executes flow (admission + advance); humans/the leader make judgment moves. See [WORK-MODEL.md](WORK-MODEL.md) for the full spec (states, substatus, CONWIP).

---

## The WorkItem: the Unit of Agent Execution

The WorkItem queue is the single, legible record of what **will** happen (`READY`),
**is** happening (`IN_PROGRESS`, and `MORIBUND` when an agent goes quiet), and
**did** happen (`COMPLETE`/`FAILED` in the Inbox; `CANCELED` in the audit trail).
Every stuck state has exactly one recovery action: cancel a READY item, force-fail
a MORIBUND one, re-enqueue a failed task.

A WorkItem is deliberately **dumb and terminal-only**: it carries just identity,
a `ref` (the backing WorkDef's id), a directory (affinity), a state, read flag,
and timestamps. It never moves backward — retrying is a *new* item. All rich
detail (goal, comments, outcome) lives on the **ref** (the WorkDef), never on the item.

The WorkItem **drives** its work (inverted from a board-first model): the daemon
reacts to a terminal state. `COMPLETE` advances a board task to its next workflow
state (freeing the CONWIP token when it reaches `done`); `FAILED`/`CANCELED`
leaves the work in place with no active item — "stuck" until a human re-enqueues,
moves, or edits it. CONWIP admission still governs which task per story is active;
landing a task in an agent state is what enqueues its READY item.

*Why:* one queue, one lifecycle, terminal-only transitions. It collapses several
ad-hoc mechanisms (capability matching, assigned-story scoping, the `return`
bundle, task substatus) into one legible object, and makes "what happened / how do
I get it back on track" obvious. See docs/WORKDEF_UNIFICATION.md.

## Work Matching: Directory Affinity

Which agent works which item is decided by a soft **directory bias**, never a hard
gate. There is no capability/`requirements` model. Each agent has a working
`directory` (its pi cwd); a story/WorkDef has an optional `directory` copied onto
its WorkItem. `getNextWorkItem` picks the oldest `READY` item by priority tier:

1. item `directory` == agent `directory` (my repo's work)
2. item has no directory (anyone's)
3. item `directory` != agent `directory` **and no online agent has that dir**
   (nobody's coming for it — the agent cds and may fail if it can't reach it)

Tier 3 is presence-based, not timed: if an online agent with the matching
directory exists, the item waits for it. `Story.paused` is an independent temporal
gate (its READY items are never offered while paused).

*Why:* the only signal that ever mattered was "where the work happens." Making it a
*bias* (not a filter) retires the path-string bug class that killed directory
matching before — a false-negative match merely loses the preference; it never
strands work.

## WorkDefs & Parents: One Model for All Work

Every unit of work is a **WorkDef**: purely *authored* content (Goal / Acceptance
Criteria / Additional Context + `directory`, `contextRefs`), stored as
markdown+frontmatter under `tasks/<id>/` with a per-def `comments.jsonl`. A
WorkDef names its **parent** — the *enqueuer* that decides when it emits
WorkItems — and its type is derived from that parent:

- **parent = a Story** → a **Board** task: the story's workflow admits it and
  advances it (status lives on the story as `tasks: [{id, status}]`).
- **parent = a Schedule** → **Scheduled**: a cron parent (`schedules/<id>.json`)
  fires a WorkItem for each child on its 5-field cron.
- **no parent** → **Solitary**: a one-shot, enqueued manually.

All three funnel through one `enqueueFor(workDefId)`; a teammate works "the next
thing" without caring where it came from.

*Why:* the WorkItem is already the universal execution unit, so the thing that
*defines* work should be universal too. Splitting board tasks from standalone
work was redundant. Keeping the WorkDef authored-only (all mutable state — status
on the story, cron/lastEnqueuedAt on the schedule — lives off the markdown) means
the daemon never rewrites a `workdef.md` except on an explicit edit. See
[WORKDEF_UNIFICATION.md](WORKDEF_UNIFICATION.md).

## Reaping: MORIBUND, not a Guess

A claim is a lease kept alive by heartbeats. When the reaper sees a silent agent
it does **not** declare failure or hand the work to someone else — it moves the
agent's `IN_PROGRESS` items to `MORIBUND` and keeps the lease. The agent
reconnecting restores them to `IN_PROGRESS`; a human who's sure it's gone
force-fails them (optionally re-enqueuing).

*Why:* a heartbeat can false-positive (a hung-but-alive agent mid-commit).
Auto-re-enqueuing on a guess risks two agents doing the same work; MORIBUND makes
reaping honest and puts the recovery decision with the human.

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
(`title`), and its **order** within the story. The story owns both order *and*
status in one place: `tasks: [{ id, status }]` in `stories/<id>.json`. On load,
the daemon reconciles that list against the board WorkDefs actually on disk
(those whose `parent` is this story): listed entries first, then any orphan
(not-yet-listed) WorkDef appended as `todo`, with dangling ids ignored.

A WorkDef directory is named by the **id only** (`tasks/auth-3/`) — pure
identity: it never encodes order and never drifts when the title changes.

*Why:* ordering and position are properties of the collection, not of each task.
Keeping them in one list (rather than parallel arrays that could drift, a
per-task field, or a directory-name prefix) means a reorder or advance is a
single-file write — atomic, hand-editable, git-friendly — and never forces ids,
titles, or the `tasks/<id>/` dirs (where comments/attachments live) to change.
Reconcile-on-load tolerates manual edits.

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

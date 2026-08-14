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

## Task Templates: a Mold, not Work

A **Template** is a reusable mold for a Solitary task — "investigate a ticket",
"research a package", and other flavors of one-shot work you author again and
again. It carries the same *authored* fields as a WorkDef (title / goal /
acceptance criteria / additional context / directory / contextRefs) but is
deliberately **not** a WorkDef: it has no parent, no runtime state, no WorkItem,
and no run thread. Creating a task "from" a template copies its fields onto a new
Solitary WorkDef; the template itself is never executed and never enters the
queue. It lives under `templates/<id>/template.md` (reusing the WorkDef markdown
serializer) with files as the source of truth — no SQLite index, like Schedules
and Thoughts.

*Why:* a template is prompt/authoring convenience, not a unit of work, so folding
it into the WorkDef model (e.g. a fourth parent kind or a "don't enqueue" flag)
would leak a non-work concept into the queue's core — the very listing, matching,
and lifecycle machinery a template must stay out of. Keeping it a separate,
trivially-CRUDed resource means the WorkItem queue never has to know templates
exist, while the create form gets a single pre-fill path (`?template=<id>`) that
is just "seed these fields." It reuses the WorkDef file format because a template
*is* structurally a parent-less WorkDef — sharing the serializer avoids drift
without coupling the two concepts.

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

The assistant is a conversation, not a queue — and the conversation lives in the
assistant's **Pi session**. The daemon is a *mirror* of it: `assistant_messages`
is an ordered list of `user`/`assistant`/`system` messages grouped into
`assistant_sessions`, and the harness keeps the two in sync in both directions.
The UI renders iMessage-style bubbles with real delivery receipts and a thinking
indicator. See "Assistant chat model" below and docs/ASSISTANT_CHAT_V2.md.

*Why:* the assistant Pi process already holds the real conversation state (its
context window, its session file). Making the daemon the mirror rather than the
master is what lets the user chat from the web UI **or** the agent's terminal,
interrupt mid-answer, and resume an old conversation with its context intact.

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
3. **The daemon owns identity, so it assigns spawn names.** A `spawn` directive
   always carries a `params.name` chosen by the daemon — a generated
   adjective-noun for a teammate, or the reserved singleton name `assistant`
   for an assistant spawn (`reason: "assistant"`). The harness must not invent
   or hardcode names: it names the tmux window and `--ppt-name` after
   `params.name`, keeping the window, the registered member, and the UI label
   consistent. Because the assistant is a singleton (the chat and
   `reset-session` routing are keyed on the `assistant` name), a duplicate
   assistant spawn — one already online, or a pending assistant spawn — is
   coalesced onto the existing request instead of emitting a second directive.

Clearing the assistant conversation (`DELETE /api/assistant/messages`) enqueues a
`reset-session` directive for the assistant, so its in-agent context is dropped —
not just the stored messages.

*Why:* one concept, one queue, one poll — new asks are new *actions*, not new
endpoints. Keeping mechanism in the harness lets the same channel scale to any
agent and any harness while the daemon stays a coordinator.

## Assistant chat model (a mirror of the Pi session)

The assistant chat is a **real chatbot**, not a request/response form. One
inversion makes all of it work: **the Pi session is the conversation; the daemon
mirrors it.** (Full design + rationale: docs/ASSISTANT_CHAT_V2.md.)

1. **No turns. Sending never blocks.** `POST /api/assistant/messages` always
   succeeds and appends a `queued` message. The extension pulls queued messages
   (`GET /api/assistant/inbox`) and hands them to Pi with
   `sendUserMessage(..., { deliverAs: "steer" })` while a run is in flight.
   Interleaving a mid-answer message is therefore *Pi's* job, not the daemon's —
   which is why the composer no longer locks and the old pre-claim debounce,
   typing pings, and stuck-turn reaper are all gone.

   *Why:* the v1 turn machine (claim one turn, coalesce messages, lock the
   composer, debounce to avoid answering mid-thought) was a daemon-side
   re-implementation of something the harness already does correctly. Deleting it
   removed the 5s latency floor, the locked composer, and ~200 lines of timing
   heuristics.

2. **Receipts are real, and honest.** A user message moves `queued` (nobody has
   it yet) → `delivered` (handed to Pi; it may be waiting on the current tool
   batch) → `read` (a run that sees it has started). The UI shows ⧗ / ✓ / ✓✓.
   Because `delivered` is distinct from `read`, a mid-run message shows the wait
   instead of pretending it was seen.

3. **The agent just talks.** There is no `send_message` tool. The extension
   mirrors the agent's own assistant text into bubbles, splitting on blank lines
   (never inside a code fence or a list; runt paragraphs merge into a neighbour,
   except questions, which keep their own bubble). Intermediate prose — what it
   says *before* a tool call — mirrors immediately, so long answers arrive
   progressively.

   *Why:* routing every bubble through tool-call JSON made replies stilted, forced
   a 30-line framing prompt to explain the mechanism, and made the agent's tmux
   transcript a wall of `Send Message` calls instead of a conversation.

4. **Both surfaces are the same conversation.** Anything typed in the assistant's
   own terminal (`input` with `source: "interactive"`) is mirrored into the chat as
   a user message with `origin: "tui"`, marked with a terminal glyph in the UI.
   Walk from the browser to the tmux pane mid-conversation and nothing is lost.

5. **Thoughts are ephemeral.** Reasoning deltas stream to a capped in-memory ring
   buffer in the daemon (never persisted, never snapshotted) and are readable by
   clicking the `…`. It is a peek, not a record — a restart drops it, and that's
   the point.

6. **Nothing is destroyed; sessions are the unit of history.** "New chat" and a
   persona swap *end* the current session — writing
   `<teamDir>/assistant/sessions/<id>.md` (frontmatter + readable transcript) —
   and open a new one. Resuming reopens a session and asks the agent to
   `switchSession()` back to its recorded Pi session file, so in-agent context
   comes along. Sessions with no recorded file are still readable, just not
   restorable.

   *Why:* v1's "clear the conversation" was a destructive `DELETE` that also
   dropped the only copy of the transcript. Personas are about *who you're talking
   to*; changing that should start a new conversation, not burn the old one.

7. **Chat behavior is system-level, not per-persona.** The vended system prompt is
   always `ASSISTANT_CHAT_FRAMING` (now ~10 lines: be brief, blank lines separate
   bubbles, questions get their own paragraph, the user may interrupt) followed by
   the persona body — or `DEFAULT_ASSISTANT_PERSONA`. Personas stay about
   voice/role, never delivery mechanics.

8. **Session control is intent, realized in-process.** `new-session` and
   `resume-session` are leader-directive *actions*, but unlike every other
   directive they are polled by the target agent itself
   (`GET /api/agents/:id/directives`) and realized with Pi's `ctx.newSession()` /
   `ctx.switchSession()`. The daemon still only expresses intent; the mechanism
   just can't be tmux keystrokes, because "resume this exact session file" isn't
   expressible as `/new`.

# Design

Why my-pizza-team is shaped the way it is. [ARCHITECTURE.md](ARCHITECTURE.md) says
*what* is where; this document says *why*. Both describe the current state — where
either disagrees with the code, the code is right and the doc is a bug.

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
5. **The daemon coordinates; harnesses execute** — The daemon owns all state and expresses *intent*. What an agent does inside its own process (Pi sessions, slash commands, permission prompts) belongs to its harness. The one piece of mechanism the daemon owns is tmux — see "The Daemon Is the Supervisor".
6. **Workers never move tasks** — Teammates execute work; the daemon executes flow (admission + advance); humans/the leader make judgment moves. See "The Work Model".
7. **Fail loudly** — a missing piece must surface as an error that names its fix, never as a symptom (a teammate that never appears, a chat nobody answers). This one principle drives the version handshake, `mpt doctor`, failed-spawn reporting, and the permission-system warning.

---

## The Work Model

```
todo (implicit)  →  [ active states, ordered ]  →  done (implicit)

WorkflowConfig = { states: [ { name, type: "agent" | "manual" } ] }
```

- **`todo` / `done`** are implicit buckets present in every workflow and never
  declared. `todo` is the admission queue; `done` is terminal. An active state may
  not be named `todo` or `done`.
- **Agent state** — worked by teammates. Landing a task here enqueues a WorkItem.
- **Manual state** — worked by a human (or the leader). No WorkItem, no persona:
  moving the card onward *is* the completion (e.g. a review gate).

**Who moves tasks:**

| Actor | Powers |
|---|---|
| **Teammate** | Claim, complete, fail, comment. **Never moves tasks.** |
| **Daemon** | Two mechanical rules: **advance** (a COMPLETE WorkItem moves its task to the next state) and **admission** (below). |
| **Human / leader** | Move any task to any position (rework, skip, shelve). Entering an agent state cancels any active WorkItem and enqueues a fresh one — re-entry ≡ first entry. |

**Admission (CONWIP, WIP = 1 per story).** The next task (story order) is pulled
from `todo` into the first active state *only when the story has no task anywhere
in the active section.* One task in flight per story stops commits stacking up
while an earlier task awaits (or fails) review. Rework keeps the token: moving a
task backward never admits another. Admission runs after completion/advance,
judgment moves, task creation/deletion, story unpause, and daemon load. A judgment
move excludes the just-moved task from the admission it triggers — moving a task to
`todo` shelves it rather than bouncing it straight back in.

*Why:* when teammates owned both executing work *and* executing transitions, every
unhappy path was bespoke — rework required a teammate to rediscover a task it
thought was finished, and the transition decision hung off parsing the model's
final message. With workers never moving tasks, re-entering a state is
indistinguishable from entering it the first time, every path is the happy path,
and there is no transition matrix or per-edge permission to configure. The daemon
(not an LLM) executes both mechanical rules, so the happy path has no model in its
critical section.

Teammates are **generalists**: every teammate works every agent state, and the
state persona does the specializing. With WIP = 1 per story there is no
stage-level parallelism to exploit, and specialists would add a stall mode
("nobody works this state").

## The WorkItem: the Unit of Agent Execution

The WorkItem queue is the single, legible record of what **will** happen (`READY`),
**is** happening (`IN_PROGRESS`, and `MORIBUND` when an agent goes quiet), and
**did** happen (`COMPLETE`/`FAILED` in the Inbox; `CANCELED` in the audit trail).
Every stuck state has exactly one recovery action: cancel a READY item, force-fail
a MORIBUND one (optionally re-enqueuing), move or re-run a failed task.

A WorkItem is deliberately **dumb and terminal-only**: it carries identity, a
`ref` (the backing WorkDef's id), a directory (affinity), a state, a read flag,
and timestamps. It never moves backward — retrying is a *new* item. All rich
detail (goal, comments, outcome) lives on the **ref**, never on the item.

The WorkItem **drives** its work: the daemon reacts to a terminal state. `COMPLETE`
advances a board task to its next workflow state (freeing the CONWIP token when it
reaches `done`); `FAILED`/`CANCELED` leaves the work in place with no active item —
"stuck" until a human re-runs, moves, or edits it. The daemon posts no comment on a
state change: the agent writes its own completion or failure comment first.

*Why:* one queue, one lifecycle, terminal-only transitions. It replaces several
ad-hoc mechanisms (capability matching, assigned-story scoping, a `return` bundle,
task substatus) with one object, and makes "what happened / how do I get it back on
track" obvious.

## Work Matching: Directory Affinity

Which agent works which item is decided by a soft **directory bias**, never a hard
gate. There are no capabilities, skills, or requirements. Each agent registers a
working `directory` (its pi cwd); a WorkDef (or its story) has an optional
`directory` copied onto its WorkItem. `getNextWorkItem` picks the oldest eligible
`READY` item by tier:

1. item `directory` == agent `directory` (my repo's work)
2. item has no directory (anyone's)
3. item `directory` != agent `directory` **and no online agent has that dir**
   (nobody's coming for it — the agent cds there and fails the item if it can't)

Tier 3 is presence-based, not timed: if an online agent with the matching
directory exists, the item waits for it. `Story.paused` and unmet story
dependencies are independent gates (their items are never offered).

The claim prompt tells the agent to `cd` into the directory and **read that repo's
AGENTS.md** before starting, since Pi only auto-loads project context from its
startup cwd.

*Why:* the only matching signal that ever mattered was "where the work happens."
Making it a *bias* rather than a filter retires the path-string bug class
(symlinks, mounts, trailing slashes) — a false-negative match merely loses the
preference; it never strands work. Accepted trade-offs: two stories sharing one
directory can interleave commits (CONWIP is story-scoped), and any teammate can be
pointed anywhere the process user can write.

## WorkDefs & Parents: One Model for All Work

Every unit of work is a **WorkDef**: purely *authored* content (Goal / Acceptance
Criteria / Additional Context + `directory`, `contextRefs`), stored as
markdown+frontmatter under `tasks/<id>/` with its own `comments.jsonl` and
`attachments/`. A WorkDef names its **parent** — the *enqueuer* that decides when it
emits WorkItems — and its type is derived from that parent, never stored:

| Parent | Type | Emits a WorkItem when |
|---|---|---|
| a **Story** (`stories/<id>.json`) | Board | its workflow position enters an agent state (first entry or rework) |
| a **Schedule** (`schedules/<id>.json`) | Scheduled | the 5-field cron fires |
| a **Thought** (`thoughts/<id>.md`) | Triage | the triage sweep finds the note's text changed since its last analysis |
| none | Solitary | you press **Run** |

All three funnel through one `enqueueFor(workDefId)`; a teammate works "the next
thing" without caring where it came from.

**Invariant: `workdef.md` is authored content only.** All mutable runtime state
lives elsewhere — workflow status on the Story (`tasks: [{id, status}]`), cron and
`lastEnqueuedAt` on the Schedule — so the daemon never rewrites a `workdef.md`
except on an explicit edit. Frontmatter carries only structural metadata (title,
`parent`, directory, contextRefs, and `status: archived` when archived).

**One route family per concern.** WorkDef operations — get/update/delete, enqueue,
comments, attachments, token usage — live under `/api/work-defs/:id` for *every*
kind, board tasks included. Only story-parent operations with no WorkDef analog live
under `/api/tasks` and `/api/stories/:id/tasks` (create-in-story, reorder, move,
delete-from-story).

*Why:* the WorkItem is the universal execution unit, so the thing that *defines*
work should be universal too; a separate board-task type duplicated comments,
attachments, and routes for no gain. Each WorkItem is self-contained — story-level
context plus the WorkDef's own goal and criteria carry continuity, so there is no
"result" field or "previous task" context threaded between tasks.

## Auto Triage: a Note Is a Parent

A teammate reads each note you've changed and replies with an analysis of it. The
note is the parent that enqueues that work, so triage needed no new machinery: the
thread, attachments, usage, and the Inbox entry are a WorkDef's, and "whose turn is
it" is answered by the note itself.

- **The WorkDef is a container, not authored work.** `triage-<noteId>` is created
  lazily the first time a note is due, and holds nothing but a title and its parent.
  The instructions live **once**, in `triage.md` at the team root (absent = the
  built-in default), and the prompt is assembled at claim time from those plus the
  note's *current* text, its group name, the open stories, and any earlier analysis.
  Copying the note into `workdef.md` would mean rewriting an authored file on every
  edit, which "WorkDefs & Parents" forbids. The *WorkItem* title is resolved at
  enqueue ("Triage: <the note's first line>"), so the queue and Inbox read as the
  note rather than as `triage-th-1790…`.
- **Turns: you edit the note, the teammate comments.** A note is due when it is
  active, non-empty, has no run in flight, and its text has moved on since the
  version last handed over — which is stamped **at enqueue**, on the note (as a
  Schedule keeps `lastEnqueuedAt`). Stamping then, rather than when the analysis
  lands, is what makes an edit *during* a run survive: it lands after the stamp, so
  the next sweep sees it. It also means a **failed run counts as analyzed**, so a
  note that breaks triage doesn't cost a run every hour; **Triage now** retries it.
- **An hourly sweep, not a Schedule.** A Schedule enqueues one WorkDef; a sweep
  enqueues many, so it's a daemon timer beside the scheduler. It skips notes edited
  in the last few minutes (`quietMinutes`), so it never reads a half-written
  thought — they go in the next pass. On by default, and every non-archived,
  non-empty note is eligible, so the first sweep covers the whole board.
- **It runs like any other work.** In the leader's directory (the one place with
  project context; with no leader registered it has none, so any teammate may take
  it), at no special priority — the queue is oldest-first within directory tiers.
- **The note owns it.** Archiving a note archives its WorkDef and cancels a queued
  run; deleting one deletes the thread; restoring brings it back. The generic
  WorkDef verbs refuse a triage container (409 naming the note) so nothing can edit
  a thread out of step with what it's about; "Run" on one means Triage now.

**Proposals are structured comments; decisions are appended.** The analysis is a
comment in the note's triage thread carrying an `outcome` — `proposals`, `nothing`
("a reference note; nothing to create"), or `question` (it needs one thing from you
first) — plus, for `proposals`, the work itself: `task`, `story-task`, `story`, or
`schedule`, each with the fields that kind needs. Structured so accepting creates the
real thing without parsing prose, and posted through the teammate's `propose_work`
tool, which **validates** (the story exists, the cron parses, `proposals` carries at
least one) and hands back a fixable message rather than writing a broken line.

Your accept/reject is a `kind: "decision"` line **appended to the same
`comments.jsonl`**. So one append-only file holds the conversation *and* its history,
current state is a fold over it (a proposal no decision names is pending), and
`getCommentsForRef` simply filters decisions out — every existing reader is
unchanged. Decisions are **not comments and not turns**; only editing the note is a
turn.

- **Accepting creates; it never starts anything itself.** What happens next is
  whatever that kind of work does when you create it by hand: a `task` waits for
  **Run**, a `schedule` waits for its cron, and a story task enters its story's
  workflow — which, exactly as when you add a task to a story yourself, may admit it
  and queue it straight away. Triage-created work is not a special case of the board.
- **Rejecting is one click, no reason.** To steer the next analysis, edit the note.
  The next run's prompt lists earlier proposals and what you did with each, so a
  rejected idea isn't offered again.
- **Both directions are linked:** the decision names what it created, and that
  WorkDef's frontmatter carries `origin: {thought, proposal}`.
- **The badge is the latest analysis's outcome, not a count** — and nothing once
  every proposal in it has been decided.

**Notes stay clean; triage lives on its own page.** A note's view gains nothing at
all. Its whole triage footprint is a small badge on the card and list row, which
opens `/thoughts/:id/triage`: the note read-only on the left (with **Edit note** back
to it — `?note=` selects and centres it), the latest analysis and its pending
proposals on the right with **Accept / Edit / Reject**, and earlier rounds below.
**Edit** opens the proposal's fields in the same widgets the create forms use and
sends them as overrides, so one gesture covers "nearly right, but…". Every terminal
run is in the **Inbox** whatever its outcome — that's the notification, and the row
links to the triage page rather than the container WorkDef. Because the badge shows
an outcome rather than a count, and because notes are for thinking, nothing about
triage interrupts writing one.

*Why not a comment thread on notes?* It's the same thing built twice. A WorkDef
already has an append-only thread, attachments, a cost tally, and an Inbox row, and
"a note is an enqueuer" is exactly what a parent is.

*Why not a separate proposals file?* `comments.jsonl` is append-only, which reads
like a reason to put mutable state elsewhere — but a decision isn't a mutation, it's
the next event. Appending it keeps one file, one order, and one history.

## Task Templates: a Mold, not Work

A **Template** is a reusable mold for a Solitary task — "investigate a ticket",
"research a package". It carries the same authored fields as a WorkDef but is
deliberately **not** one: no parent, no runtime state, no WorkItem, no thread.
Creating a task "from" a template copies its fields onto a new Solitary WorkDef.
It lives at `templates/<id>/template.md`, reusing the WorkDef serializer, with files
as the source of truth (no SQLite index).

*Why:* a template is authoring convenience, not a unit of work. Folding it into the
WorkDef model (a fourth parent kind, a "don't enqueue" flag) would leak a non-work
concept into the listing, matching, and lifecycle machinery a template must stay
out of. Sharing the file format avoids drift without coupling the concepts.

## Task Ordering: the Story Owns It

A task has three independent concerns: its **id** (a stable key like `auth-3` —
the number is a creation counter, not a position), its **title**, and its
**order** within the story. The story owns order *and* status in one list:
`tasks: [{ id, status }]`. On load the daemon reconciles that list against the
board WorkDefs on disk: listed entries first, then any orphan appended as `todo`,
dangling ids ignored. A WorkDef directory is named by id only, so it never
encodes order and never drifts when the title changes.

*Why:* order and position are properties of the collection. One list means a
reorder or advance is a single-file write — atomic, hand-editable, git-friendly —
that never renames directories (where comments and attachments live).

## Reaping: MORIBUND, not a Guess

A claim is a lease kept alive by heartbeats. When the reaper sees a silent agent
it does **not** declare failure or hand the work to someone else — it moves the
agent's `IN_PROGRESS` items to `MORIBUND` and keeps the lease. The agent
reconnecting restores them; a human who's sure it's gone force-fails them
(optionally re-enqueuing). A daemon restart does the same to anything left
`IN_PROGRESS`, since a fresh daemon holds no live connections.

*Why:* a heartbeat can false-positive (a hung-but-alive agent mid-commit).
Auto-re-enqueuing on a guess risks two agents doing the same work; MORIBUND makes
reaping honest and puts the recovery decision with the human.

## Team Size: Declared, not Clicked

The team's size is a **number you declare** (`minTeammates`), not a button you
press per teammate. The daemon counts online pool teammates plus not-yet-realized
`spawn` directives and queues spawns for the shortfall — on the heartbeat tick
right after the reaper (so a lost teammate is replaced on the same tick), when the
number changes, and when a leader registers.

It is **one-directional**: the daemon spawns up to the floor but never dismisses
anyone. Ending a teammate stays a human act, so a reconciler can never kill work in
flight.

**The team starts when its leader does.** The pool waits for a leader even when
the daemon can open tmux windows itself. The daemon often runs as a login service;
without this, every login would start agents before anyone ran `mpt lead` — agents
nobody can chat with, reset, or expected. `mpt lead` is the "start the team" step.
A one-off spawn from the Spawn dialog is a human asking now, so it isn't held.

**Default: half of `maxTeammates`** (rounded down), *derived* while unset rather
than written to config, so raising the cap raises it too — until you declare a
size (0 included), which always wins. "Use default" clears the declaration.

*Why:* "spawn a teammate" was the wrong shape for the only question a user has —
*how big is my team?* A declared floor is idempotent, survives restarts (it's
config), self-heals after a crash, and lives in one place: the same
convergent-state reasoning as admission.

**One-off, directory-homed spawns stay available** alongside the floor. Pool
teammates start in the leader's directory; "put someone in *that* repo" is a
different question (affinity), so the Team tab keeps a Spawn dialog. Such a
teammate counts toward the floor. The leader is not part of the pool.

## Workflows

Workflows live as directories under `workflows/` (`workflow.json` + a persona
markdown file per agent state). A story must name its `workflow` at creation — the
UI offers a picker; there is no implicit selection. When no valid workflow exists on
disk, the built-in `DEFAULT_CONFIG.workflows` (`in_progress` → `review`) is used.
Files in an older transition-matrix shape are skipped rather than half-loaded.

*Why:* implicit defaults caused confusion once multiple workflows existed; making
the choice explicit ensures the creator picks the right one.

## The Daemon Owns the Prompt

When an agent claims a WorkItem, the response carries a `prompt` — the complete,
ready-to-use message assembled by `buildTaskPrompt` — and only minimal `workItem`
metadata (`{ id }`) for bookkeeping. Order: state persona (board work) → Story
(board work) → working-directory instruction → Task (Goal / Acceptance Criteria /
Additional Context) → Reference Context (attached context-library entries) →
comments from the team lead → completion guidance. There are no transition
instructions, because workers don't transition.

*Why:* the prompt is mostly workflow knowledge the daemon already owns. Assembling
it in each harness caused drift and duplication. One canonical, testable prompt is
identical across harnesses; a wording change is a single edit. Raw ingredients are
not returned separately — they'd duplicate the prompt. Only delivery-specific
framing may be added by a harness, and today none is.

Persona files are user-authored but embedded verbatim, so the prompt's structure
is defended twice: the builder **normalizes** authored headings (fence-aware) so
they nest under its `##` sections — the durable guarantee — and saving a persona
**lints** it (`workflow-lint.ts`): an unbalanced code fence is an error (it would
swallow the rest of the prompt); shallow headings and stray `---` are warnings.

## Comments

Lead ↔ teammate communication is **comments on the work** (the WorkDef), not a
real-time channel, stored append-only in `tasks/<id>/comments.jsonl`. Because they
live on the ref rather than the WorkItem, they persist across attempts: rework
arrives with the reviewer's feedback, and completion summaries land where the Inbox
links. Agents read and write them through `/api/agents/comments/:workItemId`
(resolved to the ref); the UI uses `/api/work-defs/:id/comment(s)`.

---

## One Protocol, One Version

The daemon and the Pi extension are one protocol shipped as one artifact. They
live in one repo, `deno.json` owns the version, `harnesses/pi/package.json` is
generated from it (`deno task sync-version`, enforced by `tests/version.test.ts`),
shared constants are generated into the extension (`deno task sync-shared`), and the
`mpt` binary **embeds the extension's source** and writes it out on `mpt setup`.

*Why:* when the two halves shipped separately, they drifted and nothing noticed —
an old extension kept running while streaming no transcript and recording no
usage, and a cross-cutting feature was a dozen commits across two repos released
in lockstep by hand.

**The version handshake** makes any remaining skew loud. `POST /api/agents/register`
carries `protocolVersion`, `harness`, and `harnessVersion`. The daemon **gates on
the protocol version only**: one it can't serve is refused with 409 and the fix
named, and the agent isn't registered at all rather than left half-working. Build
versions are *reported, never gated* — gating them would reject the whole team on
every patch release until people learned to ignore it — and surface as a Team-tab
row marker plus a banner that can restart the skewed agents. A missing
`protocolVersion` means a pre-handshake harness: accepted and flagged, so upgrading
the daemon first doesn't strand a running team.

**`mpt upgrade` moves both halves.** After replacing the binary it rewrites the
managed extension by invoking the **newly installed** binary (the hidden
`mpt write-extension-internal`) — the running process still carries the old
embedded copy. Pi loads a local package from its path without copying, so no
re-registration or `npm install` is needed (the extension has no `dependencies`;
its peers are supplied by Pi). Only an existing managed directory is refreshed: a
developer on a registered checkout, or someone who never ran setup, doesn't get a
managed install created behind their back. Running agents keep the old code until
their Pi restarts, which the handshake surfaces.

## Setup Is One Command

Before `mpt setup`, a working team took six unchecked steps (binary, Pi, extension,
permission system, tmux + trust + a leader, service), and a missing one showed up
later as a symptom. Now: `mpt setup`, then `mpt lead`; `mpt doctor` re-checks any
time.

- **`mpt setup` prints every change before making it**, is idempotent, and records a
  manifest so `--uninstall` undoes exactly what it did — without it, uninstall would
  have to guess which registrations were ours.
- **The managed extension lives at a stable path** (`~/.my-pizza-team/pi-extension/`).
  Pi identifies a local package by *resolved absolute path*, so a per-team path
  would mint one package identity per team, and two registrations load the
  extension **twice** (duplicate tools, two directive pollers, two heartbeats).
  Setup therefore resolves conflicting registrations rather than ignoring them,
  comparing *resolved* paths — `pi install` records paths relative to the settings
  file, so string matching would miss every conflict.
- **A development checkout wins.** If `…/harnesses/pi` is registered, someone is
  editing it; silently replacing it would make their edits stop taking effect with
  no indication why. Setup removes its *own* registration instead and says so.
- **Uninstall doesn't restore what setup removed** (a dead path, the archived
  standalone repo) — that would re-create the broken state — and it never revokes
  project trust, which other tools may rely on.
- **Settings writes preserve every field mpt doesn't own** and are atomic
  (temp-file + rename).
- **The permission system is recommended, not installed.** Without
  `@gotgenes/pi-permission-system` autonomous teammates stop at the first prompt;
  the extension warns loudly at teammate start and `doctor` prints the install
  command. Setup doesn't auto-install it, which would couple mpt to a third party's
  publishing.

**`mpt doctor` is read-only** (so it's also setup's dry run) and every non-ok
check carries its fix. Two calibrations: a Pi older than `TESTED_PI_VERSION`
**warns** rather than fails, because there is no extension-API version to negotiate
and the surface used is small and stable; and only genuine breakage sets a non-zero
exit code. Its checks must never contradict each other — enforced by a property
test over `evaluate()`.

## The Daemon Is the Supervisor

The daemon owns tmux: it creates the session, opens a window per teammate, types
the harness's start command into it, and kills it on dismiss. Start commands are
**team config** (`harnesses.<name>.teammate` / `.leader`, with built-in defaults
for Pi), not extension code.

*Why:* while tmux lived in the extension, adding a harness meant an extension
release and nothing could spawn without a leader process. With the daemon as
supervisor, a harness is a config entry, and the extension shrinks to what only Pi
can do in-process: transcript mirroring, chat bubbles, permission handling, and
session control.

- **No shell.** Every tmux call is an argv array. The extension's old sanitizer
  *stripped* unsafe characters instead of quoting, so `/Users/t/My Project` became
  `/Users/t/MyProject` and the teammate started in the wrong directory or none.
  Only the command typed by `send-keys` is a shell string, and it is quoted
  properly.
- **The leader path is kept as a fallback.** Whether the daemon can reach tmux
  depends on how it was launched — under launchd/systemd there may be no `tmux` on
  PATH. It probes once at startup, reports the result on `/health`, and when it
  can't spawn, directives stay pending for the leader exactly as before. `mpt
  doctor` names which path is live.
- **A directive that can't be realized is marked `failed` with its reason** rather
  than left pending (which would retry every 2s, saying nothing). Failures show in
  the Team tab beside pending spawns.
- **`reset-session` stays with the leader.** It types `/new`, a Pi slash command;
  the daemon knowing each harness's commands is exactly the coupling this removes.
- **`mpt lead`** starts the leader in the project directory with the harness's
  `leader` template, and is idempotent — two leaders would both answer the chat —
  so a re-run attaches instead of starting another.

## Harness Tiers, and Why Not MCP

**Pi is the only fully supported harness.** Support is designed in tiers:

| Tier | Mechanism | What you get | Harnesses |
| --- | --- | --- | --- |
| **0 — text-driven** | the daemon owns tmux and delivers prompts | spawn, dismiss, prompt delivery | any CLI agent (not built) |
| **1 — supervised (ACP)** | `mpt agent` drives the agent over the Agent Client Protocol | work loop, fresh sessions, permissions, watch view, usage | Kiro, Claude Code — **experimental** |
| **2 — native** | + an in-process adapter: pairing, steering, chat, leading | full fidelity | Pi |

Any agent can also speak the HTTP protocol directly (README's shell loop).

**Tier 1 is ACP, from outside the agent.** Most coding agents now speak the Agent
Client Protocol — JSON-RPC over stdio, built for editors: sessions, streamed updates,
permission requests *to the client*, cancellation. So a non-Pi teammate needs no
adapter inside it: `mpt agent` is an ACP client to the agent and a daemon-protocol
client to the daemon, through the same `runtime/` the Pi extension uses. It runs **in
the teammate's tmux window**, not in the daemon, so teammates still survive a daemon
restart and re-register. The choices it makes:

- **Completion is the turn ending**, as for Pi: `end_turn` completes the item with the
  reply after the last tool call as its summary. **Giving up is explicit** — the
  prompt names `mpt agent fail "<why>"`, which any shell-capable agent can run — and
  anything else (another stop reason, an error, the agent dying) fails the item with
  the reason, so nothing hangs.
- **A fresh session per item**, and the session mode set explicitly: an agent
  otherwise inherits the user's own defaults (Claude's `defaultMode`).
- **Permissions are answered by the supervisor** — allow once while autonomous, never
  "always" — rather than disabled in the agent, which keeps forwarding them to the
  web UI during pairing possible.
- **Usage in tokens and dollars only.** Kiro reports credits, which nobody can price;
  they aren't recorded.
- **Experimental, behind `experimental.harnesses`.** The daemon refuses to spawn or
  register them without it, and says how to opt in.

*Why not an MCP server:* one was built (`mpt-mcp-server`, archived at tag
`archive/mpt-mcp-server`) and retired. An MCP server can only expose *tools*, and
tools are passive: the model calls one if and when it decides to. Nothing in MCP can
poll for a directive and make an agent act, mirror a transcript, or approve a
permission prompt — which is why that repo grew its own per-harness sidecar
supervisor, which then drifted a protocol generation behind. The supervisor now
lives in `mpt`, once, for every harness; an MCP or CLI tool surface only makes sense
as the reporting half of a loop the daemon already runs.

The extension's own seam mirrors this: `harnesses/pi/src/runtime/` implements the
daemon *protocol* with no external imports, no relative *value* imports, and no
mention of Pi (enforced by `tests/runtime-purity.test.ts`); everything beside it is
Pi-specific. The no-value-imports rule is what keeps those modules loadable — and
so testable — under plain Node, whose resolver doesn't remap `./x.js` to `./x.ts`
the way Pi's loader does. It is deliberately not a top-level shared package: the
tiers leave no second in-process consumer, and hoisting it would break the
self-containment the embedded extension needs.

## One Host, One Leader

A team runs on one machine with one leader. Multi-host support existed in the
schema but was never configured, and it taxed everything — above all, the daemon
had to *designate* one of several leaders as the chat agent. It was removed: the
leader-directive channel is singular (`/api/leader/directives`), readiness is a
team-level fact, and the chat simply goes to the leader.

## Readiness Gating

Credentials, VPN, and network are properties of the machine, so readiness is one
**team-level** fact, produced by the optional `readinessProbe` command. The
**daemon** runs it every 30s (exit 0 = ready; otherwise the first output line is
the reason). While the team is not ready, the cron scheduler **holds** due
scheduled work instead of enqueuing it, sets `heldForReadiness` on the Schedule,
and doesn't advance its cursor — so on recovery the job fires **exactly once**
(missed occurrences collapse into one catch-up run). `POST /api/readiness` remains
so a harness can report too.

- **The daemon runs the probe, not an agent.** An unreported team must count as
  ready (a fresh daemon knows nothing), so when the leader ran the probe, a machine
  too wedged for the leader to start was treated as *healthy* and kept being fed
  work. The daemon is running whenever it matters.
- **A probe that can't run means not ready.** A probe confirms the machine can
  work; one that can't launch confirms nothing. A hung probe is timed out.
- **Gating applies only while an agent is online.** With none connected the queue
  simply waits; readiness is about connected-but-unable, not absent.
- **Only the scheduler is gated.** Solitary and board work are human-initiated and
  still run (and may fail visibly).

The motivating case: a cloud desktop whose credentials expire overnight shouldn't
wake up to a pile of FAILED cron runs.

## Leader Directives

The daemon asks for agent-lifecycle actions through one queue — "an ask to do
something about an agent":

```
GET  /api/leader/directives      # the pending queue
POST /api/leader/directives      # { action, memberId?, params? }
PUT  /api/leader/directives/:id  # { status }
```

A directive has an `action` (`spawn`, `dismiss`, `reset-session`, `new-session`,
`resume-session`), an optional `memberId`, `params` (e.g. spawn `name`/`cwd`), and a
`status`. The daemon realizes `spawn` and `dismiss` itself when it can reach tmux;
the leader realizes whatever is left (`reset-session` → `/new`, and spawns when the
daemon can't). Three rules hold:

1. **Intent, not mechanism, crosses the channel.** A directive says *what*; its
   realizer decides *how*.
2. **Harness metadata is opaque.** `Member.metadata` is supplied at registration
   (e.g. the agent's tmux window) and relayed verbatim so the realizer knows where
   to deliver. The daemon never interprets it.
3. **The daemon owns identity, so it assigns spawn names.** A `spawn` always
   carries a daemon-generated adjective-noun `params.name`; the tmux window, the
   registered member, and the UI label all use it.

**Self-handled actions.** `new-session` and `resume-session` roll the chat agent's
own Pi session to follow a chat "new" or "resume". They are filtered out of the
leader queue and polled by the target agent itself (`GET /api/agents/:id/directives`),
because "switch to this exact session file" needs in-process Pi APIs
(`newSession()` / `switchSession()`, available only on command contexts), not
keystrokes.

*Why:* one concept, one queue, one poll — new asks are new *actions*, not new
endpoints.

## One Agent to Talk To

There is no dedicated "assistant" process. **The leader is the agent you chat
with.** A leader already runs, and nobody types in its session — its directive
polling is extension timers, not agent turns — so its Pi session contains *only*
the chat. That keeps sessions-as-conversations (snapshots, resume) meaningful, and
removes an entire concept: no assistant spawn, no reserved name, no "assistant
offline" dead end.

With one leader there is nothing to designate: `GET /api/assistant/inbox?agentId=`
is an identity check — the leader drains the queue; any other agent gets an empty
list, since draining it would lose the message.

## Assistant Chat Model (a mirror of the Pi session)

The chat is a chatbot, not a request/response form. One inversion makes it work:
**the Pi session is the conversation; the daemon mirrors it.** That is what lets
you chat from the web UI **or** the leader's terminal, interrupt mid-answer, and
resume an old conversation with its context intact.

1. **Sending never blocks.** `POST /api/assistant/messages` always succeeds and
   appends a `queued` message. The extension pulls the inbox and hands messages to
   Pi, steering them into a run in flight. Interleaving is Pi's job, which is why
   there is no turn machine, composer lock, debounce, or typing ping.
2. **Receipts are honest.** `queued` (nobody has it) → `delivered` (handed to Pi;
   it may be waiting on the current tool batch) → `read` (a run that sees it has
   started): ⧗ / ✓ / ✓✓.
3. **The agent just talks.** There is no send-message tool. The extension mirrors
   the agent's own prose into bubbles, split on blank lines (never inside a code
   fence or list; runts merge into a neighbour, except questions, which keep their
   own bubble). Prose before a tool call mirrors immediately, so long answers
   arrive progressively. Routing bubbles through a tool made replies stilted and
   the tmux transcript a wall of tool calls.
4. **Both surfaces are one conversation.** Anything typed in the leader's terminal
   is mirrored in as a user message with `origin: "tui"`, marked with a terminal
   glyph.
5. **Thoughts are ephemeral.** Reasoning streams to a capped in-memory buffer,
   readable behind the `…` — never persisted or snapshotted, cleared when the next
   run starts.
6. **Nothing is destroyed; sessions are the unit of history.** "New chat", a
   persona swap, or resuming another session *ends* the current session, writing
   `assistant/sessions/<id>.md`, and opens a new one. The active session's snapshot
   is also refreshed on the heartbeat tick and at shutdown, so a crash loses
   minutes, not a conversation. Resuming asks the agent to switch back to the
   recorded Pi session file; a session with no recorded file is readable but not
   restorable.
7. **Chat behavior is system-level, not per-persona.** The system prompt is always
   `ASSISTANT_CHAT_FRAMING` (be brief, blank lines separate bubbles, the user may
   interrupt) followed by the persona body or `DEFAULT_ASSISTANT_PERSONA`. Personas
   are about voice and role, never delivery mechanics.

---

## The Shell: a Dock and a Center

The app is two columns: a **dock** on the left for the things you keep an eye on
*while* looking at something else, and a **center** that shows one thing at a
time.

| Column | What's there |
| --- | --- |
| **Dock** (`SideDock`) — a header, then two tabs | Header: `+` (New Story / Solitary Task / Scheduled Job) then the queue summary. Tabs: **Assistant** (the chat with the leader) and **Team** (the teammates; team size, spawn) |
| **Center** (nav + `<main>`) | board, tasks, schedule, context, thoughts, task detail, inbox, a teammate's live view, config |

*Why a dock, not a page:* talking to the assistant and watching the team happen
alongside whatever is in the center. `/assistant` is just a redirect that opens
the tab.

*Why one dock with tabs, not a sidebar on each side:* two always-open columns
squeezed the center, and in practice you look at one at a time. **Tab badges** win
most of the visibility back: unread replies on Assistant; the online count and an
amber dot (a team size it can't meet) on Team. Both tab bodies stay mounted, so a
half-typed message survives a peek at the team, and the dock owns the data behind
the badges so they stay live on either tab or collapsed.

**The queue: a summary in the dock, the list in the center.** What must always be
visible about work in flight is the *summary* — "2 waiting · 1 at risk". So the
dock's header row carries it (aligned with and tinted like the nav, above both
tabs because it belongs to both): the counts, at-risk in amber, a hover preview,
and a link to the full list. The `+` sits immediately left of it — `+ │ Queue …`
reads as "add work to the queue". The list and its recovery actions are a center
view: the **Queue** tab on the home page, before the Inbox, because that's where it
sits in a piece of work's life (in flight → finished).

The dock collapses to an icon rail (remembered in `localStorage`) carrying both
tabs' essentials. Below the `lg` breakpoint it becomes a floating corner panel —
for a narrow desktop window. A phone gets a different shell altogether (next).

The **Team tab is teammates only.** The leader is the agent behind the Assistant
tab; listing it on Team too would show one agent twice. It shows up on Team only
through the amber dot when no leader is connected to grow the team.

**The nav belongs to the middle.** The NavBar spans only the center column: it only
ever changes what's in the middle. The rule for the middle is *one thing at a time,
and whatever put it there is highlighted* — a nav tab for pages, a teammate row for
a teammate's live view. The center is a container-query context, so the nav adapts
to the room the dock leaves rather than to the viewport.

## A Phone Is a Peek

On a phone the app is a **separate shell at `/m`** (`ui/src/mobile/`), not the
desktop one made responsive. What you want from a phone is a glance and a quick
reply — is the team working, is anything at risk, what did the leader say, what
finished — so it has four bottom tabs: **Team** (teammates + the queue), **Chat**,
**Thoughts** (a list, and one note at a time), and **Inbox**.

*Why a second shell, not a responsive one:* the desktop is built around two columns
and pages that assume width (the board's swimlanes, the Thoughts canvas, task pages
with tabs). Squeezing them gave a floating chat panel over a page you couldn't use.
A peek needs a fraction of the surface, and rebuilding that fraction from the same
parts is cheaper than making every page work at 390px. The parts *are* the same:
`AssistantChat`, `TeammateRow`, `QueueList`, `TeammatePage`, `lib/thoughtList.ts`.
Anything the phone doesn't do (boards, workflows, config, team size) is one "Open
full" or 🖥 tap away in the desktop UI.

**How you get there.** The split happens in `App.tsx` before either shell mounts, so
the phone never mounts the dock (a second chat stream). A phone — a narrow viewport
*and* a touch pointer, so neither a narrow desktop window nor an iPad — that lands on
the home page is redirected to `/m`. Only the home page: a deep link means "show me
that page". 🖥 remembers "desktop" on that device; opening `/m` forgets it.

**Built like the dock.** The shell owns the live data (chat stream, team, queue,
unread Inbox count) so every tab's badge stays live, and keeps all four tabs mounted
so a half-typed message survives a look at the team.

**Touch rules that also reach the desktop components:**

- In the chat composer, **Enter is a newline on a touch screen** and Send sends.
  A phone keyboard has no Shift+Enter, so Enter-to-send made multi-line messages
  impossible.
- Hover-revealed actions don't exist on touch, and an invisible button is still
  tappable. Chat bubble actions show faintly on touch (`pointer-coarse:`), and the
  phone's Team tab passes `TeammateRow` no actions and summarises spawn rows.
- A note's Edit mode is a **plain textarea**, not CodeMirror. Vim keys (the
  desktop default) are no use on a phone keyboard, and iOS selection, dictation,
  and autocorrect work with a native field.

**The Inbox opens in place.** On the desktop an Inbox row opens the task page,
where the outcome is the last comment of a long thread. The phone shows just the
run's closing comment (`[done]` / `[failed]`, else its teammate's last comment by
then — `lib/mobile.ts` `inboxOutcome`). Opening marks it read, and opened rows stay
on screen until you leave, even with "unread only" on, so the poll can't pull the
summary out from under you.

**Reaching it from a phone is not the daemon's job.** The daemon binds to localhost.
Remote access is a tunnel in front of it that does its own authentication (an
SSO-protected tunnel opened in a browser that can sign in to it), plus the API token
if you want a second lock. A native app was the other option and was rejected for now: it wouldn't
have the browser's SSO cookies, so it couldn't get through that kind of tunnel.

## Pages over Modals

The board is for glancing and light triage (drag a card to move it). Clicking a
card never opens an editor; the `details →` link opens the task page, and all
reading, editing, and creating lives on dedicated, deep-linkable pages. The only
modals are small, focused dialogs (team size, spawn, template picker, a thought's
editor, a fullscreen chat bubble, the big editor) and the file/diff viewer. Cards carry no state
badge (the column names the state) — only the WorkItem chip.

## The Big Editor

Pi and Claude Code bind **Ctrl+G** to "edit this prompt in `$EDITOR`": a real
editor for anything longer than a line. A browser can't launch nvim, so the web UI
brings the editor to the text instead: any text box that wires
`ui/full-editor.tsx` opens full-screen in **CodeMirror 6** and hands the text back
when you close it. The chord is incidental — the **Edit** button is the primary way
in, Ctrl+G is there for muscle memory, and `/editor` works in the chat composers.

Where a text box already has an Edit mode — a **Thoughts note**, and the
markdown **description fields** on stories and WorkDefs — there is no full-screen
step: Edit *is* the CodeMirror editor, inline, with the same vim switch. A button
to open an editor from inside an editor would be ceremony. (A form owns saving
there, so `:w` does nothing and `:wq` returns to Preview; a hidden textarea keeps
the browser's native `required` validation working.)

- **A library, not a hand-rolled textarea.** Indenting or continuing a list by
  rewriting a textarea's value breaks native undo; CodeMirror keeps its own
  history, and brings markdown list continuation, search, and vim for free. It is
  **lazy-loaded**, so it costs nothing until someone opens it.
- **Vim on by default, and obviously switchable.** The people who asked for this
  live in vim, so vim keybindings (@replit/codemirror-vim) are on unless you turn
  them off — with a labelled **Vim: On/Off** switch in the header, not a setting
  buried in Config, remembered per browser (`mpt.editor.vim`) and shared live by
  every editor on the page. It opens in
  **insert mode** so typing just works for someone who has never seen vim, and the
  status bar always says what mode you're in and how to get out.
- **The host decides what `:w` means.** The editor only reports `write` (`:w`,
  ⌘S), `save` (`:wq`, `:x`), `quit` (`:q`, `:q!`), and `submit` (⌘↵). In the
  full-screen editor there's no file to keep open, so write and save both hand the
  text back and close, and quit discards. In a note, `:w` saves and keeps you
  writing, `:wq` finishes, and quit finishes too — a note has no discard path.
  With vim on, **Esc belongs to vim** and never closes the editor or the dialog
  around it; with it off, Esc closes and keeps the text.
- **The host keeps the text.** The editor holds a buffer only while open; the host
  (a composer's draft, a note's draft) stays the source of truth and saves the way
  it always does. A host's primary action (Send) is bound to ⌘↵ and runs only
  after the host has re-rendered with the edited text.

## Thoughts: Uniform Cards, and a List to Read Them

The Thoughts canvas is a board, so its notes are **all one size**. Variable-size
notes made the canvas a collage you had to read rather than scan, and made tidy
grids and group plates ragged. A card shows the start of a note and fades out; the
note opens in a large **view/edit dialog** (double-click, the hover ⤢, or Enter).
Per-note controls live in that dialog's header — they're things you do *to a note
you're looking at*. Every way of closing it saves.

**Group membership is drag-and-drop, and explicit.** Dropping a note on a plate adds
it; dropping a member on open canvas removes it. Only a drop changes membership —
moving a plate over loose notes doesn't absorb them. While a note is dragged its
plate stops wrapping it, or a member could never leave. Once the note is about half
over a plate (its center, or the pointer), the plate highlights and grows to show
where it'll land; the target test ignores that growth so the preview can't flicker.
Resizing starts from the plate as *drawn*, not its smaller stored minimum. The rules
are pure geometry (`ui/src/lib/thoughtGeometry.ts`) with their own tests.

**Two views of one board: canvas and list.** The canvas is for arranging —
seeing notes side by side, clustering them. It's poor for *reading and writing*
many notes in a row: every note is a double-click and a dialog away, and finding
one means panning. So there is also a **list view** in the shape of Apple Notes or
OneNote: folders on the left, the note on the right. Folders *are* the groups —
not a second hierarchy — so the two views never disagree about what's where. The
list is not a separate feature with its own data; the page owns the board and
either view is just a way of looking at it, with the selection carried across a
switch.

The differences between the two are deliberate:

- **The list autosaves; the dialog saves on close.** A dialog is opened, written,
  and closed, so its close paths are the natural save points. The list's pane is
  never closed — you click the next note — so waiting for a "close" would mean
  waiting forever. It saves a moment after typing stops, and on switching notes.
  Neither has a path that loses text.
- **The list orders by last edit, pinned first; folders alphabetically.** That's
  what a notes app does, and it's why `updatedAt` means "the text last changed":
  if dragging a note on the canvas counted as an edit, arranging the board would
  shuffle the list.
- **Filing a note in the list moves it on the canvas.** Membership is explicit
  (only a drop or a picker changes it), but a plate always wraps its members — so a
  note filed from the list while sitting across the canvas would stretch its
  plate over everything in between, and a note taken out while still under its
  plate would look like it never left. So filing from anywhere but a canvas drop
  also moves the note: into a free slot in its plate, or below everything.
  If it's already where it belongs, it stays put.

Thoughts is deliberately a lighter port of a standalone product: files are the
source of truth (`thoughts/<id>.md` + `groups.json`), a fixed six-color palette,
and none of the original's cosmetic surface.

## Usage: a Ledger of Every Run

Token usage is a **ledger**, one row per agent run, and rows are **never deleted** —
archiving a story doesn't un-spend its tokens. Each row snapshots the title of what
it was for, so it stays legible after its ref is gone.

**Every run is counted, labelled by kind** — `work` (a teammate's run on a
WorkItem), `pairing`, `chat` (the leader), `other`. **Cache tokens count**: with
prompt caching most input is cache reads/writes, and counting only uncached input
made a real run look like three tokens. Cost is the harness's own cache-aware
figure (the daemon estimates only when none is sent), so the dashboard leads with
dollars. Days are the **user's** days: the browser sends its UTC offset.

**The ledger is files; SQLite is a cache.** Each run is one JSON line appended to
`usage/YYYY-MM.jsonl`, committed with the rest of the team dir; the table is rebuilt
from the files on boot. JSON Lines because the ledger is append-only: every run is a
one-line diff, merges rarely conflict, and it's `jq`-able.

## Watching and Pairing with a Teammate

A teammate's page (`/teammates/:id`) is its Pi session rendered like a terminal,
not chat bubbles — you're looking over its shoulder, not texting it.

**Live, and only while watched.** The SSE subscription registers a viewer; the
extension polls the resulting "watched" bit (with a 30s grace so page hops don't
flap) and an unwatched teammate sends nothing. Hence **no backfill**: the view
starts at a "watching from …" marker, and the work item's page has the prompt and
thread. Entries are keyed upserts (Pi's message updates are cumulative), so opening
mid-reply still renders coherently. The buffer is in-memory, per member, and
survives viewer disconnects (each watching period gets its own marker): a live
view, not a record — the WorkItem thread is the record.

**Pairing is the explicit step that talks to it.** Watching can never interrupt.
**Pair** pauses the teammate's loop (no new claims, no completion behind your back)
and opens a composer; permissions stay autonomous, since nobody is at its terminal.
The default send *queues* behind the current run; steering mid-run is a deliberate
second gesture. Releasing is a decision about the held work item — resume,
complete, or fail — because "stop talking" alone doesn't say whether the work is
done. A release waits out a run in flight; acting mid-run would read the reply to
your last message as the item's completion. The daemon holds only the intent,
drained exactly-once by the teammate's poll — the same intent/realization split as
directives. A release is accepted even for a pairing the daemon forgot across a
restart, so a paused teammate can always be released.

---

## Teammate Status: Shape, not Color

A teammate's status is shown by **which icon it has**, not by a colored dot:
**person** — pairing with you; **bot** — waiting for work; a slowly turning
**loader** — working; **cloud-off** — lost contact (the leader keeps its crown
while reachable). A dot asked you to remember what green, blue, and red meant,
said nothing to anyone who can't tell them apart, and sat next to a person icon
that never changed. The shape *is* the meaning, and its tooltip says it in words.

Beside the name each row shows the **model** the teammate is running (its name;
provider/id on hover), and beside the directory the two numbers Pi's own footer
shows:
**context fill** (the percentage of the window — that's what decides "time for a
fresh session"; raw tokens in the tooltip, or instead when the window is unknown)
and the **session's cost** so far. They're reported by the harness after every
turn (`POST /api/agents/:id/session-stats`) and on a model switch, not on the
30-second heartbeat, because that's when they change. They're **live state, not a ledger**: held in
memory, cleared when the agent starts a fresh session (re-registers), and resent
after a daemon restart. Spend history stays the usage ledger's job. Unknown stays
unknown: just after a compaction Pi can't count the context yet, so it reads
`?`, never a reassuring 0%. The route is additive and optional, so it isn't a
protocol bump — a harness that never reports simply shows no numbers.

## Testing: Fast, End-to-End, and Never Real Config

- **`deno task test`** is the inner loop and stays fast (seconds). It uses a
  `TEST_CONFIG` with autosave off, because a Store with autosave on reaches real
  git.
- **`deno task test:e2e`** drives the real CLI, real git, and real tmux in a
  sandbox — isolated `MPT_HOME`, `PI_CODING_AGENT_DIR`, team dir, and a private tmux
  server (`TMUX_TMPDIR`) — torn down even on failure. **No test touches real
  configuration**, enforced by construction rather than care.
- A test that skips must skip for the *expected* reason (tmux genuinely absent,
  not a missing `--allow-run`), and that is asserted.
- Suites are checked by mutation: green on first run is a reason for suspicion, so
  new tests are verified by deliberately breaking the code they guard.
- No LLM is in the loop, so these test mpt's mechanics — windows, settings files,
  directives, exit codes. Whether a teammate does good work is exercised by hand
  with `mpt-demo-team`.

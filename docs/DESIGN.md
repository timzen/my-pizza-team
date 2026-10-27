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
2. **Explicit over implicit** — Dependencies are declared in `package.json` and pinned by `package-lock.json`; which Node runs mpt is a saved, visible setting (`~/.config/mpt/runtime.json`), not whatever is first on PATH.
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
judgment moves, task creation/deletion, a story's activation (pending → active), and daemon load — and, for
every story that `dependsOn` it, whenever a story reaches `done` or is archived or
deleted (a missing dependency counts as satisfied). A judgment
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

## Errored Sessions Retry

A teammate's run can end because the **model call** failed — a Bedrock 503
`ServiceUnavailableException`, "Could not load credentials from any providers" —
not because the agent finished or gave up. Pi reports it as a final assistant
message with `stopReason: "error"` (empty content, zero tokens, an `errorMessage`).
Read as a normal `agent_end`, that posted `[done] Work complete. Summary:` with an
empty summary and set COMPLETE, so scheduled jobs silently did nothing.

So an errored session is **neither a completion nor a give-up**:

- The harness detects it (`summarizeRun` → `sessionError`; only the run's *final*
  assistant message counts, a human abort doesn't, and an empty-but-successful
  reply is still a completion) and calls the state route with
  `FAILED` + `sessionError`. It posts nothing itself.
- The daemon (`Store.failWorkItemForSessionError`) owns the retry: with retries
  left it posts `[retry] Attempt n/N failed: <error>. Retrying in 5m…`, marks this
  attempt FAILED **and read**, and enqueues attempt n+1 — a *new* WorkItem (a
  WorkItem never moves backward) held READY until its backoff (`retryAt`) passes
  **and** the readiness probe reports ready (no point retrying into expired
  credentials). Once retries run out the attempt stays FAILED, **unread** — it
  lands in the Inbox — with `[failed] <error> after N attempts`.
- Policy: `retry: { maxRetries: 3, backoffMinutes: [1, 5, 15] }` in config.json
  (`resolveRetry`; 0 disables retrying; the last backoff repeats).
- Board tasks keep their position while a retry waits (the retry is just the
  task's next WorkItem); Solitary/Scheduled WorkDefs work the same.

*Why the daemon posts these comments* (the exception to "the agent writes its own
comment"): the retry decision and attempt count are the daemon's, and putting
them on the thread is what makes the attempts visible. Intermediate attempts are
marked read because they aren't news — the retry is; only the final outcome
should notify. A plain FAILED (the `fail` tool, a human) is never retried: that
was a decision, not an outage.

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

Directories are compared after `normalizeDirectory`: `~` expanded, trailing
slash stripped, and **symlinks resolved to the real path** (`fs.realpathSync`),
so `/home/u/repo` and `/local/home/u/repo` (via a `/home/u` symlink) match. A path
that doesn't exist or can't be read on the daemon's machine falls back to the
string form — normalization never throws. It's applied at write time *and* at
compare time in `getNextWorkItem`, so rows stored before resolution (or before
the path existed) still match without a migration.

Tier 3 is presence-based, not timed: if an online agent with the matching
directory exists, the item waits for it. `Story.pending` and unmet story
dependencies are independent gates (their items are never offered).

### Exclusive directory leases: one teammate per directory

Affinity decides *who* gets work; the **directory lease** decides *whether* it's
handed out at all. With `exclusiveDirectories` on (the default), a READY item
with a directory is skipped while another **active** WorkItem's directory
overlaps it. Active means `IN_PROGRESS` or `MORIBUND`; `COMPLETE`, `FAILED` and
`CANCELED` free the lease. Overlap means the same path or one inside the other,
compared by **path segment** after `normalizeDirectory` on both sides:
`/ws/mpt-dev` and `/ws/mpt-dev/my-pizza-team` conflict, `/ws/foo` and
`/ws/foobar` don't. The rules:

- **Only WorkItem directories lease.** A teammate's registered directory still
  drives the affinity tiers, but it never takes or blocks a lease.
- **No directory, no lease.** Items without a directory never take one and are
  never blocked, so they run in parallel with anything. This includes triage
  items when no leader is registered. Triage items that inherit the leader's
  directory do lease it.
- **Blocked items stay READY.** Nothing is re-queued. Once the lease frees, the
  oldest blocked item is picked up by the normal tiers.
- **MORIBUND keeps the lease.** A teammate that reconnects resumes its item
  without colliding with a newcomer in the same checkout. Nothing times a
  MORIBUND item out (see "Reaping"). A human releases a stuck lease by
  **force-failing** the item on the Queue page (optionally re-enqueuing it).
- **Claim is atomic.** `claimWorkItem` re-checks the lease inside a
  `BEGIN IMMEDIATE` transaction. Two agents offered overlapping items in the same
  instant can't both claim; the loser gets a 409 ("directory busy") and polls
  again.
- **Visible.** `GET /api/work-items` attaches `blockedBy` to a blocked READY
  item, and the Queue page reads "waiting — directory busy (<teammate>, <item>)".

*Why:* CONWIP only serializes the tasks *within* a story. Two standalone tasks,
two stories, or a story and a task aimed at one checkout used to run at once,
which meant clashing edits and tangled commits. The lease is coarse on purpose:
parent/child paths conflict because a commit in the parent repo sweeps up the
child's edits. Setting `exclusiveDirectories: false` (Config → Teammates)
restores unrestricted parallelism for teams that use separate worktrees.

The claim prompt tells the agent to `cd` into the directory and **read that repo's
AGENTS.md** before starting, since Pi only auto-loads project context from its
startup cwd.

*Why:* the only matching signal that ever mattered was "where the work happens."
Making it a *bias* rather than a filter retires the path-string bug class
(symlinks, mounts, trailing slashes) — a false-negative match merely loses the
preference; it never strands work. The directory *lease* (below) is the one place
a directory gates work, and it compares WorkItem directories only. Accepted
trade-off: any teammate can be pointed anywhere the process user can write.

### Favorite Directories

Since every piece of work names a directory, typing paths is the most repeated
chore in the UI. Every directory field is one component (`DirectoryInput`) that
offers the team's **favorites** first, then **recently used** directories, then
any caller extras (e.g. story homes in Spawn).

- **Favorites live in team config** (`favoriteDirectories`), normalized with
  `normalizeDirectory` — the same `~`/symlink resolution affinity uses — so a
  favorite is the same string agents register and WorkItems carry.
- **Recent is derived, not tracked**: online teammates' directories, then recent
  WorkItem directories, then story directories. Nothing extra to persist or
  drift. (An earlier version replaced favorites with an auto-maintained
  "recent capabilities" map; capabilities are gone, and an auto list alone
  never let you pin the handful of repos you actually use.)
- **Edited where used.** A star on each suggestion adds/removes a favorite
  immediately; the Config page lists them too. Favorites have their own
  endpoint and `PUT /api/config` ignores the field, so saving a Config draft
  loaded before a star was clicked can't silently undo it.

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
| an **external source** (`parentKind: external`, `parentSource`) | External | its sync reports a new revision of the item (see "Work Sources" below) |
| none | Solitary | you press **Run** |

All of them funnel through one `enqueueFor(workDefId)`; a teammate works "the next
thing" without caring where it came from.

**Invariant: `workdef.md` is authored content only.** All mutable runtime state
lives elsewhere — workflow status on the Story (`tasks: [{id, status}]`), cron and
`lastEnqueuedAt` on the Schedule — so the daemon never rewrites a `workdef.md`
except on an explicit edit. Frontmatter carries only structural metadata (title,
`parent`, directory, contextRefs, `status: archived` when archived, and
`pending: true` while pending — activating is itself an explicit edit).
The one exception is a **mirrored** WorkDef: its content is authored in an
external system, so the daemon rewrites its `workdef.md` — but only from that
source's sync, never from an MPT edit (see "External sources" below).

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

## Work Sources: WorkDef Kinds as Plugins

A **Work Source** is the plugin that owns one WorkDef kind — the *parent* in the
table above — and decides when its WorkDefs want a WorkItem. All four built-ins
(Story, Schedule, Thought, Solitary) now run on it, and the core supports an
external (pull-only) source — Jira, Asana, Taskei — through the same seam (see
"External sources" below), loaded from a team's plugin packages ("Plugin
packages" below) or, in development, the in-repo fixture. The interface is `daemon/sources/types.ts`; the registry
(`daemon/sources/registry.ts`, one per Store) maps a WorkDef to its source by
`parent.kind` — an `external` parent by its `parent.source` — with no parent =
the `"task"` source.

**Where the daemon branches on kind today** (the audit this design starts from;
✅ = through a source hook now, ⏳ = still inline, falls back when no source/hook):

| Where | Story | Schedule | Thought | Solitary | Hook |
|---|---|---|---|---|---|
| cron/readiness firing (`startTimers` → `runScheduler`) | — | ✅ `sources/schedule.ts` | — | — | `tick` |
| external pull (`startTimers` → `syncWorkSource`) | — | — | — | — | `sync` (+ `syncEveryMs`, `syncTimeoutMs`) |
| thread write-back (`addCommentForRef`) | — | — | — | — | `onComment` |
| triage sweep timer (`runTriageSweep`) | — | — | ✅ `sources/thought.ts` | — | `tick` + `tickEveryMs` |
| `loadFromDisk`: admission + queue reconcile on startup | ✅ `sources/story.ts` | — | — | — | `reconcile` |
| `enqueueFor`: title/directory | ✅ story's directory | default | ✅ note title, leader dir | default | `resolveItem` |
| "once per revision" stamp (`triagedVersion`) | — | — | ✅ via `enqueueRevision` | — | `ctx.enqueueRevision` |
| `isWorkItemEligible` | ✅ story active + ready, agent state | default | ✅ note active | ✅ `sources/task.ts` | `isEligible` |
| `setWorkItemState` (advance + admission) | ✅ advance, new position returned | — | — (result is `propose_work`) | — | `onItemTerminal` |
| claim prompt (`routes/agents.ts buildClaimPrompt` → `Store.buildPromptFor`, `prompt.ts`) | ✅ story + persona framing | base | ✅ triage prompt | base | `buildPrompt` (a triage-mode external item: the daemon's triage prompt) |
| assignment row at claim (`claimWorkItem`) | ✅ recorded | — | — | — | `onItemClaimed` (release on terminal/cancel/force-fail is the daemon's, unconditional) |
| `activateWorkDef` | ✅ enqueue in an agent state, else admission | nothing (default) | nothing (default) | ✅ enqueue | `onActivate` |
| Run (`POST /api/work-defs/:id/enqueue` → `Store.runWorkDef`) | default | default | ✅ Triage now | ✅ refuse pending/in-flight | `run` |
| features (`featureForWorkDef`, `isWorkDefVisible`, `activeFeatureItems`) | ⏳ `workDefType` | ⏳ | ⏳ (always on) | ⏳ | — |
| routes: `propose_work` (agents.ts — any triage subject: a note's container or a triage-mode mirror), work-defs cron edit / triage-owned PUT·DELETE, `deleteSchedule` unparenting | — | ⏳ | ⏳ | — | — |

**The interface** (every hook optional; a missing hook means Solitary behavior):

```ts
interface WorkSource {
  id: string; apiVersion: 1;
  init?(ctx): void | Promise<void>;          // once, at registration
  tick?(ctx, now: Date): void;                // the daemon's timer (Schedule fires, Thought sweeps)
  tickEveryMs?(ctx): number | null;           // that timer's interval; default 30s, null = none
  label?: string;                             // display name ("Jira"); default the id
  mode?: "work" | "triage";                   // external: work the items (default) or triage them
  sync?(ctx): Promise<ExternalDef[]>;         // pull-only external sources: every item it has now
  syncEveryMs?(ctx): number | null;           // that poll's interval; default 60s, null = on demand
  syncTimeoutMs?: number;                     // one sync's budget; default 30s
  reconcile?(ctx): void;                      // the daemon just loaded from disk (Story: admission + queue)
  isEligible?(def, ctx): boolean;             // may a READY item still be handed out?
  resolveItem?(def, ctx): { title?; directory? };  // at enqueue
  buildPrompt?(def, base, ctx): string;       // at claim, given the daemon's base prompt
  onActivate?(def, { enqueue? }, ctx): WorkItem | null;  // a pending def was activated
  run?(def, ctx): RunResult;                  // the author pressed Run
  onItemClaimed?(def, item, memberId, ctx): void;         // leased (sync, inside the claim transaction)
  onItemTerminal?(def, item, ctx): ItemTerminalOutcome | void | Promise<void>;  // after COMPLETE/FAILED/
                                              // CANCELED; a sync { newStatus?, completed? } goes back to the agent
  onComment?(def, comment, ctx): void | Promise<void>;    // a comment landed on its thread (write-back)
}
// SourceContext: sourceId, teamDir, config(), options() (the source's own settings), log(), listWorkDefs(),
//   hasActiveItem(defId), enqueue(defId) → the single enqueueFor,
//   enqueueRevision(defId, revision, { force?, cursor? }), kv (sources/<id>.json),
//   upsertDef(ExternalDef) → the read-only mirror, readiness.canEnqueueNow()
// ExternalDef: { externalId, revision, title, goal, acceptanceCriteria?,
//   additionalContext?, directory?, url?, mode? }
```

Defaults for a missing hook are Solitary's (eligible, the def's own title and
directory, the base prompt, nothing on terminal, Run = `runSolitary`: refuse a
pending or in-flight def, else enqueue) — except `onActivate`, whose default is
to do nothing (a Scheduled def waits for its cron; a triage def is never pending).

**Enqueue once per revision.** Triage was the prototype for what an external
source needs: a note is analysed once per edit, not once per sweep. That rule is
now core, `ctx.enqueueRevision(defId, revision)` (`daemon/sources/revision.ts`):
an in-flight item refuses; a `revision` equal to the one last handed over refuses
unless `force` (Triage now); otherwise it enqueues through `enqueueFor` and
stamps the revision **at enqueue** — so a change landing mid-run is due again
afterwards, and a failed run doesn't retry on its own. Revisions are opaque
(equality only), so a Jira `updated` or an etag works. The stamp lives in the
source's own `kv` (`sources/<id>.json`, key `revision:<defId>`) by default; the
Thought source passes a cursor onto the note's `triagedVersion` frontmatter so
nothing moved on disk. Triage's other rules — quiet period, empty, archived —
stay in the Thought source in front of the helper.

**Thought is always on.** It has no feature toggle (`featureForWorkDef` maps a
Triage WorkDef to none), so the Thought source is always registered; turning
auto-triage off (`triage.enabled: false`) only drops its timer and makes the
sweep a no-op — Triage now still works.

**Story is a source too.** `daemon/sources/story.ts` (`StorySource`) owns the
board's queue *policy*: CONWIP admission (WIP = 1 per story, `admitDependents`
for `dependsOn`), every position change (leaving a position cancels the
in-flight item; landing in an agent state enqueues one — re-entry ≡ first entry;
the story's open/done follows its tasks), advancing on COMPLETE
(`onItemTerminal`, whose `{ newStatus, completed }` is what the agent's
state call returns), eligibility, the story-directory fallback, the persona +
story prompt, and admission + reconciliation on load (`reconcile`). Story
*persistence* — `stories/<id>.json`, the SQLite story/task cache, assignment
rows — stays in the Store and reaches the source as `StorySourceDeps`, and the
Store's board methods (`moveTask`, `updateTaskStatus`, `runAdmission`) are thin
entry points into it. So the core queue functions (`enqueueFor`,
`getNextWorkItem`/`isWorkItemEligible`, `claimWorkItem`, `setWorkItemState`,
cancel/force-fail, `activateWorkDef`) have no kind branches left; they only call
hooks. The claim's base prompt (`routes/agents.ts`) is kind-free too: framing is
the source's `buildPrompt`.

Refinements over the first sketch: the daemon owns the **timer** and calls each
source's `tick` (so `stopTimers` stops everything, and tests drive a source
synchronously) rather than each source starting its own in `init`; a source picks
its interval with `tickEveryMs` (Thought: the triage interval). The per-source kv
and `enqueueRevision` arrived with the Thought migration; `reconcile`,
`onItemClaimed`, and `onItemTerminal`'s outcome with the Story migration; `upsertDef`,
`label`, `syncEveryMs`/`syncTimeoutMs`, and CANCELED in `onItemTerminal` with the
external-source groundwork (below).

### External sources: pull only, mirrored, once per revision

A source that declares `sync` is **external** — the seam for Jira, Asana,
Taskei. They arrive as plugin packages ("Plugin packages" below); the in-repo
**fixture source** (`daemon/sources/fixture.ts`: a folder of markdown files, one
per item, a content hash as the revision) is the reference one, registered by
tests or by `config.dev.fixtureSource` (development only). The contract:

- **Pull only.** The daemon calls `sync()`; the source returns every item it has
  *now*. MPT never creates, edits, or deletes an external item: `PUT`/`DELETE
  /api/work-defs/:id` on a mirror and a `type: "External"` create are 409 with
  "change it in <source>". Status and comments flow back only through write-back.
- **Mirrored.** Each item becomes a read-only local WorkDef,
  `<sourceId>~<encoded externalId>` (namespaced, so sources can't collide with
  each other or authored defs; file-system safe and injective —
  `daemon/sources/mirror.ts`), with `parent: { kind: "external", id: externalId,
  source }` and a `url`. It's an ordinary WorkDef on disk, so prompts, the thread,
  attachments, Run, and the UI work offline and need no special case. Its
  `workdef.md` is written **only by sync** (or `ctx.upsertDef`) — the documented
  exception to "authored-only": the content is authored, just elsewhere. The
  runtime state stays out of it, in `sources/<id>.json`: `mirror:<defId>` (the
  revision mirrored — an unchanged one is no write), `revision:<defId>` (last
  handed to a WorkItem), `vanished:<defId>`.
- **One WorkItem per revision.** After mirroring, the daemon runs
  `enqueueRevision(defId, revision)`: a new revision enqueues once; an unchanged
  one never re-runs, however often it syncs; a revision that lands while an item
  is in flight waits for it and runs on the next sync. **Readiness** holds new
  revisions (mirrored, not enqueued, nothing stamped) until the daemon can
  enqueue again, like a Schedule's hold — no backlog, one run on recovery.
- **Vanished → archived, never deleted.** An item sync no longer reports has its
  mirror archived (its thread is history) and a still-READY item withdrawn; an
  in-flight one finishes. If it comes back it's restored. A mirror a *person*
  archived stays archived (its content kept current) and doesn't run.
- **Write-back.** `onComment` fires for every comment added to a mirror's thread
  (a person's, the teammate's completion summary, the daemon's `[retry]`), and
  `onItemTerminal` for COMPLETE, FAILED, and CANCELED (the agent, a person's
  cancel, a forced fail). Both are fire-and-forget: called right after the fact
  (so a closing comment arrives before the state change after it), an async
  hook's promise is never awaited, and a throw or rejection is logged — the
  agent protocol never waits on, or fails because of, the external system.
- **Isolation.** Each sync runs under `syncTimeoutMs` (default 30s) in
  `SyncRunner` (`daemon/sources/sync.ts`): a source that throws, rejects, times
  out, or returns garbage is logged and backed off (30s, doubling, capped at
  30 min; **Sync now** — `POST /api/work-sources/:id/sync` — ignores the
  backoff); a sync still running is never started twice; each source has its
  own timer and state, so one failing or slow source never stalls the daemon or
  another. (This is in-process isolation; running a plugin in a Worker or
  subprocess is part of the deferred package-loading work.)
- **A generic UI.** Each registered external source gets a read-only Work
  tab (`/work/source/<id>`): its mirrors with the external link, last
  revision, latest WorkItem state, and run count. A mirror's detail is the
  ordinary WorkDef page with editing off and **Open in <source>**. No source,
  no tab.

#### Triage mode: the mirror is the triage subject

A source can mark its items **triage-only** — `mode: "triage"` on the
`WorkSource`, or per item on its `ExternalDef` (the item's wins; default
`"work"`). A triage-mode item isn't worked; a teammate *triages* it, exactly as
Auto Triage does a note ("Auto Triage: a Note Is a Parent"): it posts an analysis
with `propose_work`, and you accept or reject each proposal. Accepting creates
the real work and never starts it; nothing ever runs the external item itself.
The motivating case is a ticket queue (a resolver group's tickets) you want
turned into proposed tasks rather than handed straight to a teammate.

- **The read-only mirror is the subject.** No container is created: the
  mirrored WorkDef's own thread (`comments.jsonl`) holds the analyses,
  proposals, and appended decisions — the same structured-comment model, the
  same fold. The created work's `origin` names the mirror (`{ workDef,
  proposal }`, frontmatter `originWorkDef`), as a note's names the note.
- **A new revision is the turn.** Enqueueing is unchanged — once per revision
  from the sync loop, behind readiness — so an item is re-triaged when it
  changes in the external system and never otherwise. **Run** on it is
  **Triage now**: force a run of the revision currently mirrored (the only way
  to retry a failed one).
- **The daemon owns how it runs.** The mode is recorded with the mirror (kv
  `mode:<defId>` in `sources/<id>.json`, refreshed on every sync — so it
  survives a restart and a source can flip it without a new revision). For a
  triage-mode mirror the daemon, not the source, decides the WorkItem title
  ("Triage: <title>"), its directory (the mirror's, else the leader's — the
  note rule), the prompt (`triage.md` / the default + the mirror's *current*
  content, open stories, earlier analyses, and what you decided), and Run
  (`daemon/sources/external-triage.ts`). The source's other hooks —
  eligibility, write-back of comments and terminal states — still apply; the
  analysis and decisions aren't comments, so nothing is written back about
  proposals (write-back of proposals is out of scope).
- **Decisions by WorkDef.** `propose_work` takes any triage subject's item
  (a note's container or a triage-mode mirror) and still refuses any other; the
  accept/reject routes for a mirror are `/api/work-defs/:id/triage/…`, sharing
  the note routes' logic.
- **The UI is the note's, on the mirror's page.** The mirrored WorkDef's page
  leads with a **Triage** tab — the item read-only with **Open in <source>**
  beside the same analysis/proposal components a note's triage page uses — and
  its Run is **Triage now**. Its row on the source's Work tab wears a note's
  triage badge, and a finished triage run lands in the Inbox linking to that
  tab. A question is answered where the item lives: a new revision is the turn.

*Why the mirror, not a container like a note's?* A note needs a container
because a note isn't a WorkDef; a mirror already is one, with a thread, and its
content is kept current by sync — which is exactly what the prompt should read.
Adding the mode is additive (optional fields), so `WORK_SOURCE_API_VERSION`
stays 1.

*Why pull only, and a mirror:* the external system stays the source of truth
for *what* the work is — two-way editing would need conflict resolution MPT has
no business owning — while MPT owns *running* it. A local copy (not a live
fetch at claim time) keeps a claim, a prompt, or the UI from depending on the
external system being up, and lets the thread live where every other thread does.
The revision is the source's own change marker, so "has it changed?" needs no
diffing and an etag works as well as a timestamp.

**Invariants** — what a source can't change, by construction:

- The daemon still owns the queue, leases, retries, readiness, and directory
  matching. A source decides *when* and contributes *what*; it never leases.
- Every WorkItem is created by the single `enqueueFor`; `ctx.enqueue` is it.
- Pending WorkDefs never enqueue (`enqueueFor` refuses them, whatever the source).
- `workdef.md` stays authored-only: a source's runtime state lives in its own
  files (a Schedule's `lastEnqueuedAt`/`heldForReadiness` in `schedules/<id>.json`,
  a note's `triagedVersion` in the note, anything else in `sources/<id>.json`).
- A source's failure is contained: a throwing `tick` is logged and the other
  sources still tick; a failing `onItemTerminal` or `onComment` never undoes the
  state change or the comment; a failing or slow `sync` backs only itself off.
- External sources are pull only: their WorkDefs are mirrors, written by sync alone.

*Why:* per-kind `if (def.parent?.kind === …)` branching was spread through
store.ts, features.ts, prompt.ts, and the routes, so adding a kind meant touching
all of them. Naming the hook points makes each kind one file, and makes "a kind
from somewhere else" a plugin rather than a fork — which "Plugin packages"
below makes real: third-party sources load from npm, git, or a local folder.

### Plugin packages: declared per team, like pi's

A team declares plugin packages in its own `config.json` — `packages`, per team
rather than per machine, because what a team pulls work from (its Jira project,
its tracker) is a property of the team. Each entry is a spec string or
`{ source, config }`, in pi's forms: `npm:<name>[@version]`; git as
`git:<host>/<path>[@ref]`, `https://…[@ref]`, or `ssh://…[@ref]` (the ref is
after the last `@` in the path, so `ssh://git@host/…` works); or a local path
(absolute, `./`, `../`, `~/`; relative to the team dir). `daemon/plugins/spec.ts`
parses them into npm / git / local specs, each with an **identity** — the npm
name, the git URL without ref or `.git`, the resolved absolute path — so
equivalent declarations load once (the first wins). A bad entry is a returned
error, logged and skipped; it never stops the daemon.

**Per-source settings.** The object form's `config` reaches every source the
package provides as `ctx.options()` (frozen; `{}` for built-ins and sources
registered in code without `options`). **Secrets are referenced, never inline:**
a source takes an env var *name* (`"tokenEnv": "JIRA_TOKEN"`) and reads
`process.env`, so config.json stays shareable.

#### Plugin settings: configSchema and preview

A plugin may *describe* its settings — `WorkSource.configSchema`, a plain JSON
Schema subset (an object of string / number / integer / boolean / enum /
string-array fields, nested objects one level deep) with UI hints (`title`,
`description`, `placeholder`, `default`, and `format: "env-var"` for a secret
reference, which must be a variable *name*) — so the Config page can render a
form instead of asking people to hand-edit JSON, and the daemon can say *which
field* is wrong. Why a subset and an in-house validator
(daemon/sources/config-schema.ts): a settings form needs nothing more, the
subset maps one-to-one onto inputs, and a full JSON Schema engine would be a
heavy dependency for it. A schema outside the subset is reported, not enforced.

**Where a source's settings live.** A package entry has one `config`, but a
package can ship several sources (MPTSimWorkSources: `sim-t` and `taskei`).
The model: **a schema per source, describing that source's block**, and
`configScope` says where the block is — `"package"` (the default; the whole
`config`, as every single-source plugin already reads it) or `"source"`
(`config[<sourceId>]`, the recommended layout for multi-source packages, and
what MPTSimWorkSources already reads). `ctx.options()` and a factory's
`options` stay the whole `config` either way, so no existing plugin or config
changes meaning; the scope only tells the daemon which part to validate, edit,
and write back (`withSourceConfigBlock` keeps the sibling sources' blocks).

**Validation never refuses a source.** At load the loader checks each source's
block against its schema and logs the mismatches (`[plugins] … warning:`),
recording them in `PluginLoadStatus.warnings`; the source still loads — it
may well cope (defaults), and refusing it would turn a typo into an outage.
Drafts are a different matter: a preview (and a save) of invalid settings is
refused with the field errors.

**Preview: what it would pull, with no side effects.** `WorkSource.preview(ctx,
draftOptions)` returns `{ items, warnings?, note? }` for draft settings,
before they're saved. No side effects is enforced, not just asked for:
`previewSource` (daemon/sources/preview.ts) hands the hook a restricted
context whose `options()` is the draft, whose `upsertDef` / `enqueue` /
`enqueueRevision` do nothing (logged, and surfaced as a warning), and whose kv
writes land in a scratch overlay that is thrown away. It's bounded by
`syncTimeoutMs`, and runs whether the source is on or off — checking settings
before switching a source on is the point. Without a `preview`, an external
source is previewed by running its `sync` on that context: right for a sync
that reads `ctx.options()` and has no side effects of its own. A plugin whose
sync writes elsewhere, pages through a kv cursor (it would see only the
delta), or captured its settings in its factory (the draft wouldn't reach it)
implements `preview`. Both are optional fields, so `apiVersion` stays 1.

**Installing** is `mpt plugins add|list|remove|update` (cli/plugins.ts), the
same split as pi's `pi install`: the CLI fetches and edits config.json, the
daemon only loads. npm and git packages go under `<teamDir>/packages/`, installed
with `--omit=peer` so the host package a plugin peer-depends on resolves to the
daemon's own copy. A package is validated (manifest present, entries exist)
before config.json changes, so a bad add leaves nothing behind. **Pinning**
follows the spec: an npm version or a git tag/commit is pinned and `update`
leaves it alone; no version, no ref, or a branch ref follows upstream.
**Build-system agnostic:** the contract for a git package is that it installs
and builds with plain npm against the user's configured registry, or ships its
`mpt.sources` entries prebuilt (committed) — MPT never detects Brazil or any
other build system. A prebuilt package with no runtime dependencies needs no npm
at all; a failed npm step quotes npm's stderr and restates the contract.

**Loading** (`daemon/plugins/loader.ts`) happens once, at startup — a change
needs a restart. A local path loads in place; an npm or git package loads from
the copy under `<teamDir>/packages/`. **Install on start, pi-style:** a
configured npm/git package whose install dir is missing (a fresh clone of the
team's config) is installed by the daemon before loading, through the same code
as `mpt plugins add` but without touching config.json — each on its own, bounded
by a timeout, attempted once per startup; a failure is that package's load
status and the rest still load. Local paths are never installed or modified. The package's package.json
`"mpt": { "sources": [...] }` lists entry files; other keys under `"mpt"` are
ignored, leaving room for plugin kinds that aren't Work Sources. Each entry is
`import()`ed and its default export is a `WorkSource` or a factory
`(options, { teamDir })` returning one. Plugins register after the built-ins
through the same registry checks (apiVersion, duplicate id, file-safe external
id), so a plugin can't shadow `task` or another plugin. **One bad plugin never
stops the daemon:** every failure — bad spec, missing install or manifest, a
throwing or hanging import or factory, a refused registration — is logged with
`[plugins]`, recorded in that package's status (`GET /api/work-sources`
`plugins`, `mpt doctor`), and skipped. Isolation is by error handling, not by
process: a plugin runs in the daemon with its permissions (TODO.md "Isolation").

**Host types, pi-style.** A plugin gets its types and constants from the host,
not from a copy of its own: it imports from `my-pizza-team/plugin` (the
package's `./plugin` subpath export, `plugin/index.ts` — the `WorkSource` /
`SourceContext` types and the types in their signatures, plus
`WORK_SOURCE_API_VERSION` and `SOURCE_ID_PATTERN`; nothing store-internal) and
declares `"peerDependencies": { "my-pizza-team": "*" }`. That is pi's model for
its extensions, and for the same reason: a bundled copy would carry stale
constants and types that drift from the daemon actually running it. Before the
first plugin import the loader registers a Node resolve hook
(`module.registerHooks`, daemon/plugins/host-resolve.ts) that answers
`my-pizza-team/plugin` with the running daemon's own module — so it resolves
for a plugin that installed nothing (installs use `--omit=peer`; a local folder
may have no `node_modules`), and a plugin that did install its own copy still
gets the host's. Types are erased at runtime, so only the constants actually
travel through the hook; the published `.d.ts` are for the author's editor and
`tsc`. GUIDE.md "Writing a Work Source plugin" is the author-facing version.

## Pending: Write, Review, Activate

A WorkDef can be saved as **pending**: written, read, and revised by you or the
assistant, but invisible to the machinery that turns work into WorkItems. Then
**Activate** ends pending, in one direction only, and locks the definition.
(Until this was renamed it was called a *draft*, and Activate was *Publish*;
see "Old spellings" below.)

- **A pending WorkDef never gets a WorkItem, and the refusal lives in one place.**
  `enqueueFor` is already the single WorkItem creator, so it refuses a pending
  WorkDef — which covers Run, the scheduler, board admission, a move into an
  agent state, boot-time reconcile, and re-enqueue, including any path added
  later. The routes and the scheduler also check for pending so they can give a
  clear reason (a Run on a pending WorkDef is a 409 that says "activate it first";
  a pending cron child doesn't hold its schedule for readiness).
- **On the board a pending task holds its place.** Admission takes a story's next
  `todo` task in order. If that task is pending, nothing is admitted and the story
  waits. Tasks in a story are *sequential*: step N+1 may assume step N's commit,
  so skipping past a pending task would run work out of order — the failure CONWIP
  exists to prevent. A pending task dragged straight into an agent state keeps the
  CONWIP token with no WorkItem, which is the same "hold" made visible on its card.
- **Activating hands it to its parent's normal rule** rather than inventing a
  new one: a Solitary task is enqueued (the default for creating one;
  `enqueue: false` activates without running), a board task re-runs admission (or,
  if it already sits in an agent state, gets its WorkItem there), and a Scheduled
  job waits for its next cron firing.
- **Active means locked.** After activating, a PUT that touches the
  definition (title, goal, criteria, context, directory) is refused. The
  definition is what a WorkItem *ran*: editing it afterwards would make the thread
  and Inbox describe work nobody did. Revisions go where they already went —
  a comment on the thread, then Run (or a move back into an agent state), so the
  next attempt's prompt carries the change on top of an unchanged definition. A
  scheduled job's cron lives on its Schedule, not the definition, so it stays
  editable.
- **Absent means active.** Only pending WorkDefs write `pending: true`, so every
  WorkDef from before pending existed is active with no migration. Triage
  containers are never pending — their note is their definition.
- **The assistant writes pending work; you activate it.** `add_task`,
  `create_task`, and `create_schedule` take `pending`, and `get_task` /
  `edit_task` revise a pending task, so the assistant can write work up for
  review. `activate_task` exists, but its guidance is to use it only when you
  ask: the point of pending is that a human reads it first.
- **Old spellings.** A `workdef.md` with the pre-rename `draft: true` loads as
  pending and is rewritten as `pending: true` on its next save — no migration
  pass. For one release the API also accepts `draft: true` in create requests
  (WorkDefs, board tasks, a story's inline `tasks[]`) and `POST
  /api/work-defs/:id/publish` as aliases, so an older Pi extension keeps working
  against a newer daemon; responses only carry `pending`. Both aliases go in the
  next release.

*Why a flag and not another parent or a separate store?* A pending WorkDef is the
same authored document in the same place, with the same thread and attachments:
you may want to discuss it before it runs. Only *whether its parent may enqueue
it* changes, and that is exactly the one question `enqueueFor` answers.

### Pending stories: the same word, reversible

A story has the same three-stage lifecycle as everything else — **pending →
active → archived** — but for a story pending is a **hold**, so it goes both ways
(active ⇄ pending). It replaced two older mechanisms: the story `paused` flag and
the **backlog** (a `backlog/` directory a story — and every story that
transitively depended on it — was moved into).

- **Pending stops new work, not running work.** `runAdmission` admits nothing
  for a pending story and `getNextWorkItem` never offers its READY items. A task
  already IN_PROGRESS is left alone: it finishes, its COMPLETE advances it as
  usual, and a READY item that advance creates simply waits. Cancelling the
  in-flight run would throw away work for no gain; the hold is about what comes
  *next*.
- **Dependents just wait.** A story that `dependsOn` a pending story isn't ready
  (its dependency isn't done), so it waits on the board where it is. The backlog
  instead moved the whole dependency chain off the board so nothing looked
  broken; a waiting dependent isn't broken, and moving it lost its place.
- **A flag in `stories/<id>.json`, not a directory.** Pending is a state of a
  live story, so it stays in `stories/`, loaded and indexed like any other — a
  pending story is just a row on Work → **Pending**, and toggling is one field
  write, not a file move plus a reload. The UI, API (`pending` on create/PUT,
  `POST …/pending|activate`), and the assistant's `create_story` / `edit_story`
  all say *pending*.
- **Migrated on load, once.** `loadFromDisk` first rewrites old files
  (`store/story-migration.ts`): `paused: true` → `pending: true`, and
  `backlog/<id>.json` back to `stories/` as pending with `backloggedAt` dropped
  (a board task's WorkDef never moved, so nothing else is needed). Old fields and
  the empty directory are removed, so it's idempotent. A backlog file whose id is
  already a live story is left alone and warned about — never clobber live work.
  For one release the API also accepts `paused` as an alias of `pending`.

### Pending schedules: reversible, no catch-up

A **Schedule** (the cron parent of a Scheduled job) is pending the way a story
is: a reversible hold (active ⇄ pending), a `pending: true` field in
`schedules/<id>.json`. It is how you pause a recurring job without deleting it.

- **Two flags, one rule: a job fires only when both are active.** The Schedule's
  `pending` is the reversible "don't fire" switch; the child WorkDef's `pending`
  is the one-way "definition still under review" state from above. Either one
  stops the job. They're checked in that order — `runScheduler` skips a pending
  Schedule outright, then leaves pending children out of an active Schedule's
  firing — so a pending Schedule wins over any active child, and a pending child
  never fires through an active Schedule. Creating a job "as pending" (New
  Scheduled Job's **Save as pending**, `create_schedule` with `pending: true`)
  still means a pending *definition*: that's the reviewable, editable state, and
  its one **Activate** is all it takes to start. The Schedule toggle (**Make
  pending / Activate** on the Schedule page and the job's page, `POST
  /api/schedules/:id/pending|activate`, the assistant's `set_schedule_pending`)
  is for pausing and resuming an active job afterwards. **Run now** is a manual
  run, not the cron, so a pending Schedule doesn't block it (a pending
  definition does).
- **Pending means invisible to the scheduler.** No cron firing, no
  `lastEnqueuedAt` advance, and no readiness hold — a held occurrence is cleared
  the moment the Schedule goes pending, so it can't come back as a catch-up run.
- **Reactivating resumes at the next occurrence; nothing is back-filled.** The
  scheduler never replays missed minutes anyway (`isCronDue` only asks "does
  *this* minute match?"), but two edges could still fire something skipped:
  the held-for-readiness marker (cleared above) and the activation minute itself
  (a 09:00 cron activated at 09:00:20 would otherwise fire on the 09:00:30 tick,
  though 09:00 was passed over while pending). So activating stamps
  `resumedAt`, and the cron cursor is the later of `lastEnqueuedAt` and
  `resumedAt`: only a minute strictly after it can fire. A week of pending is
  zero runs, then the next scheduled one.
- **Absent means active.** Schedules written before this have no `pending`
  field and keep firing; there is nothing to migrate.

## Execution Count: Derived, not Counted

Every WorkDef view carries `executionCount` — how many WorkItems were created for
it — and `lastRunAt`, the latest one's enqueue time. The Tasks page uses them to
find the work nobody has started yet: count 0 is "never run".

- **Derived from `work_items`, never stored.** `enqueueFor` is already the single
  WorkItem creator, so the WorkItem table *is* the record of every run; one
  `GROUP BY work_def_id` (indexed) answers the whole list in a single query. A
  stored counter would be a second copy that has to be kept in step on every
  enqueue, cancel, and delete, and the obvious place for it — `workdef.md` — is
  off limits by the "authored content only" invariant ("WorkDefs & Parents").
- **CANCELED doesn't count; everything else does.** A cancel withdraws an attempt
  (a human cancels a READY item; a board move cancels the item it supersedes), so
  it isn't a run of the work. READY and in-flight items *do* count: work that is
  queued or running is not "something to do". FAILED counts — it ran.
- **Archiving changes nothing.** An archived WorkDef keeps its count; the lists
  already decide whether to show archived defs.
- **It is as durable as the WorkItem table.** WorkItems are runtime state in
  `state.db`, kept across restarts but not rebuilt from the team dir (the same
  holds for the Inbox's history). Deleting `state.db` resets every count to 0,
  which is acceptable for a sort/filter aid; the usage ledger remains the durable
  record of what ran.
- **Templates have none.** A template never emits WorkItems ("Task Templates").

## Auto Triage: a Note Is a Parent

A teammate reads each note you've changed and replies with an analysis of it. The
note is the parent that enqueues that work, so triage needed no new machinery: the
thread, attachments, usage, and the Inbox entry are a WorkDef's, and "whose turn is
it" is answered by the note itself.

**The subject is a note or a triage-mode mirror.** Everything below is written
for a note, the first subject, but the machinery is about a *triage subject*: a
WorkDef whose thread holds analyses, proposals, and decisions, and whose content
the prompt reads fresh at claim time. There are two kinds (`triageSubjectOf`):

| | A note | A triage-mode external item |
|---|---|---|
| The WorkDef | `triage-<noteId>`, a container created lazily | the read-only mirror `<source>~<id>` itself |
| Content in the prompt | the note's current text | the mirror's current content (kept current by sync) |
| The turn | you edit the note (a new version, past the quiet period) | the item changes in its source (a new revision) |
| Enqueued by | the hourly sweep (`ThoughtSource.tick`) | the sync loop, once per revision (`enqueueRevision`) |
| Created work's origin | `{ thought, proposal }` | `{ workDef, proposal }` |
| Where you decide | `/thoughts/:id/triage` | the mirror's **Triage** tab |

The instructions (`triage.md`), `propose_work` and its validation, the
structured-comment + appended-decision model, the fold, the badge, "accepting
creates, never starts", and the Inbox row are shared, not duplicated.

*Why the mirror's revision is the turn.* The turn rule exists so a subject is
re-read when *you* have said something new, and never otherwise. For a note that
signal is its text moving on; for an external item the only thing that can say
something new is the external system, and its revision is already exactly that
marker — the one the sync loop uses to run a work-mode item once per
revision. Reusing it means no second cursor, no sweep, and no quiet period (the
source decides when an item is "done being edited" by when it reports a new
revision), and the same readiness hold and "an in-flight run defers the next
revision" rules apply for free. It also tells you where to answer a question:
in the item's source, since the mirror is read-only. Details in "External
sources" — "Triage mode: the mirror is the triage subject".

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

*Being deprecated:* the web UI no longer shows templates — no Templates tab, no
"task from template" entry point. The daemon's template API and files are left
as they are until the deprecation finishes.

## Work: One Surface, Lifecycle Tabs

Board, Tasks, and Schedule were three nav items; they are now sub-tabs of one
**Work** item, next to **Pending** and **Archived**. The kind tabs (Board,
Tasks, Schedule) show **active** work only; Pending and Archived gather every
kind's held and retired work in one place.

*Why:* "what's waiting for me to activate?" and "where did that retired job go?"
are questions about lifecycle, not kind. Answering them per kind meant a Pending
tab for stories, a filter for tasks, a badge for schedules, and an Archived drawer
on two pages. Splitting by lifecycle once keeps every kind tab about the work in
play, and each tab hides with its feature toggle (Pending/Archived while any kind
is on; the nav item when none is). Pending and Archived are each **one list**,
not a section per kind: a type badge and filter chips carry the kind, so the
list reads newest first across everything.

## Feature Toggles: Start Small, Never Strand Work

A team can switch the **Stories**, **Tasks** (Solitary tasks and Templates), and
**Schedules** kinds off in `config.features`. Thoughts, Context, and the Inbox are
always on, so "everything off" is still a working team: notes in, triage out.

- **New teams start with Tasks only; existing teams keep everything.** A missing
  `features` block means *all on*, so no team loses a kind it was using and nothing
  is migrated. Only `mpt setup`, creating a team, writes the small default. That's
  why the block isn't in `DEFAULT_CONFIG`: defaults are merged under every existing
  config, where it would silently switch kinds off.
- **Off is enforced by the daemon, in one place.** The UI hides, but the API
  refuses (daemon/features.ts, middleware ahead of every route), so the CLI, the Pi
  tools, and a stale browser tab all hit the same wall with the same message. It's a
  403, not a 404: the client must be able to say "switched off", not "missing".
- **Switching off requires the kind to be empty.** Hiding live work would strand
  it — a story nobody can see still holds teammates and its queue slot. So turning a
  kind off is refused while it has active items and names how many to archive or
  delete; archived items don't count, since they're history, not work.
- **What's already running finishes.** The queue, the Inbox, the agent protocol,
  and a WorkDef's thread are never gated. The guard makes this rare (a kind is only
  turned off empty), but a hand-edited config must not leave a claimed item unable
  to complete.
- **The assistant isn't offered what's off.** The daemon's refusal is the
  backstop, but a model shown `create_story` will reach for it, so the Pi leader
  drops a switched-off kind's tools from its active tool set and says in its system
  prompt what's off. It polls `/api/status` (before every run, and every 10s)
  rather than being pushed a change: it already reads status, and a toggle flip is
  rare. Every client words the refusal the same way — "Stories are disabled —
  enable them in Config (features.stories)" — so the fix is always named.
- **The UI hides entry points and explains dead ends.** Nav links, quick-create,
  and triage Accept drop out for a disabled kind, but its pages show a "turned off —
  enable it in Config" notice rather than redirecting: a bookmark or an Inbox link
  should say why it's gone, not silently land somewhere else. The Config page asks
  for the active-item counts up front, so the toggle you can't turn off is greyed
  out with what to clear, instead of failing on Save.
- **A toggle belongs to a Work Source, not a hard-coded kind.** Each source may
  declare a `toggle` (daemon/sources/types.ts `SourceToggle`): its `features.<name>`
  key, any extra routes to gate, and an optional `activeItems()` that counts what
  blocks switching it off (default: its non-archived WorkDefs). daemon/features.ts
  reads only the registry: the 403 gate (the source's routes, plus its WorkDefs
  under `/api/work-defs`), hiding its WorkDefs from the list, the 409 turn-off
  guard, and the `features` / `featureUsage` that `/api/status` and `/api/config`
  report. So a plugin source gets on/off for free. The built-ins keep their
  historical keys — story → `stories`, task → `tasks` (which also owns Templates),
  schedule → `schedules` — so configs read exactly as before and nothing is
  migrated; Thought declares no toggle, so it can't be switched off. A flag for a
  source that isn't registered is left alone on disk but isn't accepted in a PUT.
- **Every external source is switchable by default.** A source that declares
  `sync` and no `toggle` gets `{ feature: <its id> }` from the registry
  (daemon/sources/registry.ts `effectiveToggle`), gating its
  `/api/work-sources/<id>/defs` and `/sync` routes — so a team can stop a
  plugin without uninstalling it. The effective toggle lives on the registry
  *entry*, never written onto the plugin's (possibly frozen) object; `toggle:
  null` opts out (always on). Additive, so `WORK_SOURCE_API_VERSION` stays 1.
  Feature names are one flag each: a built-in's name (`stories`, `tasks`,
  `schedules`) is reserved for that built-in, and a name another source
  already uses is refused — registration throws, the plugin loader logs it and
  records the package's error, like a duplicate id. Silently namespacing would
  have meant a config key the author never wrote.
- **Off means disconnected, not just hidden.** A switched-off external source
  isn't synced (even **Sync now** is refused), isn't ticked, and its
  `ctx.upsertDef` / `enqueue` / `enqueueRevision` do nothing, so no path brings
  in new mirrors or WorkItems; a sync already in flight has its result dropped.
  In-flight WorkItems still finish (the agent protocol is never gated). Its
  timer keeps running, so switching it back on resumes on the next interval —
  and a `PUT /api/config` that turns it on also syncs it at once.
- **Disconnecting is the one opt-in past the guard, for external sources only.**
  A mirror isn't yours to archive one by one — sync owns it — so the 409
  would leave an external source with live mirrors stuck on. `POST
  /api/work-sources/:id/disconnect` (rather than a flag on `PUT /api/config`:
  it's one explicit action with its own confirm, it needs none of the config
  body, and the CLI or a script can call it alone) switches the feature off
  *first* — so an in-flight sync can't re-mirror — then archives, never
  deletes, every non-archived mirror, cancels their READY items (write-back
  sees CANCELED, as for a vanished item) and leaves IN_PROGRESS/MORIBUND ones
  to finish, and saves config.json. Each archived mirror is marked
  `disconnected:<defId>` in the source's kv, so switching the source back on
  restores those the source still reports — like a vanished item coming back —
  without re-running a revision already handed over; one a person archived
  stays archived. Without the opt-in the 409 stands (its message names the
  route); the built-ins keep exactly the old guard.
- **The Config page lists what the server says is switchable.** `GET
  /api/config` carries `featureSources` (each toggle's source, label, and
  whether it's external) next to `featureUsage`, so the Work items list is the
  built-ins under their own labels plus each plugin source under its `label`,
  with no hard-coded names. A locked external source offers **Turn off and
  archive N items** behind a confirm dialog. A switched-off source's Work tab
  hides and its page shows the "turned off" notice (`/api/status`
  `externalSources[].feature`).

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
live in one repo, the root `package.json` owns the version, `harnesses/pi/package.json` (and
`package-lock.json`) are generated from it (`npm run sync-version`, enforced by `tests/version.test.ts`),
shared constants are generated into the extension (`npm run sync-shared`), and the
`mpt` npm package **ships the extension's source** and writes it out on `mpt setup`.

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

**`mpt upgrade` moves both halves.** After `npm install -g` (with the configured
Node's own npm — see "One Node, Saved Once") it rewrites the managed extension by
invoking the **newly installed** copy (the hidden `mpt write-extension-internal`) —
the running process still carries the old bundled copy. Pi loads a local package from its path without copying, so no
re-registration or `npm install` is needed (the extension has no `dependencies`;
its peers are supplied by Pi). Only an existing managed directory is refreshed: a
developer on a registered checkout, or someone who never ran setup, doesn't get a
managed install created behind their back. Running agents keep the old code until
their Pi restarts, which the handshake surfaces.

**One Node, saved once.** mpt is `<node> <package entry>`, and several things
outlive the shell that installed it: the launchd/systemd service, teammate
callbacks (`{mpt}`), the next `mpt upgrade`. They must agree on a Node that will
still exist next month, so the choice is asked once (setup/install/upgrade) and
saved to `~/.config/mpt/runtime.json`, with `MPT_NODE`/`--node` as overrides. The
path is kept as typed, never symlink-resolved — `/opt/homebrew/bin/node` survives
`brew upgrade`, its Cellar target doesn't — and version-manager paths (nvm, fnm,
volta, …) are warned about, not refused. Upgrades use *that* Node's npm, because a
global install only lands where the service looks if the same Node's npm did it.

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

## Moving Old Binaries Across

Up to 0.27 mpt was one compiled binary, and its `mpt upgrade` replaced itself with
`mpt-<os>-<arch>` from the latest GitHub Release. From 0.28 mpt is an npm package
run by Node, and there is no binary to download — yet that old upgrader is the one
thing every old install will run. So rather than leave those installs stuck with a
404 and a manual migration, **each release publishes `scripts/legacy-bridge.sh`
under the old asset names** (with a `checksums.sha256`, which the old upgrader
verifies). The upgrader writes it over the binary without knowing the difference,
and its follow-up calls — `<path> write-extension-internal`, then a service that
runs `<path> start` — land on the bridge, which installs the package with the
found Node's own npm and execs it. The old path keeps working, so nothing that
remembered it (the service, scripts, a teammate's callback) breaks.

- **Never leave an mpt that doesn't run.** The upgrader has already replaced the
  binary before the bridge first runs, so every failure — no Node >=24, npm can't
  write its prefix, run under sudo — ends with the bridge putting the
  checksum-verified v0.27.0 binary back over itself and running that, after saying
  what to fix. A machine without Node stays on 0.27 instead of losing its daemon.
- **It never installs Node.** It uses one that is there (`MPT_NODE`, the saved
  `runtime.json`, PATH, the usual locations). Silently installing a runtime is a
  bigger decision than an upgrade should make.
- **The service is re-pointed only from a terminal.** An old service has a bare
  PATH, so it can run the bridge (which finds Node itself) but not npm's
  `#!/usr/bin/env node` link. From a terminal, `adopt-legacy-internal` rewrites the
  service to `<node> <entry> start`; run *by* the service, the bridge leaves the
  file alone rather than rewrite the job running it. When npm's `mpt` link lands on
  the bridge's own path (an npm prefix of `/usr/local`), npm must replace it
  (`--force`), which only happens from a terminal, where the service is re-pointed
  in the same breath; the service itself falls back to 0.27 and says to upgrade
  from a terminal.
- **The bridge is a shim, and says so.** `mpt doctor` recognises it on PATH or as
  the service's program, says it works, and names the cleanup (`rm` it once npm's
  `mpt` is on PATH; `mpt install`).
- **No Windows.** A shell script can't stand in for `mpt-windows-x64.exe`; Windows
  installs move across by hand.

## The Daemon Is the Supervisor

The daemon owns tmux: it creates the session, opens a window per teammate, types
the harness's start command into it, and kills it on dismiss. Start commands are
**team config** (`harnesses.<name>.teammate` / `.leader`, with built-in defaults
for Pi), not extension code.

A dismiss closes the window, but only after the agent has exited by itself (or a
grace period ran out), with C-c before the kill and never in the same breath: the
agent gets to flush. Only a dismiss closes a window. A teammate that crashes or is
quit keeps its window, because the error on screen is the most useful thing left.

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
- **Only the scheduler — and automatic retries — are gated.** Solitary and board
  work are human-initiated and still run (and may fail visibly). A retry of an
  errored session (see "Errored Sessions Retry") waits for ready before it's
  handed out.

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
   the mode's framing — in chat mode `ASSISTANT_CHAT_FRAMING` (be brief, blank lines separate bubbles, the user may
   interrupt) followed by the persona body or `DEFAULT_ASSISTANT_PERSONA`. Personas
   are about voice and role, never delivery mechanics.
8. **The UI is a toggle; the framing follows it.** `assistant.chatMode` in
   config.json picks how the user sees the assistant: `chat` (the bubbles above,
   the default — missing or invalid reads as `chat`, so no existing team changes)
   or `terminal`, which is *exactly* the teammate watch/pair experience (see
   "Watching and Pairing with a Teammate") through one shared code path — not an
   assistant-only lookalike. Bubble instructions would be noise in a transcript,
   so terminal mode swaps `ASSISTANT_CHAT_FRAMING` for the short
   `ASSISTANT_TERMINAL_FRAMING` (the user may interrupt; nothing about bubbles).
   The switch is live: the daemon composes the prompt from config per request
   and the leader refetches it in `before_agent_start`, so the next run uses the
   new framing with no restart or session reset — the conversation is the same
   Pi session either way; only how it is shown changes. The UI reads the mode
   from `/api/status` (refetched the moment Config saves).
9. **Terminal mode is the teammate pipeline, not a copy of it.** The leader wires
   its session with the same `attachTranscriptMirror` a teammate uses
   (harnesses/pi/src/session-transcript.ts), the daemon stores and streams it
   through the same transcript store and routes keyed by agent id, and the dock
   renders the same `AgentTerminal` (TranscriptView + PairComposer) as a
   teammate's page — so entry kinds, clipping, collapse, watch semantics (only
   while watched, no backfill) and live streaming are the same by construction;
   a difference is a bug. The leader's mirror runs in both modes (unwatched it
   costs nothing), which is why switching needs no restart. **The one
   deliberate difference is input.** A teammate's composer opens only after
   *Pair*, because pairing pauses its work loop and release settles its held
   work item; the leader has neither, so its composer is always open and
   `POST /api/agents/<leader>/messages` skips pairing. Its messages go to the
   assistant inbox — how the leader receives every chat message, so the
   conversation record, receipts, and session history stay whole whichever
   mode you use — carrying the composer's `queue`/`steer` mode, and the leader
   hands them to Pi with the same `deliverWebMessage` a paired teammate uses
   (tagged `web`; queue → followUp, steer → steer mid-run). Chat-composer
   messages carry no mode and are steered, as before. Reading an *earlier*
   session always shows the chat record, since a transcript has no history.

---

## The Shell: a Dock and a Center

The app is two columns: a **dock** on the left for the things you keep an eye on
*while* looking at something else, and a **center** that shows one thing at a
time.

| Column | What's there |
| --- | --- |
| **Dock** (`SideDock`) — a header, then two tabs | Header: `+` (New Story / Solitary Task / Scheduled Job) then the queue summary. Tabs: **Assistant** (the chat with the leader) and **Team** (the teammates; team size, spawn) |
| **Center** (nav + `<main>`) | board, tasks, schedule, thoughts, task detail, inbox, a teammate's live view, config (incl. workflows and context) |

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

**A page's section is what it *is*, not its URL.** `/work-defs/:id` is shared by
standalone work and triage runs, so the nav lights the item for the WorkDef's type
(Solitary/Scheduled → Work, Triage → Thoughts). **Back means back**: it returns to the
page you came from (router history); only with no in-app history (a fresh tab)
does it fall back — to that same section's list — and pages you've just created
or deleted replace their history entry so Back never lands on a stale form or a
deleted item (`ui/src/lib/nav-section.ts`).

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
made a real run look like three tokens. The ledger and API keep all four parts,
but the dashboard's token figures **leave out cache reads by default** — they're
cheap and dwarf the rest on long sessions — with an "Include cached" toggle to add
them back (computed client-side from the separate fields; the tooltip always shows
all four). Cost is the harness's own cache-aware
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

The assistant's terminal mode (`assistant.chatMode: "terminal"`) is this very
view pointed at the leader — see "Assistant Chat Model" item 9 for the one
input difference (no Pair step: the leader has no work loop to pause).

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

- **`npm test`** is the inner loop and stays fast (seconds). It uses a
  `TEST_CONFIG` with autosave off, because a Store with autosave on reaches real
  git.
- **`npm run test:e2e`** drives the real CLI, real git, and real tmux in a
  sandbox — isolated `MPT_HOME`, `PI_CODING_AGENT_DIR`, team dir, and a private tmux
  server (`TMUX_TMPDIR`) — torn down even on failure. **No test touches real
  configuration**, enforced by construction rather than care.
- A test that skips must skip for the *expected* reason (tmux genuinely absent,
  not a permission error), and that is asserted.
- Suites are checked by mutation: green on first run is a reason for suspicion, so
  new tests are verified by deliberately breaking the code they guard.
- No LLM is in the loop, so these test mpt's mechanics — windows, settings files,
  directives, exit codes. Whether a teammate does good work is exercised by hand
  with `mpt-demo-team`.

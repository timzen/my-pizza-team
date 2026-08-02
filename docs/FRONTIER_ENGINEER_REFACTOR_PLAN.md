# Frontier Refactor — Implementation Plan

Companion to [FRONTIER_ENGINEER_REFACTOR.md](FRONTIER_ENGINEER_REFACTOR.md). That
doc states the intent; this one is the grounded implementation plan after tracing
the real code across the daemon, UI, and the pi-pizza-team harness.

> **Revision 2** — updated after Tim's first review. Decisions he made are folded
> into the model below and logged under **Resolved Decisions**. New questions that
> fall out of those decisions are under **Open Questions**.

---

## The core architectural question: does the agent contract change?

The refactor introduces a `WorkItem` queue that `/api/agents/next-work` pulls
from, plus new work sources (**solitary** and **scheduled**) that are **not** part
of a story. Today everything agent-facing is **task-centric** (`claim/:taskId`,
`done/:taskId`, `/api/tasks/:id/token-usage`, `/api/tasks/:id/attachments`,
`/api/agents/comments/:taskId`) and the prompt/matching pipeline is **story-based**.

Key finding from tracing `pi-pizza-team/src/teammate.ts`: the harness treats
`response.task.id` as an **opaque string** it forwards to claim/done/comment/
token-usage/attachment. It does **not** use `storyId` in the work loop.

**Decision (resolved): make the contract `WorkItem`-centric and update
pi-pizza-team.** A `WorkItem` becomes the single universal unit of agent
execution; its polymorphic `ref` points at a story-task or a WorkDef. The harness
never needs to know which. This extends the existing "The Daemon Owns the Prompt"
principle. `mpt-mcp-server` is out of scope.

---

## The model in one paragraph

A **`WorkDef`** is a durable *definition* of work (its `type` is `Solitary`,
`Scheduled`, or — future — `Story`). A **`WorkItem`** is a **dumb, single
attempt** to execute some work: it holds only scheduling/identity data and moves
**only toward a terminal state**. WorkItems *drive* task flow: the daemon reacts
to a WorkItem reaching a terminal state. All the rich detail — goal, acceptance
criteria, comments, results — lives on the **ref** (the WorkDef or the story
task), never on the WorkItem.

---

## Data model (daemon)

### 1. `WorkItem` — the queue entry (dumb, terminal-only)

```
WorkItem {
  id: string (guid)
  title: string                      // denormalized for list/sidebar/inbox
  ref: { kind: "task", storyId, taskId }
     | { kind: "workdef", workDefId }
  state: READY | IN_PROGRESS | COMPLETE | CANCELED | FAILED
  read: boolean                      // Inbox unread filter (a notification concern)
  enqueuedAt / lastStateChangeAt: epoch ms
  memberId?: string                  // who is/was working it
}
```

No `result` field — the completion/failure **summary is posted as a comment on
the ref** (the WorkDef or the task). The WorkItem stays a "dumb" scheduling
record; the ref owns all detail.

**States.** Non-terminal: `READY`, `IN_PROGRESS`, `MORIBUND`. Terminal:
`COMPLETE`, `FAILED`, `CANCELED`. A WorkItem only ever **terminates** via
COMPLETE/FAILED/CANCELED; `MORIBUND` is a non-terminal "the agent went quiet, but
it isn't dead yet" annotation on an in-flight attempt.

**Transitions:**

- `READY → IN_PROGRESS`         (agent claims)
- `READY → CANCELED`            (human cancels a not-yet-started item)
- `IN_PROGRESS → COMPLETE`      (agent set it complete)
- `IN_PROGRESS → FAILED`        (agent set it failed — see "No `return`" below)
- `IN_PROGRESS → MORIBUND`      (reaper: the owning agent's heartbeat went silent)
- `MORIBUND → IN_PROGRESS`      (the owning agent's heartbeat resumed — it's alive)
- `MORIBUND → COMPLETE|FAILED` (the agent came back and finished, or the human force-fails it)

**No `return`.** There is no bundled give-up transition. "Give up" was just
"post a comment **and** mark this attempt failed" — two primitives the agent can
compose itself. The daemon exposes only the primitives (a comment endpoint and a
WorkItem state-setter); the harness may offer the LLM a convenience *fail* tool
that calls both, but the daemon encapsulates nothing. On a normal `agent_end` the
harness sets `COMPLETE`; the agent explicitly sets `FAILED` (with a comment) when
it's giving up.

**No re-open.** Terminal is terminal. To try again a human creates a **new**
WorkItem for the same ref ("re-enqueue").

### 2. `WorkDef` — the durable work definition

```
WorkDef {
  id, title,
  type: "Solitary" | "Scheduled",   // future: "Story"
  goal: string,                      // what to achieve
  acceptanceCriteria: string,        // MUST/SHOULD/MAY bullets (RFC 2119)
  additionalContext?: string,        // freeform markdown
  contextRefs?: string[],            // selected existing context-library entries
  directory?: string,                // optional working dir (affinity bias — see Matching)
  cron?: string,                     // required when type === "Scheduled"
  lastEnqueuedAt?: string
}
```

- **UI labels:** "Story Task" (story-backed), "Solitary Task" (`type: Solitary`),
  "Scheduled Task" (`type: Scheduled`).
- The `type: "Story"` value is reserved for a future step that would fold
  today's story subtasks into WorkDefs; not built now.
- Stored as **markdown + frontmatter** (reusing `shared/frontmatter.ts`):
  frontmatter = `type/title/cron/directory/contextRefs`; body = goal +
  acceptance + additional context. Under a new top-level `.my-pizza-team/tasks/`
  dir. Loaded into SQLite at startup like stories/tasks.

### 3. Comments / attachments — on the ref (per-def)

Reuse the existing `comments.jsonl` + attachments mechanism, always keyed to the
**ref**, never the WorkItem:

- **Story-task refs** → the backing task's `comments.jsonl` (unchanged).
- **WorkDef refs** → the WorkDef's own `comments.jsonl`. A scheduled def
  therefore accumulates **one completion/failure comment per run** (per-def),
  timestamped — the run history reads as a comment thread on the def.

---

## Control flow: the WorkItem drives the task (inverted from rev 1)

The WorkItem is the *driver*, not a derived mirror of task substatus. CONWIP
admission still decides **which** task per story is active; the WorkItem lifecycle
decides **what happens** to it.

1. **Task lands in an agent state** (via admission, advance, or a judgment move)
   → the daemon **creates a `READY` WorkItem** (`ref.kind = "task"`) for it.
2. Agent claims → `IN_PROGRESS`. Agent finishes → `COMPLETE`.
3. **Daemon reacts to the terminal WorkItem:**
   - `COMPLETE` → advance the task to its next workflow state (which may create
     the next agent-state WorkItem, or hand off to a manual state, or reach
     `done` and free the CONWIP token → admit the next task).
   - `FAILED` / `CANCELED` → the task **stays put** in its agent state with **no
     active WorkItem**. It is "stuck" until a human addresses it: **re-enqueue**
     (create a fresh WorkItem), move it (judgment move), or edit it.
   - `MORIBUND` is **not** terminal — the task stays owned/in-flight and the
     daemon takes no flow action. It's a health flag (see "Reaping → MORIBUND").
4. **Solitary / Scheduled WorkDefs** create WorkItems explicitly (on enqueue / on
   a cron tick); a terminal WorkItem for a WorkDef ref touches no CONWIP token —
   it just records the outcome as a comment on the def.

A task in an agent state with no `READY`/`IN_PROGRESS`/`MORIBUND` WorkItem is the
visible "needs attention" state that the UI exposes a **Re-enqueue** button for.

### Reaping → MORIBUND (honest, not a guess)

A claim is a *lease* kept alive by agent heartbeats. When `reapOfflineAgents`
(existing timer, `agentTimeoutSeconds`, default 90s) sees a silent agent, it marks
the agent offline **but does not release its work or declare failure** — it moves
the agent's `IN_PROGRESS` items to `MORIBUND` and keeps the lease. This avoids the
old guess ("the agent is gone, hand its work to someone else"), which risks two
agents doing the same work on a false-positive reap.

From MORIBUND:
- **The agent comes back** (heartbeat resumes) → the daemon restores its MORIBUND
  items to `IN_PROGRESS`; the still-running agent finishes normally
  (COMPLETE/FAILED). No human action needed.
- **The human gives up on it** → a **force-fail** action (MORIBUND → FAILED),
  optionally combined with re-enqueue (create a fresh READY item for the ref).

MORIBUND items are never offered by `next-work` (they're still owned/in-flight).

**No more `substatus`.** The task `substatus` (`ready`/`claimed`) is retired — the
active WorkItem is now the single source of truth for within-state position. The
board chip is derived: `READY`⇒"ready", `IN_PROGRESS`⇒"claimed",
`MORIBUND`⇒"at risk", no active item with a prior `FAILED`⇒"needs attention".
This drops the `substatus` column/field and updates WORK-MODEL.md and the board
accordingly.

**Matching = directory affinity bias, not a filter.** Capability/`requirements`
matching is **removed** (see "Removed" below), and so is the `assigned-story`
work mode (see "Removed") — all teammates are now a flat pool of generalists. The
only signal is an optional working `directory` on the story/WorkDef, used as a
*preference*, never a gate. Every agent has its own working directory (its pi cwd,
set at spawn). On each poll, `getNextWorkItem(agent)` picks the oldest READY item
the agent is eligible for (only `paused` now gates it) by **priority tier**:

1. item `directory` == agent `directory`  *(my repo's work — highest)*
2. item has **no** `directory`  *(anyone's to grab)*
3. item `directory` != agent `directory` **and no online agent has that
   directory**  *(nobody's coming for it — fallback; the agent `cd`s and may fail
   if the dir isn't reachable)*

Tier 3 is **presence-based, not time-based**: if the daemon knows an online agent
with the matching directory exists, the item simply waits for that agent to free
up — no other agent grabs it. Only when no such agent is present does the work
fall through to anyone. (A busy-but-online matching agent still reserves the item;
an offline/MORIBUND one does not.)

Directories are compared via `normalizeDirectory()`; because matching is only a
*bias*, a false-negative (symlink/mount/`~` variant) merely loses the preference
— it never strands work. That's what retires the path-string bug class that made
WORK-MODEL.md avoid directory matching in the first place.

---

## Daemon changes

**`shared/types.ts` / `shared/protocol.ts`**
- Add `WorkItem`, `WorkItemState`, `WorkDef`, `WorkDefType` types + API contracts.
- **Remove** `Capabilities`, `meetsRequirements`, `Story.requirements`, the
  `DIRECTORY_CAP` key, and `config.recentCapabilities`. Keep `normalizeDirectory`.

**`store.ts`**
- New tables: `work_items`, `work_defs` (+ migration blocks like existing ones).
- `loadFromDisk()`: also load `tasks/*.md` (WorkDefs); rebuild the queue —
  recreate `READY` WorkItems for tasks sitting ready-in-an-agent-state with no
  active item; persist only non-terminal WorkItems.
- Task→WorkItem creation: when `setTaskPosition` lands a task in an agent state,
  create a `READY` WorkItem. (This is creation only — no backward "sync"; the
  reverse direction is handled by the terminal-state reaction below.)
- WorkItem terminal reaction: `completeWorkItem` → advance the task (task refs)
  / post the def comment (workdef refs); `failWorkItem` / `cancelWorkItem` →
  record + leave the task stuck.
- `reEnqueue(ref)` — create a new `READY` WorkItem for a ref that has no active one.
- `getNextWorkItem(agent)` — replaces `getNextWorkableTask`; directory-affinity
  tiers (above), no capability matching.
- WorkItem transition methods + `markWorkItemRead`.
- WorkDef CRUD + `enqueueWorkDef(id)`.
- **Cron scheduler**: a `setInterval` (reuse the timer/reaper pattern) ticking
  ~every 30–60s, finding due Scheduled WorkDefs and enqueuing a run. Vendor a
  small 5-field cron parser (~40 lines) rather than add a dependency.
- **Reaping → MORIBUND**: `reapOfflineAgents` moves a silent agent's
  `IN_PROGRESS` items to `MORIBUND` (keeps the lease; no failure declared, no
  auto-re-enqueue). On a later `heartbeat`, restore that agent's `MORIBUND` items
  to `IN_PROGRESS`. A `forceFailWorkItem(id)` (human) takes `MORIBUND → FAILED`,
  optionally re-enqueuing.

**Removed with the capability model**
- `store.ts`: `recordCapabilities`/`addCapability`/`removeCapability`,
  `getRecentCapabilities`, and requirement checks in matching.
- Routes: `GET/POST/DELETE /api/capabilities`. Agent `register` takes a single
  `directory` instead of a `capabilities` map.
- UI: `RequirementsEditor`, the settings "Recent Capabilities" editor, and the
  teammate capability badges (the sidebar just shows each agent's directory).

**Removed with `assigned-story`** (all teammates are now generalists)
- `Member.workMode` / `Member.assignedStoryId`; the `WorkMode` type; the
  register params for them.
- The `next-work` **auto-archive-and-dismiss** path (`{ task: null, dismiss }`).
  ⚠️ **Replacement needed:** story auto-archiving rode on that path. Move it to a
  daemon check — when a story reaches `done` (its last task advanced out of the
  active section and no more remain), `isStoryArchivable` → archive it. Trigger
  this from the WorkItem COMPLETE reaction / admission, not from an agent poll.
- Spawn page's story-binding field and the `--ppt-work-mode`/`--ppt-story` flags.

**`prompt.ts`**
- Keep `buildTaskPrompt` for story-task refs. Add `buildWorkDefPrompt(def)` for
  WorkDef refs (persona-less: Goal → Acceptance Criteria → Additional / reference
  context → completion guidance). `claim` picks the builder by ref kind.

**`routes/agents.ts`** (WorkItem-centric contract)
- `GET /api/agents/next-work` → `{ workItem: { id, title } }` or `{ workItem: null }`
  (no more `dismiss` — that belonged to `assigned-story`).
- `POST /api/agents/claim/:workItemId` → resolve ref, build prompt, return `{ prompt, workItem: {id} }`.
- `POST /api/agents/work-items/:workItemId/state` `{ state: "COMPLETE" | "FAILED" }`
  — the single state-setter the agent uses. No `done`, no `fail`, no `return`
  convenience endpoints: the daemon offers primitives and reacts to the terminal
  state (COMPLETE → advance; FAILED → leave stuck). Comments go through the
  comment endpoint; "giving up" = post a comment + set FAILED (the harness may
  wrap that as one LLM tool, but the daemon doesn't bundle it).
- `token-usage` + `attachments` + `comments` accept a WorkItem id and resolve to
  the backing ref. Keep `/api/tasks/:id/*` for the UI.

**`routes/` new/updated**
- `routes/work.ts`: `GET /api/work-items` (filter by state, paginate — powers
  Inbox + sidebar), `POST /api/work-items/:id/cancel`,
  `POST /api/work-items/:id/force-fail` (MORIBUND → FAILED, optional re-enqueue),
  `POST /api/work-items/:id/read`, `POST /api/work-items/re-enqueue` (by ref).
- `routes/work-defs.ts`: WorkDef CRUD + `POST /api/work-defs/:id/enqueue`
  ("save without enqueueing" = create def, skip enqueue).
- `routes/shared.ts`: `/health` `queueDepth` counts `READY` WorkItems.

---

## UI changes

**NavBar** → `Logo | Board | Tasks | Schedule | Context | … ? * t`
- Board keeps a Workflows sub-tab (moved off the old RootPage, via `RouteTabs`/`BoardTabs`).
- `Tasks` (Solitary WorkDefs), `Schedule` (Scheduled WorkDefs), `Context` promoted.

**New Root page (`/`)**
- Quick-create row: Story / Task / Schedule → creation pages.
- Two tabs (`RouteTabs`): **Inbox** + **Assistant** (existing). Inbox = paginated
  list of COMPLETE/FAILED WorkItems, default filter unread, showing title /
  status / read-state / enqueued+completed timestamps. Each item links to its
  ref's detail (task page for task refs, WorkDef page for workdef refs).
  **CANCELED items never appear** — a human canceled them, so there's nothing to
  notify. (A separate full WorkItem *audit/history* view is a possible future
  feature, distinct from the Inbox.)

**New pages**
- `TasksPage`, `SchedulePage` (lists of WorkDefs).
- `NewWorkDefPage` (shared form; Schedule variant adds a cron field with friendly
  presets — "Every morning" etc.).
- `WorkDefDetailPage` (goal/acceptance/context + the per-def comment/run thread).
  Story-task refs continue to use `TaskDetailPage`.

**`SpawnPage`** — drop the story-binding field (and its `storyId` spawn param).
All teammates spawn as generalists; the working directory (home dir) is the only
placement input, and it now drives affinity.

**`TeammateSidebar`** (restructured)
- Top: Spawn + collapse toggle, then `[L] [A] [Tn]` status icons (Lead /
  Assistant / Teammate-count). Clicking opens a modal listing the agents behind
  it. Requires distinguishing lead/assistant/teammate — verify current tagging
  (capabilities/metadata; may need a small `role` on register).
- Below: live list of non-terminal WorkItems (`READY`/`IN_PROGRESS`) with a
  ready/in-progress icon, truncated title, and cancel affordance for `READY` ones.
- The board / task page surface a **Re-enqueue** action for a task in an agent
  state with no active WorkItem (last attempt FAILED/CANCELED). `MORIBUND` items
  show "at risk" in the sidebar with a **Force-fail** (+ optional re-enqueue) action.

---

## pi-pizza-team changes (contract break, small)
- `client.ts`: `getNextWork()` returns `{ workItem }`; `claimTask`→`claimWorkItem`;
  replace `completeTask`/`returnTask` with a single `setWorkItemState(id, state)`
  (COMPLETE/FAILED); repoint `reportTokenUsage`/`uploadAttachment`/`postComment`
  to `/api/agents/*` WorkItem routes. **Registration sends `directory` (the pi
  cwd) instead of a `capabilities` map.**
- `teammate.ts`: rename `currentTaskId`→`currentWorkItemId`; on `agent_end` set
  `COMPLETE`. **Remove the `return_task` tool** — replace with a `fail` tool
  implemented purely client-side as *postComment(reason) + setWorkItemState(FAILED)*
  (the daemon no longer bundles this). **Drop `--ppt-work-mode`/`--ppt-story` and
  the `onDismissed` self-shutdown** (no more `assigned-story`). Update header/loop
  comments.
- Update pi-pizza-team `README.md` + `docs/ARCHITECTURE.md`.

---

## Docs & tests (my-pizza-team)
- `ARCHITECTURE.md` — new modules, routes, tables.
- `DESIGN.md` — new principle "WorkItem: a dumb, terminal-only attempt that drives
  task flow"; how it sits atop CONWIP; solitary/scheduled rationale.
- `WORK-MODEL.md` addendum (or new `QUEUE-MODEL.md`) — the agent protocol change.
- Tests: `store.test.ts` (WorkItem transitions incl. no-backward, terminal
  reaction advancing/sticking a task, re-enqueue, WorkDef enqueue, cron due-calc),
  `server.test.ts` (work/work-defs routes, next-work returns workItem, claim
  resolves both ref kinds).

---

## Resolved Decisions (from Tim's rev-1 review)

1. **Contract** — WorkItem-centric; update pi-pizza-team. ✅
2. **No `return`** — the give-up transition is deleted. "Give up" = the agent
   composes two primitives (post a comment + set the WorkItem `FAILED`); the
   harness may wrap them as one LLM tool, but the daemon bundles nothing. ✅
3. **Standalone name** — `WorkDef` with a `type` field (`Solitary` | `Scheduled`;
   future `Story`). UI: "Story Task" / "Solitary Task" / "Scheduled Task". ✅
4. **`result` field** — dropped. Completion summary is a **comment on the ref**. ✅
5. **Comments** — on the **ref/WorkDef** (per-def), not the WorkItem. ✅
6. **Control direction** — the WorkItem **drives** the task: terminal COMPLETE
   advances the task, FAILED/CANCELED leaves it stuck for a human. ✅
7. **Storage** — markdown+frontmatter for WorkDefs; JSONL for comments. ✅
8. **Cron** — vendor a tiny 5-field parser (no strong opinion → keep it dep-free). ✅
9. **Deliberate failure (was Q-A, rev 3)** — an agent giving up sets `FAILED`
   directly (comment + state, composed by the agent); the task is left stuck for
   a human. No auto-re-enqueue. ✅
10. **Reaping → MORIBUND (rev 3)** — a silent agent's `IN_PROGRESS` items become
    `MORIBUND` (lease kept, no failure declared). The agent returning restores
    them to `IN_PROGRESS`; the human may **force-fail** (+ optional re-enqueue).
    Replaces the old "reap → FAILED" guess. ✅
11. **`substatus` retired (was Q-B)** — the active WorkItem is the single source of
    truth; the board chip is derived (incl. an "at risk" chip for MORIBUND). ✅
12. **CANCELED not in the Inbox (was Q-C)** — the human canceled it; nothing to
    notify. A separate audit/history view of all WorkItems is possible future work. ✅
13. **Capabilities/requirements removed; replaced by directory affinity (rev 4)** —
    the whole capability/`requirements` matcher is deleted. The only work-selection
    signal is an optional working `directory` on the story/WorkDef, used as a soft
    **bias** via priority tiers. Tier 3 (a non-matching agent takes it) fires only
    when **no eligible online agent has that directory** — presence-based, no
    timers: if a correct-dir agent exists, the item waits for it. A wrong-dir
    pickup just `cd`s and fails; a false-negative match only loses the preference.
    This retires the path-string bug class WORK-MODEL.md worried about. ✅
14. **`assigned-story` work mode removed (rev 5)** — teammates are a flat pool of
    generalists biased only by directory. Drops `WorkMode`/`assignedStoryId`, the
    `next-work` dismiss path, the spawn story-binding, and `--ppt-work-mode`/
    `--ppt-story`. Story auto-archiving moves to a daemon check on the WorkItem
    COMPLETE reaction (was riding on the dismiss path). ✅

## Follow-ups (out of scope for this refactor, revisit after)

- **Structured content for story tasks.** Story tasks are loose markdown prompts
  today, unlike WorkDefs' structured goal/acceptance-criteria fields. Harmonizing
  them lines up with the future `type: "Story"` — deferred, its own design pass.

## Suggested execution order

1. Types + protocol (`shared/`).
2. Store: tables, migrations, task→WorkItem creation, terminal reaction,
   re-enqueue, `getNextWorkItem`, WorkDef CRUD/enqueue, cron scheduler,
   reap→MORIBUND + heartbeat-restore + force-fail.
3. Prompt: `buildWorkDefPrompt`.
4. Routes: agents (WorkItem-centric), `work.ts`, `work-defs.ts`, health.
5. Daemon tests.
6. pi-pizza-team client/teammate + its docs.
7. UI: NavBar, Root (Inbox/Assistant), Tasks/Schedule/Context pages, NewWorkDef
   form, WorkDef detail, TeammateSidebar restructure, Re-enqueue action.
8. my-pizza-team docs (ARCHITECTURE/DESIGN/WORK-MODEL).

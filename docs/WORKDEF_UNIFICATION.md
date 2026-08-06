# WorkDef Unification

**Status:** in progress
**Supersedes the split introduced in** `FRONTIER_ENGINEER_REFACTOR_PLAN.md` (Task vs WorkDef).

## Motivation

The Frontier Engineer refactor made **WorkItem** the universal execution unit but
left two authoring concepts above it: board **Tasks** (free-text `description`,
workflow position, `result`) and standalone **WorkDefs** (structured
Goal/Acceptance-Criteria/Context, Solitary + Scheduled). They emit the same
WorkItems and their comments/attachments already live on the ref — so the split
is redundant. This unifies them.

## The model

Everything above a WorkItem is a **WorkDef** (the *what*) owned by a **parent**
(the *when/why*). A parent owns 0+ WorkDefs and decides when each emits a
WorkItem. Two parent kinds today; the relationship is identical:

| Parent | Emission policy | Multiplicity |
|--------|-----------------|--------------|
| **Story** | a child's workflow `status` enters an agent state (initial + rework re-entry) | 1 story → many WorkDefs |
| **Schedule** | cron fires | 1 schedule → many WorkDefs |
| *(none)* | manual (**Solitary**) | — |

`type` is **derived** from the parent kind — it is not stored.

### Invariant: `workdef.md` is authored content only

The daemon never rewrites a WorkDef file. All *mutable runtime* state lives off
the markdown:
- workflow **status** → on the Story (`tasks: [{id, status}]`)
- **lastEnqueuedAt** → on the Schedule (and/or `state.db`)

### Shapes

```
WorkDef — tasks/<id>/workdef.md — authored only
  frontmatter: title, parent? { kind: "story" | "schedule", id }, directory?, contextRefs?
  body:        ## Goal / ## Acceptance Criteria / ## Additional Context
  (no type, no status, no cron, no lastEnqueuedAt)
  tasks/<id>/comments.jsonl, tasks/<id>/attachments/   # the ref's thread + files

Story — stories/<id>.json — workflow parent (flattened; no more per-task subdirs)
  id, title, description, workflow, status: "open" | "done",
  paused?, dependsOn?, directory?, context?,
  tasks: [{ id, status }]        # ordered child WorkDefs + their workflow position

Schedule — schedules/<id>.json — cron parent (flattened)
  id, title?, cron, lastEnqueuedAt?
  # children = WorkDefs whose parent = { kind: "schedule", id }

WorkItem — ref = { workDefId }   # the task|workdef union collapses
```

## Single emission pathway

`enqueueFor(workDefId)` is the one place a WorkItem is created. The three
triggers all call it:

- **Story** — admission: when a child's `status` transitions into an agent
  state (first entry or a rework re-entry).
- **Schedule** — `runScheduler` ticks; for each due schedule, `enqueueFor` every
  child and bump `lastEnqueuedAt`.
- **Solitary** — the manual "Run" action.

## Route surface (the `/api/tasks` vs `/api/work-defs` seam)

The model unified, so the HTTP surface follows one rule: **ref/WorkDef
operations live under `/api/work-defs/:id`; Story-parent operations live under
`/api/tasks` + `/api/stories/:id/tasks`.**

- **`/api/work-defs/:id/*`** — the WorkDef itself, for *every* kind (board,
  Solitary, Scheduled): get/update/delete, enqueue, comments, **attachments**
  (upload/list/serve/delete), **token-usage**. This is the canonical web-UI
  surface; a board task is a WorkDef, so its detail page uses these too.
- **Story-parent only** (no WorkDef analog): `POST /api/stories/:id/tasks`
  (create-in-story), `.../tasks/reorder`, `POST /api/tasks/:id/move` (workflow
  position), `DELETE /api/tasks/:id` (also drops the task from the story +
  frees the CONWIP token).
- **Harness contract unchanged** — agents use `/api/agents/*` (ref-resolved).

Dropped as redundant: `/api/tasks/:id/comment(s)` (identical ref file as the
work-defs route). Kept for back-compat: `/api/tasks/:id/attachments*` and
`/api/tasks/:id/token-usage` are still served because **mpt-mcp-server** calls
them; the web UI no longer does. `token_usage.task_id` dropped its FK to
`tasks(id)` so usage can be recorded on standalone WorkDefs (they have no tasks
row) — this also fixed the same latent gap on the agent token-usage path.

## Dropped concepts

- **`Task` type** — folded into `WorkDef`.
- **`task.result`** and the prompt's **"Context from previous tasks"** section —
  a pre-general-purpose-agent idea; each WorkItem is self-contained (story-level
  context + the WorkDef's own goal/criteria carry continuity). Completion is a
  comment on the ref, same as it already is for standalone work.
- **`WorkDef.type` / `cron` / `status` / `lastEnqueuedAt` in frontmatter** — see
  the invariant above.

## Storage / naming

- Flat `stories/<id>.json` and `schedules/<id>.json` (single files — their
  children live in `tasks/`, so the old per-story `tasks/` subdir overload is
  gone).
- `tasks/<id>/` keeps a directory because it owns the WorkDef body + comments +
  attachments.
- WorkDef ids stay title-slugged and globally unique within `tasks/`; existing
  board task ids (e.g. `add-user-auth-1`) are preserved by the migrator so
  `story.tasks` needs no churn.

## Harness contract

**Unchanged.** Agents only ever see an opaque WorkItem id + a daemon-assembled
prompt; whether the ref is a Story child or a Schedule child is resolved
server-side. No pi-pizza-team break.

## Migration

A one-time, in-place migrator runs on load for existing team dirs:
- `stories/<id>/story.json` → `stories/<id>.json`; build `tasks: [{id, status}]`
  from the old `taskOrder` + each task's `status`.
- `stories/<id>/tasks/<tid>/task.json` → `tasks/<tid>/workdef.md` with
  `parent: { kind: story, id }`; `description` → Goal; drop `result`.
- Existing standalone `tasks/<id>/workdef.md` with a `cron` → create
  `schedules/<id>.json`, set `parent: { kind: schedule, id }`, strip cron/type.

## Milestones

### M1 — Daemon to green *(one checkpoint; Deno type-checks the whole graph)* — ✅ DONE
- **types** — `WorkDef.parent`, authored-only WorkDef; `Story.tasks: [{id,status}]`;
  new `Schedule`; `WorkItemRef` → `{ workDefId }`; drop `Task`/`TaskWithMeta`. *(done)*
- **store/workdefs.ts** — frontmatter round-trips `parent` (not `type`/`cron`/
  `lastEnqueuedAt`); create/update signatures follow.
- **store.ts**
  - disk IO: `stories/<id>.json` (flat), `tasks/<id>/workdef.md` for board children,
    `schedules/<id>.json`; `Story.tasks` replaces `taskOrder` everywhere.
  - ref collapse in every WorkItem method (`ref.workDefId`).
  - one **`enqueueFor(workDefId)`**; `createTaskWorkItem`/`enqueueWorkDef`/scheduler
    all funnel through it.
  - Schedule CRUD + `runScheduler` fires each schedule's child WorkDefs.
  - drop `result` + `advanceTask` result plumbing; completion is a ref comment.
  - **migrator** (on load): old `stories/<id>/story.json` + `tasks/*/task.json` →
    flat story + board WorkDefs (parent=story, keep ids); cron-bearing standalone
    WorkDefs → `schedules/<id>.json` + parent=schedule.
  - keep the SQLite schema **as-is** (runtime index rebuilt from disk); internal
    columns like `ref_kind`/`task_id` stay — see *Deferred*.
- **prompt.ts** — one builder; drop the "Context from previous tasks" section.
- **workflow-engine.ts / cron.ts / routes/\*** — follow the model; `/api/tasks/*`
  and `/api/work-defs/*` reshaped around WorkDefs + `Story.tasks`; `/api/schedules/*`
  added. Contract to agents (`/api/agents/*`, WorkItem ids) unchanged.
- **tests** — update the suite; `deno test` green.

### M2 — UI to green *(`npm run build`)* — ✅ DONE
- **Two coherent detail pages** (revised from "merge"): the board keeps its
  feature-rich `TaskDetailPage` (comments, attachments, diff review, moves) at
  `/task/:storyId/:taskId`; standalone work uses `WorkDefDetailPage` at
  `/work-defs/:id`. The model is unified (M1); forcing one page would regress
  board features for little gain.
- `WorkItemView` gains `parent` so the **Inbox** routes each completed item to
  the right page (board → `/task/:storyId/:id`, standalone → `/work-defs/:id`).
- Board reads stories → child tasks via `Story.tasks` (unchanged API shape).
- Tasks page = parentless WorkDefs; **Schedule page + WorkDefDetail read cron
  from `/api/schedules`** (cron moved off the WorkDef).
- Keep the human word “task” for Board items though the type is `WorkDef`.

### M3 — Demo + docs — ✅ DONE
- Rewrite `mpt-demo-team` fixtures to the flat layout (`stories/<id>.json`,
  `tasks/<id>/workdef.md`, a sample `schedules/<id>.json`); update `setup-demo.sh`.
- Refresh `README.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, and the
  pi-pizza-team docs where they describe the ref/model (contract unchanged).

## Deferred (optional, no functional benefit)
- Align the SQLite schema to the vocabulary (rename `ref_kind`/`task_id`, add
  explicit `work_defs`/`schedules` tables). It's a rebuilt-on-load index, so this
  is cosmetic — do it only if the internal/disk mismatch becomes confusing.
- Flatten `tasks/<id>/` further if comments/attachments ever move off the ref.

# Plan: Split `daemon/store.ts` into focused modules

`daemon/store.ts` is the largest file in the codebase (~1640 lines). It is a
cohesive but overloaded "god object" that owns the SQLite schema plus every data
domain. This plan breaks it into small, single-responsibility modules **behind an
unchanged `Store` facade**, so no route/CLI/test call sites change.

Two concerns have already been extracted as a proof of the pattern:
`daemon/store/notes.ts` and `daemon/store/git-sync.ts`.

## Goal & constraints

- **Public API unchanged.** Routes call `store.getStory(...)`, `store.createLeaderDirective(...)`,
  etc. Those method names and signatures stay identical. `Store` becomes a thin
  coordinator that delegates.
- **No behavior change.** Pure structural refactor; the full test suite stays green
  between every step.
- **No new dependencies.** Same `@db/sqlite`, same file layout on disk.
- **Each step is independently committable** and individually reviewable.

## Current sections in `store.ts`

Schema/migrations · load-from-disk · stories · tasks · assignments · comments ·
token usage · members · recently-used capabilities · flush-to-disk · autosave
timers · transition instructions · workflow validation · archive · backlog ·
assistant conversation · leader directives · (notes ✅ extracted) ·
(git-sync ✅ extracted) · cleanup.

## Target layout

```
daemon/
├── store.ts                # Store facade: owns db + config + workflows + timers; delegates
└── store/
    ├── db.ts               # openDatabase(teamDir) + initSchema() + migrations
    ├── context.ts          # StoreContext type: { db, teamDir, config, workflows }
    ├── stories.ts          # stories CRUD, isStoryReady, dependency checks
    ├── tasks.ts            # tasks CRUD, status transitions, next-workable matching
    ├── assignments.ts      # claim/release, per-member assignment lookups
    ├── comments.ts         # comments.jsonl append/read + SQLite mirror
    ├── members.ts          # register/heartbeat/reap, capabilities, work modes
    ├── capabilities.ts     # recentCapabilities record/add/remove + persistConfig
    ├── directives.ts       # leader_directives CRUD + spawn-name generation
    ├── assistant.ts        # assistant_messages conversation
    ├── workflows.ts        # load/save/delete workflows, transition instructions
    ├── archive.ts          # archive + backlog + synopsis generation
    ├── autosave.ts         # flushToDisk + timers (uses git-sync)
    ├── notes.ts            # ✅ done
    └── git-sync.ts         # ✅ done
```

## Composition pattern

Prefer **free functions over a shared `StoreContext`** rather than sub-classes.
Each module exports functions whose first argument is the context:

```ts
// store/context.ts
export interface StoreContext {
  db: Database;
  teamDir: string;
  config: TeamConfig;
  workflows: Record<string, WorkflowConfig>;
}

// store/stories.ts
export function getStory(ctx: StoreContext, id: string): StoryRow | null { ... }
```

`Store` holds the context and its cross-cutting state (timers, workflow cache) and
delegates:

```ts
class Store {
  private ctx: StoreContext;
  getStory(id: string) { return stories.getStory(this.ctx, id); }
  createStory(...args) { return stories.createStory(this.ctx, ...args); }
}
```

Why free-functions-over-context (not repository classes): avoids `this` capture
games, makes cross-module calls explicit (`tasks.getTasksForStory(ctx, id)`), and
keeps each module trivially unit-testable with a throwaway in-memory ctx.

### Handling cross-module calls

Some methods call across domains (e.g. `createStory` records capabilities;
`archive` reads tasks; matching reads workflows). Rules:
- Call the other module's function directly with the same `ctx`
  (`capabilities.record(ctx, reqs)`), not back through `Store`.
- Keep `rowToStory` / `rowToTask` / `rowToMember` mappers next to their domain and
  export them for the few cross-module readers.
- The workflow cache (`ctx.workflows`) is read by tasks/stories/archive; it is
  populated by `workflows.load(ctx)` at startup and on `reloadWorkflows()`.

## Suggested order (each step: extract → delegate → `deno task check` + `deno task test` → commit)

1. **`db.ts`** — move `initSchema()` + column migrations + DB open. Lowest risk;
   everything else keeps using `ctx.db`.
2. **`capabilities.ts`** — small, self-contained, already helper-shaped; includes
   `persistConfig`/`serializeConfig`.
3. **`assistant.ts`** — self-contained table, no cross-domain reads.
4. **`directives.ts`** — self-contained; `generateSpawnName` reads members (import
   `members.list`).
5. **`comments.ts`** — JSONL + mirror table; used by tasks/archive.
6. **`assignments.ts`** — tiny; used by tasks/members.
7. **`members.ts`** — register/heartbeat/reap; calls `capabilities.record`.
8. **`workflows.ts`** — load/save/delete + transition instructions + validation.
9. **`tasks.ts`** — CRUD, `updateTaskStatus`, and `getNextWorkableTask` (matching).
   Highest churn; do after stories helpers exist.
10. **`stories.ts`** — CRUD, `serializeStory`, readiness/dependencies.
11. **`archive.ts`** — archive + backlog + synopsis (depends on stories/tasks).
12. **`autosave.ts`** — `flushToDisk` + timers; calls `git-sync.commitTeamDir`.
13. **Final `store.ts`** — should be a thin facade (~150–250 lines): constructor,
    context, delegation methods, timer lifecycle, `close()`.

## Testing strategy

- The existing suite (`tests/*.test.ts`, currently 120) exercises the public API
  through routes and the `Store` facade — it is the regression net; keep it green
  at every step.
- Opportunistically add focused unit tests per new module using an in-memory
  `StoreContext` (e.g. `capabilities.test.ts`, `directives.test.ts`) where it adds
  clarity, but do not block the split on new tests.
- Run `deno task check` and `deno lint daemon` after each step (lint should stay at
  zero unused-vars / import-prefix).

## Risks & mitigations

- **Circular imports** between domain modules (e.g. tasks ↔ stories). Mitigate by
  keeping row-mappers in their own domain and importing functions, not the facade;
  if a cycle appears, hoist the shared helper into `context.ts` or a `rows.ts`.
- **Silent behavior drift** during mechanical moves. Mitigate by moving code
  verbatim first (only swapping `this.` → `ctx.`), then tidying in a separate pass.
- **Large diffs.** Keep each module its own commit so review stays tractable.

## Out of scope

- No API/schema changes. No rename of public `Store` methods.
- Route handlers, CLI, and UI are untouched.

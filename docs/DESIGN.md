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

### Messages → Comments (2026-06-05)

The original design used "messages" as a real-time communication channel between lead and teammates (`/api/tasks/:id/message`, `messages.jsonl`). This has been renamed to **comments** throughout:

- API routes: `/api/tasks/:id/comment`, `/api/tasks/:id/comments`, `/api/agents/comments/:taskId`
- On-disk storage: `comments.jsonl` (was `messages.jsonl`)
- SQLite tables: `comments`, `comments_loaded` (were `messages`, `messages_loaded`)
- Types: `Comment`, `CommentAttachment` (were `Message`, `MessageAttachment`)

**Rationale**: Comments are task-level annotations, not a real-time chat channel. Agents load them once when starting work (to see lead feedback or rework instructions), not by continuous polling.

### Agent Lifecycle: Multi-Transition Ownership (2026-06-05)

The original design assumed a one-shot claim→complete flow: agent claims a task, does one thing, and releases. The new model supports **multi-transition ownership**:

| Old Pattern | New Pattern |
|-------------|-------------|
| `POST /api/agents/claim/:taskId` — assigns + forces `in_progress` | `POST /api/agents/claim/:taskId` — assigns ownership only, no state change |
| `POST /api/agents/complete/:taskId` — transitions to review/done + releases | `POST /api/agents/transition/:taskId` — advances to any valid state; auto-releases only on done |
| Agent polls `next-work` for tasks in initial state only | Agent polls `next-work` for any unclaimed task with a teammate-allowed transition |
| No explicit release | `POST /api/agents/release/:taskId` — agent parks task when blocked by lead-only transition |

**Lifecycle**:
```
1. Agent polls next-work → unclaimed task with teammate transition
2. Agent claims (ownership only)
3. Agent transitions through states it's allowed to (repeatable)
4. When availableTransitions is empty → agent releases
5. Lead acts (moves state, adds comments)
6. Agent re-discovers task on next poll, sees comments, claims again
```

**Rationale**: Workflows can have multiple agent-driven states (e.g., `todo→coding→testing→review`). The agent should own the task across all consecutive teammate transitions, only handing off when the lead needs to act (e.g., `review→done`). This also supports rework: lead sends task back to an earlier state with comments, agent picks it up again.

# Design

This document captures the design philosophy and rationale behind pi-pizza-team.

## Concept

pi-pizza-team models AI agents as a **team** with a **kanban board**. The metaphor:

- **Team Lead Pi** — orchestrates work, manages the board
- **Teammate Pis** — autonomous workers in tmux windows
- **You (the Mentor)** — review, guide, and pair when needed

The name comes from Amazon's "two pizza teams" concept and the more recent "one pizza team" — we're a **π (3.14) pizza team**. 🍕

## Core Principles

### 1. Git as the source of truth
Task definitions, stories, and decision history live as files in a git repo. This gives you:
- Diffable progress (see what changed and when)
- Committable decision logs (why choices were made)
- Branchable work (experiment with different task breakdowns)

### 2. Two modes of mentoring
When a teammate needs help, you have two channels:
- **Async ("reply to email")** — teammate asks a question, you reply from the lead, they continue
- **Sync ("pair programming")** — hop into their tmux window and work together directly

There's no "human task" concept. Every task belongs to a teammate. The variable is how much mentoring they need.

### 3. Workflow as configuration
The state machine is entirely in `config.json`. You can define multiple named workflows and control who can perform each transition. Individual stories can override the default workflow. No code changes needed for:
- Adding a QA step
- Requiring lead approval before "done"
- Creating a "needs_input" state only the lead can resolve
- Using a simpler workflow for small stories
- Defining a stricter workflow for critical work

### 4. Sequential within stories, parallel across stories
- Tasks within a story execute in order (1 → 2 → 3)
- Different stories can be worked on simultaneously
- Dependencies between stories gate when a story becomes "ready"

### 5. Messages as decision records
The `messages.jsonl` files capture the back-and-forth between teammates and the lead. These get committed to git, forming a lightweight ADR (Architecture Decision Record) system — "why did we use RS256?" is right there in the task history.

### 6. Working directory per story
Stories can specify an optional `dir` field (e.g., `"dir": "~/Workspace/my-project"`). When using `/ppt-spawn <story-id>`, the teammate is launched in that directory automatically. This supports multi-repo teams where different stories live in different codebases.

**Task routing by directory:** When a teammate polls for work, the server only returns tasks from stories whose `dir` matches the teammate's working directory. Stories with no `dir` are available to any teammate. This ensures a teammate spawned in project A won't accidentally pick up tasks for project B.

### 7. Transition instructions
Optional markdown files (`on-enter-<status>.md`, `on-exit-<status>.md`) provide contextual instructions when tasks change state. This enables:
- Pre-work checklists ("read the design doc first")
- Review guidelines ("run tests before marking done")
- Exit procedures ("clean up temporary files")

### 8. Archiving as a first-class concept
Completed stories can be archived to keep the active board focused on current work. Archived stories retain all their files (story.json, tasks, messages) for historical reference — they're just moved to a separate `archived/` directory and excluded from the active SQLite database. A `SYNOPSIS.md` is auto-generated on archive as a structured summary, and can optionally be enriched by the LLM for stories that warrant a richer narrative.

## Interaction Model

### Task Lifecycle

```
todo ──(any)──► in_progress ──(teammate)──► review ──(lead)──► done
                     │                         │
                     │                         └──(lead)──► in_progress
                     │                                       (with feedback)
                     └──(teammate)──► needs_input
                                         │
                                         └──(lead)──► in_progress
                                                      (with guidance)
```

### Teammate Work Loop

1. Poll leader for available task
2. Claim it (atomic, prevents double-assignment)
3. Execute (send task description as a user message to itself)
4. On completion → move to `review` with result summary
5. If stuck → move to `needs_input` with question
6. Wait for leader to unblock, then continue
7. Repeat

### Permission Toggling

The permission system (`@gotgenes/pi-permission-system`) is toggled based on the teammate's mode:

| Mode | yoloMode | Behavior |
|------|----------|----------|
| Autonomous (working on task) | `true` | No prompts, full freedom |
| Pairing (human hopped in) | `false` | Normal permission rules |

Detection is automatic: interactive input → pairing mode. `/ppt-worker-resume` → autonomous mode.

## Data Architecture

### Why SQLite + JSON files?

| Concern | SQLite | JSON files |
|---------|--------|-----------|
| Concurrent access | ✓ (WAL mode) | ✗ (race conditions) |
| Fast reads | ✓ | ✓ (but no indexing) |
| Human readable | ✗ | ✓ |
| Git-friendly | ✗ (binary) | ✓ (diffable) |
| Atomic updates | ✓ | ✗ |

Solution: use both. SQLite is the runtime engine, JSON files are the persistent record. Sync between them via periodic flush.

### Why JSONL for messages?

- Append-only (no read-modify-write)
- Each line is independent (no array brackets to manage)
- Git diffs show exactly which messages were added
- No merge conflicts from concurrent appends
- Easy to `tail -f` for debugging
- Can grow indefinitely without making task.json unwieldy

### Why lazy-load messages?

A project with 200 completed stories could have thousands of messages. Loading them all at startup would be slow and wasteful. Instead:
- Startup only reads lightweight `story.json` and `task.json` files
- Messages are loaded into SQLite on first access
- The `messages_loaded` table prevents re-reading from disk

## Future Directions

- **TUI kanban board** — interactive `ctx.ui.custom()` component with keyboard navigation
- **SSE for real-time updates** — browser board updates without polling
- **Story templates** — reusable task patterns for common workflows
- **Teammate specialization** — match tasks to teammates based on skills/tools
- **Result summarization** — use LLM to compress task results for context passing
- **Multi-repo support** — teammates working across different repositories
- **Metrics/burndown** — track velocity, time-per-task, completion rates
- **Drag-and-drop board** — reorder tasks and move between statuses visually

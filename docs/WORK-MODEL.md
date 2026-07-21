# Work Model: States, Substatus, and CONWIP Admission

This document specifies the task work model: how tasks flow through a
workflow, who moves them, and how agents claim and complete work. It replaces
the earlier transition-matrix model. ARCHITECTURE.md describes the resulting
modules/API; DESIGN.md holds the philosophy. This doc is the spec.

## Motivation

In the previous model, teammates owned **both** executing work **and**
executing workflow transitions (claim transitioned into a working state;
release advanced out of it). That conflation made every unhappy path bespoke:

- Rework (lead sends `review` back to `in_progress`) required the teammate to
  re-discover a task it thought it had finished, re-claim it, and know to load
  comments — a different code path from first entry, and the source of most
  "teammate isn't picking up work" failures.
- The transition decision hung off the *content of the LLM's final message*
  (string-parsing protocols on model output).
- Workflow configs needed a full transition matrix with per-edge permissions.

The fix is structural: **workers never move tasks.** Then re-entering a state
is indistinguishable from entering it the first time, and every path is the
happy path.

## The model

```
todo (implicit)  →  [ active states, ordered ]  →  done (implicit)

WorkflowConfig  = { states: [ { name, type: "agent" | "manual" } ] }
Task position   = (status, substatus)     substatus only in agent states
Story           = { ..., directory? }     plain data, not a matching key
```

### Positions

- **`todo` / `done`** — implicit buckets, present in every workflow, never
  declared in config. `todo` is the admission queue; `done` is terminal.
  Reserved names: an active state may not be called `todo` or `done`.
- **Agent state** (`type: "agent"`) — worked by teammates via the claim
  protocol. Tasks here carry a **substatus**:
  - `ready` — waiting for a teammate ("work on this")
  - `claimed` — leased to a teammate ("working on this")
  - The third phase ("worked on this") is realized by the daemon's atomic
    advance: completing the work immediately moves the task to the next state.
- **Manual state** (`type: "manual"`) — worked by a human (or the leader
  agent). No substatus, no ceremony: moving the card onward **is** the
  completion. Example: a CR is out for review; "ship it" → you move it.

### Who moves tasks

| Actor | Powers |
|---|---|
| **Teammate** | claim, complete (work done), return (give up + comment), comment. **Never moves tasks.** |
| **Daemon** | Two mechanical rules: **advance** (completed agent-state task → next state) and **admission** (see below). |
| **Human / leader agent** | Move any task to any position (judgment moves: rework, skip, shelve). Entering an agent state resets substatus to `ready` and clears any assignment — re-entry ≡ first entry. |

### Admission (CONWIP)

> Pull the next task (story order) from `todo` into the first active state
> **only when the story has no task anywhere in the active section.**

This is a CONWIP token, scoped per story, WIP = 1: one task in flight through
the whole pipeline per story. It prevents commits stacking up while an earlier
task awaits (or fails) review. Rework keeps the token: moving a task backward
never admits another.

Admission runs after: task completion/advance, judgment moves, task
creation/deletion, story unpause, and daemon load. A judgment move **excludes
the just-moved task** from the admission it triggers (moving a task to `todo`
shelves it; it must not bounce straight back in — but the *next* task may be
admitted in its place).

The daemon (not the LLM leader) executes both mechanical rules, so the happy
path needs no LLM in its critical section.

### Claims are leases

`claimed` is held by heartbeats. When an agent goes offline (heartbeat
reaper), its claimed tasks revert to `ready` and the assignment is cleared —
another teammate picks the task up fresh.

### Stuck work (no `blocked` in v1)

A teammate that cannot proceed **returns** the task: substatus → `ready`,
assignment cleared, with an explanatory comment. A human/leader resolves it
(answers the comment, moves the task, edits the description). `blocked` can be
added later as a fourth substatus value with no schema upheaval.

## State personas

Each agent state has an optional **persona**: the markdown file
`workflows/<name>/<state>.md` (the former "state instructions", same storage,
same editing API/UI). The claim prompt = state persona + story/task context.
There are no transition instructions — workers don't transition. Manual states
need no persona (no prompt is ever built for them).

## Directory handling

`Story.directory` (optional) declares where the work happens. It is **data,
not a matching requirement**: the claim prompt instructs the agent to `cd`
there and to **read that repo's AGENTS.md before starting** (pi only
auto-loads project context from its startup cwd). Teammates no longer
advertise a `directory` capability, which retires the path-string-matching
bug class (symlinks, mounts) entirely. Capability matching remains for
`requirements`/skills.

Known trade-offs (accepted): the repo's AGENTS.md arrives via instruction
rather than auto-load, and the directory-as-containment boundary is gone (any
teammate may be pointed anywhere the process user can write). Two stories
sharing one directory can interleave commits — CONWIP is story-scoped;
directory-scoped serialization is a possible future refinement.

## Teammate protocol

```
1. GET  /api/agents/next-work?agentId=X   → a ready agent-state task, or null
2. POST /api/agents/claim/:taskId          → substatus=claimed, lease + prompt
3. (work, in the story's directory, under the state persona)
4a. POST /api/agents/done/:taskId          → daemon advances; assignment cleared
4b. POST /api/agents/return/:taskId        → back to ready + comment (gave up)
5. Poll again
```

Teammates are **generalists**: every teammate works every agent state (the
persona does the specializing). With CONWIP = 1 per story there is never
stage-level parallelism to exploit, and state-specialists would add a stall
mode ("nobody works this state"). `workMode`/`assignedStoryId` are unchanged.

Completion is signaled by the harness when the agent's turn ends (summary
becomes the task result). Giving up is an explicit tool call
(`return_task` in pi-pizza-team) — protocol beats parsing prose.

## Board

Columns = `todo | …active states… | done`. Task cards in agent states show
their substatus (`ready` / `claimed`); the column itself names the state, so
cards carry no state badge. Dragging a card to another column is a judgment
move via `POST /api/tasks/:id/move` — unrestricted for humans.

## Schema / API summary

- `Task.substatus: "ready" | "claimed" | null` (DB column + task.json field)
- `Story.directory?: string` (DB column + story.json field)
- `WorkflowConfig = { states: Array<{ name, type: "agent"|"manual" }> }` —
  no transitions, no initialState/doneState, no instructions map (persona
  files are found by state-name convention)
- Routes: `POST /api/agents/done/:taskId` (advance), `POST
  /api/agents/return/:taskId` (unclaim + comment); `release` kept as a
  deprecated alias for `done`. `POST /api/tasks/:id/move` accepts any
  position (buckets included) — no permission matrix.

## Rollout (no migration code)

Existing team dirs are hand-fixed (stop daemon → edit JSON → delete
`state.db` or let it re-sync → start):

1. `workflows/<name>/workflow.json` → new `{ states: [{name,type}] }` shape;
   keep the per-state `.md` files (they're the personas now).
2. Each `task.json`: map old status → new position. e.g. old `todo` → `todo`;
   old `in_progress` → `in_progress` + `substatus: "ready"` (or `claimed` if
   genuinely mid-work); old `review` → the corresponding manual state; old
   `done` → `done`.
3. `story.json`: move `requirements.directory` to a top-level `directory`
   field (keep other requirement keys).

Applies to `mpt-demo-team` fixtures and `~/TimVancePizzaTeam`.

## Future (explicitly deferred)

- `blocked` substatus (worker-signaled, judgment-resolved)
- WIP token count > 1; per-workflow config
- Directory-scoped serialization across stories
- Per-state capability requirements (specialist states)
- mpt-mcp-server adaptation to the done/return protocol

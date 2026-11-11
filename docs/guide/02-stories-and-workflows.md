# Stories and workflows

## Stories

A **story** groups related tasks and gives them an order and a
[workflow](#workflows). Each story has an **ID**, **Title**, **Description**, a
**Workflow**, an optional **Directory** (where the work happens), **Dependencies**
(other stories that must finish first), and an ordered list of its tasks with each
task's current status.

A story's tasks run **one at a time, in order**: the next task starts only when
none of the story's tasks is between `todo` and `done`, so commits don't stack up
while an earlier task waits for (or fails) review (internally
[CONWIP](glossary.md#conwip)).

### Creating a story

Use **New Story** (from the dock's **+** menu, or `/stories/new`):

1. **ID** — a URL-safe identifier
2. **Workflow** — which workflow governs this story's tasks
3. **Title** & **Description** (markdown)
4. **Directory** — where teammates work (also the
   [directory affinity](glossary.md#directory-affinity) bias). Pick from the dropdown
   — your **favorite directories** first, then recently used ones — or type a path
   (see [Favorite directories](08-configuration.md#favorite-directories))
5. **Tasks** — optionally add initial tasks inline

(How each task is worked comes from its workflow step's
[persona](06-personas.md). Project knowledge — conventions, build commands — belongs
in the directory's AGENTS.md, which teammates read before starting.)

### Pending stories

A whole story can be **pending** — and back again: tick **Pending** on New Story,
press **Make pending** on its page (or the ⌛ on its swimlane), or ask the assistant.
Unlike a task, a story goes back and forth: **Activate** (▶) resumes it where it left
off. While a story is pending, a task that's already running finishes normally, but
nothing new is handed out, and stories that depend on it wait. Pending stories live on
**Work → Pending**. (This replaces the old story *pause* and the *Backlog*: paused and
backlogged stories show up as pending.)

Pending tasks inside a story hold its place — see
[Pending](01-tasks-and-runs.md#pending-write-first-run-when-its-right).

## The Board

The Board (**Work → Board**, `/work/board`) shows active stories as horizontal
swimlanes, with task cards arranged by workflow step.

### Managing tasks

The Board is for glancing and light triage; editing happens on the task page.

- **Add a task** — the `+` on a story swimlane
- **Move a task** — drag its card to another column (that's how you send to review,
  approve, or send back for rework)
- **Open a task** — the `details →` link opens the task page (read it — or
  **Edit**/**Activate** it while it's
  [pending](01-tasks-and-runs.md#pending-write-first-run-when-its-right) — move,
  delete, read comments, upload/review files)
- **Edit a story** — click the story title to open its page (title, description,
  directory; **Make pending** / **Activate**)
- **Hold a story** — the ⌛ on its swimlane makes it [pending](#pending-stories) (it
  moves to **Work → Pending**); ▶ there activates it again
- **Retire a story** — the archive button on its swimlane; archived stories (with
  their synopses) are on **Work → Archived** (on disk an archived story stays in the
  team's `stories/` folder, flagged as archived; stories archived before this lived in
  `archived/` and are moved back on startup)

### Expanding and collapsing stories

Every story starts **expanded** (its task columns showing). The chevron at the left of
a story's header collapses it to just the header row — the title and its actions
(`+`, archive, pending/activate) — and clicking it again expands it. **Expand all** /
**Collapse all** in the toolbar (next to search and sort) apply to the stories
currently shown, so with a search active they only touch the matching stories.
Searching doesn't expand collapsed stories. The Board remembers each story's choice in
this browser.

A card shows its title/ID, assignee, cost (if tracked), and a small chip when it has
an active run: **queued**, **working**, or **at risk** (see
[the Queue](01-tasks-and-runs.md#the-queue)).

## Workflows

A workflow is an ordered list of **steps** (*states*) a story task passes through,
e.g. `todo → in_progress → review → done` (`todo`/`done` are implicit buckets). Each
step is one of two types:

- **teammate** — worked by teammates (each time a task enters it, it gets a new
  [run](01-tasks-and-runs.md#runs-one-attempt-at-a-task)). It can pick a
  **persona** from the library — role framing put into the prompt for that step.
- **manual** — worked by you or the assistant; moving the card onward *is* the
  completion (review gates, approvals).

(The **teammate** type used to be called **agent**; a `workflow.json` that still
says `"type": "agent"` works as before — see
[Deprecated: agent state type](#deprecated-agent-state-type).)

**Teammates never move tasks.** Finishing a teammate step advances the task
automatically; you make the judgment moves (send to review, approve, send back for
rework). There are no per-transition permissions to configure — just the step type.

### Viewing and editing a workflow

**Config → Workflows** (`/config/workflows`) lists workflow definitions. It only
appears while Stories are switched on — workflows only apply to stories.

Create a workflow by name (it starts as `in_progress` → `review`). Open one to see
its ordered steps and edit them: add/remove steps and set each step's **type**
(**teammate** or **manual**), or make it the default. There are no transitions or
permissions to configure — the pipeline is the ordered list, and the daemon advances
teammate steps automatically. Every story picks its workflow when it's created, and
you can change it later (see [Changing a story's workflow](#changing-a-storys-workflow)).

### Deleting a workflow

A workflow's page has a **Delete** button. It's disabled (the tooltip says why) for
the team's default workflow and for the last one left. The confirmation says how
many **done** stories use the workflow: after the delete they fall back to the
team's default workflow. A delete is refused, with the reason under the header,
while an **open** story (not done or archived, pending included) still uses it — the
message lists those stories; switch them to another workflow or finish them first.
Nothing is lost: the workflow's folder moves to
`workflows/.deleted/<name>-<timestamp>/`, and moving it back restores it (after a
daemon restart or the next config save).

### Changing a story's workflow

A story's page has a **Workflow** picker; a change applies at once. **Team default**
follows the team's default workflow (the page shows which one that is). A switch is
refused, with the reason under the picker, when a task is partway through a step the
new workflow doesn't have — the message names the task and step. Move that task to
`todo` or `done` (or let it finish) and try again. Tasks still in `todo`, finished
ones, and tasks in a step both workflows share never block a switch.

### State personas

Each **teammate** step can pick a **persona** — role framing the teammate receives when
working that step (implementer, reviewer, CR-writer, …). On a workflow's page,
**State Personas** has a picker per teammate step; a change saves at once and applies
from the next time a teammate picks up a run. **edit** (or **view**, for a built-in or
package persona) beside the picker opens the persona itself on
[Config → Personas](06-personas.md). No persona means just a one-line "you're working
in the … state" framing.

### Polling steps

Some steps finish on an outside signal rather than when the teammate is done
typing — a CR step should create the CR, keep checking it for comments, post
revisions, and only finish once it's approved. Make such a teammate step a
**polling** step: on the workflow's page, **Edit States**, set the step's
**Completion** to **Poll until complete**, fill in **Check every** (and, if you
like, **Time limit** and **On timeout**) and **Save**. The editor checks the
values as the daemon does — an interval under `1m` or a time limit shorter than
the interval won't save. Polling steps show a **poll** badge in the pipeline and on
the Workflows list. Single run, the default, leaves the step as it always was. In
`workflow.json` the same step reads:

```json
{ "name": "cr", "type": "teammate", "completion": "poll", "pollEvery": "15m", "pollTimeout": "7d", "onTimeout": "manual" }
```

- `completion` — `"once"` (the default: one run, done or failed) or `"poll"`.
- `pollEvery` — how long after a "not yet" the next check is due: a duration such
  as `30m`, `2h` or `1h 30m` (units `s`, `m`, `h`, `d`, `w`). Required for
  polling; at least `1m`.
- `pollTimeout` — how long the task may keep polling, from when it entered the
  step (default `7d`; at least `pollEvery`).
- `onTimeout` — what happens then: `"manual"` (the default) stops polling and
  leaves the task in the step for you to move on or fail; `"fail"` fails it.

Each run of a polling step is one **check**. The teammate reads what earlier checks
posted on the task's thread, does what's needed, posts what it did, and ends the
check one of three ways: **done** (the task advances as usual), **fail**, or **wait**
— not yet, with a short reason such as "CR-123 has 2 unresolved comments; revision
posted". A wait doesn't move or fail the task, and isn't news: it doesn't land in
your Inbox. The task records when it entered the step, when it was last checked,
the last wait reason, and how many checks waited.

After a wait the daemon queues the next check once `pollEvery` has passed — one at
a time, never a pile of them. On the board the task's card says when (**Waiting · next check 14:45**,
with **check 4** beside it and the last reason in its tooltip); the story page's
task list and the task's page say the same. While a check runs the card shows the
usual *queued* / *working* chip. If the team's [readiness probe](glossary.md#readiness-probe) says it isn't ready when a
check is due, the check is **held** (the card says **Held · team not ready**, with the probe's reason)
and runs once when the team recovers — one check, however many intervals were
missed. The time limit never runs out on a held check: after recovery one final
check runs first.

When `pollTimeout` runs out after a check that waited, polling stops with a
`[timeout]` comment on the thread: with `"manual"` the card says **Needs attention:
polling timed out** — move the task on if it's done (**Mark done** on its page, or
drag it), or back into the step to poll again (that restarts the clock); with `"fail"` the last check is marked failed and lands in your Inbox.

**Check now** on the task's page runs a check right away, if none is queued or
running (the button is disabled, with the reason, while one is). It's refused
while the team isn't ready, and the reason shows beside the button.

On a **manual** step these fields do nothing; the daemon log warns about them.

### Deprecated: agent state type

The **teammate** step type used to be called **agent**. A `workflow.json` state with
`"type": "agent"` still works for now — it loads as `teammate`, with a one-time
warning in the daemon log — but the old name will be removed in a future version.
Nothing needs changing today: saving the workflow (**Edit States → Save**, or picking a
state persona) writes `"type": "teammate"`. The API still accepts `"agent"` in a
workflow you send, and `GET /api/workflows` reports `teammateCount` (its old name,
`agentCount`, is still there too). See also
[Deprecated: worker](06-personas.md#deprecated-worker).

## Reviewing work

When a teammate finishes a teammate step, the task advances to the next step. If that's
a **manual** step (like `review`), it waits for you: review the work and any attached
diffs, then **drag it forward** (approve → `done`) or **back** (send to rework) with a
comment explaining what to fix. Moving it back into a teammate step queues a fresh run,
and the teammate picks it up again with your comments in the prompt (see
[Comments and the thread](01-tasks-and-runs.md#comments-and-the-thread)).

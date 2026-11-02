# Tasks and runs

## Tasks: what you want done

Every job a teammate does starts as a **task**: a short document with a **Goal**,
**Acceptance Criteria** (what "done" means), and optional **Additional Context**.
Internally a task is called a [WorkDef](glossary.md#workdef). There are three kinds,
and they differ only in *what starts them*:

- **Story task** — one step of a story, moved along by the story's workflow. These
  live on the Board ([Board task](glossary.md#board-task); see
  [Stories and workflows](02-stories-and-workflows.md)).
- **Standalone task** — a one-off you run when you want it, on **Work → Tasks**
  (internally [Solitary](glossary.md#solitary)).
- **Scheduled job** — run on a timer (a cron schedule), on **Work → Schedule**
  (internally [Scheduled](glossary.md#scheduled)).

## Runs: one attempt at a task

A **run** is one attempt at a task — the thing a teammate actually picks up
(internally a [WorkItem](glossary.md#workitem)). A run only moves forward: waiting
→ working → done or failed, never back. Trying again always makes a *fresh* run.

- A story task gets a run each time it enters a step a teammate works (the first
  time, and again for any rework).
- A scheduled job gets a run each time its schedule fires.
- A standalone task gets a run when you press **Run**.

**Lost contact.** If a teammate goes silent in the middle of a run, the run is
marked **at risk** (internally [MORIBUND](glossary.md#moribund): the daemon stopped
hearing from it but hasn't declared it dead). If the teammate reconnects, the run
carries on. Otherwise you can **force-fail** it (optionally starting a fresh run).
A teammate that quits or is dismissed in the middle of a run leaves it at risk too,
for you to force-fail.

## Pending: write first, run when it's right

Any task can start as **pending**: **Save as pending** on the create forms (**Save
tasks as pending** on New Story), or ask the assistant to write tasks up "as pending"
for you to review. A pending task carries an amber **Pending** badge and **never
runs** — no Run, no schedule, and on the Board it **holds its place**: the story
waits at that task (later tasks don't jump ahead) until you activate it.

While it's pending, you and the assistant can both revise it: open it and press
**Edit** (Save / Cancel). When it's right, press **Activate**. Pending stories,
standalone tasks and scheduled jobs are listed on **Work → Pending** — the Board,
Tasks and Schedule tabs show only active work (a pending story task stays in its
story's swimlane, holding its place).

Activating is one-way and **locks the definition**:

- a standalone task is queued straight away,
- a story task is picked up when its story reaches it,
- a scheduled job runs at its next scheduled time.

To change active work, do what you always do — add a comment on its **Thread** and
**Run** it again (for a story task, move it back into a step a teammate works); the
comments go into the next attempt's prompt. A scheduled job's **cron** stays editable
after activating — it belongs to the schedule, not the definition.

Everything created before pending existed counts as active. (Pending used to be
called *draft*, and Activate was *Publish*.)

Stories can be pending too, and go back and forth — see
[Pending stories](02-stories-and-workflows.md#pending-stories).

**Schedules go back and forth too.** Once a scheduled job is active, its schedule can
be paused: press **Make pending** on its row on **Work → Schedule** or in the job
page's header (or ask the assistant). The job moves to **Work → Pending** and its
schedule stops firing; **Activate** there (or on its page) turns it back on. It picks
up at its **next** scheduled time — runs it missed while pending are *not* made up,
so a long pause never comes back as a burst. **Run now** still works on a pending
schedule. A job runs on its schedule only when both the schedule and the job itself
are active: a job you saved as pending stays pending until you **Activate** it from
its page.

## The Work tabs

**Work** in the top nav holds all your work, in five tabs:

- **Board** (`/work/board`) — active stories as swimlanes.
- **Tasks** (`/work/tasks`) — active standalone tasks.
- **Schedule** (`/work/schedule`) — active scheduled jobs.
- **Pending** (`/work/pending`) — everything held back until you activate it:
  stories, tasks, and scheduled jobs, in one list.
- **Archived** (`/work/archived`) — retired stories, tasks, and jobs, in one list
  (restore or delete tasks and jobs here).

**Pending** and **Archived** are each one mixed list. Every row has a type badge
(**Story**, **Task**, or **Schedule**), its title, its directory, and a time when
there is one (when a story was archived, otherwise when the task or job last ran) —
newest first; rows with no time come last, by title. Click a row to open it. The
chips at the top — **Stories · Tasks · Schedules**, each with its count — narrow the
list (all on to start; click to turn one off or on), and the search box matches a
title, id, or directory. On **Pending**, each row has **Activate** and an archive
button; on **Archived**, tasks and jobs have **Restore** and **Delete**. Archived
stories can't be restored — click one to read its synopsis. Story tasks aren't listed
on their own: a pending story task waits in its story's swimlane on the **Board**
(open it there to **Activate** it).

The Board, Tasks, and Schedule tabs only appear while their kind is switched on under
**Config → General → Work items** (a new team starts with Tasks only; see
[Work items](08-configuration.md#work-items-feature-toggles)); Pending and Archived
stay while any kind is on, and **Work** itself goes away only when all three are off.
Clicking **Work** opens its first tab. Each tab has its own address — `/work/board`,
`/work/tasks`, `/work/schedule`, `/work/pending`, `/work/archived` — so bookmark
those (the old `/board`, `/tasks`, `/schedule`, … addresses no longer work).

A connected [source](07-sources.md) gets a tab of its own here too, between
**Schedule** and **Pending**.

## Standalone tasks and scheduled jobs

Not all work belongs on the Board. Two Work tabs manage active standalone work:

- **Tasks** — one-offs. Create one, then hit **Run** to queue it whenever you want it
  done. Good for ad-hoc chores ("audit dependencies"). Pending tasks aren't listed
  here — find them on **Pending**, with **Activate**. Each row shows how many times
  the task has run ("never run", "1 run", "3 runs" — hover for the last run); **Never
  run** narrows the list to the ones you haven't started yet, and the sort menu orders
  by **Fewest runs** / **Most runs**. A run is any run created for the task — queued,
  running, done, or failed — except one you **canceled** before it ran.
- **Schedule** — scheduled jobs. Each is a task attached to a cron **schedule**; the
  daemon queues a run every time the schedule fires, and **Run now** starts one
  immediately. The cron is five fields — minute, hour, day of month, month, day of week
  (`*` for any), in the daemon's local time — and the form reads it back in words as
  you type (`0 9 * * 1-5` → "Every weekday at 9:00"), as does the list. Each row shows its run count and last run; **Make pending** moves it to
  **Pending**.

The archive button on a row moves the task or job to **Work → Archived**, where
**Restore** brings it back and **Delete** removes it for good.

A task's or job's page (and a story task's page) shows the same run count in its
header.

A failed run leaves the task in place — read its Thread, add a comment with what to
change, and **Run** it again (an active definition is locked; see
[Pending](#pending-write-first-run-when-its-right)).

Both tabs use the same create form (`New Solitary Task` / `New Scheduled Job`), with
an optional **Persona** — how a teammate does the work (every run of a schedule uses
it; see [Personas](06-personas.md)). It stays changeable on the Details tab after you
create it, even once it's active, because it's *how* the work is done, not *what*.
The Details tab also lists the item's **Runs**, newest first, each with the persona
it ran with. **Acceptance criteria** are entered as an add-as-you-go checklist, and
each line gets a live badge scoring it against
[RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — normative (MUST/SHALL),
recommended (SHOULD), optional (MAY), or vague — nudging you toward testable,
unambiguous criteria.

## Home: Queue and Inbox

The **home page** (`/`, the pizza logo) has two tabs — **Queue | Inbox** — work in
flight, then finished work. The pizza logo carries two small count badges, each
hidden at zero: a **neutral** one (bottom corner) for runs **queued** and not yet
picked up, and an **accent** one (top corner) for **unread** Inbox items. Hover (or
Tab to) the logo for what they count — "Pizza Team · 3 unread in Inbox · 2 queued".
They stay on the icon when the nav bar is too narrow for the "Pizza Team" wordmark,
refresh every ~10 seconds, and update right away when you mark Inbox items read or
unread. Quick-create (the **+** beside the queue summary) and the assistant live in
the left dock, on every page.

### The Queue

The Queue is work **in flight** — every run that hasn't finished — grouped by what it
needs from you:

- **At risk** (amber) — its teammate went silent mid-work
  ([MORIBUND](glossary.md#moribund)). Nothing retries it automatically:
  **Force-fail** it, or **Re-enqueue** a fresh attempt.
- **Waiting** — not picked up yet, with how long it's waited. **Cancel** it if you
  don't want it run. If waiting work is stuck, a banner says why (distribution paused,
  no teammates online, everyone busy). Work in a pending story, or one waiting on a
  dependency, isn't offered to anyone. An item whose directory is busy reads
  **waiting — directory busy (teammate, item)** (see
  [One teammate per directory](03-teammates.md#one-teammate-per-directory)). It starts
  when that item finishes. If the busy item is *at risk*, force-fail it to free the
  directory.
- **Working** — which teammate has it (click through to watch it) and for how long.

(Internally these are the run states `MORIBUND`, `READY` and `IN_PROGRESS`.)

**Recovery actions**, all on the Queue tab:

- **Cancel** a waiting run you don't want run.
- **Force-fail** an at-risk run (a teammate that went silent), optionally
  **re-enqueuing** a fresh attempt.

### Retries

An item marked **retry · attempt 2 · in 4m** is an automatic retry: the teammate's
model call failed last time (a service outage, expired credentials), so it runs again
after a short backoff — and only once the
[readiness probe](08-configuration.md#readiness-probe) passes. Each failed attempt
leaves an amber **[retry]** comment on the work's thread.

### The queue summary

You don't have to open the tab to keep an eye on it: the **queue summary** at the top
of the left dock (the row beside the nav bar, above both tabs) always shows the
counts — `2 waiting · 1 working`, with **at risk** in amber. **Hover** it to preview
every item and its status; click it to open the Queue tab. With the dock collapsed,
the rail's ⏱ badge (amber when anything is at risk) does the same.

### The Inbox

The Inbox is your review queue: finished runs (**COMPLETE** and **FAILED**), unread
by default. Each row links to the work it came from — a story task opens its task
page, standalone work opens its own page — where the completion summary lives as a
comment. Clicking a row marks it read.

If a teammate's model call kept failing (say, Bedrock was unavailable) the item is
**FAILED** after its automatic retries, never quietly "completed": the row shows the
error, and the thread ends with a red **[failed] … after N attempts** comment.
Earlier failed attempts appear already read — only the final outcome is news.

## Comments and the thread

Comments are the channel between you and your teammates, and they live on the
**task**, not the run — so they persist across attempts:

- **You → teammate**: comment on a task to give feedback or answer questions.
- **Teammate → you**: teammates post their completion summary as a comment when they
  finish (that's what you review in the Inbox).

For reviewing story tasks step by step, see
[Reviewing work](02-stories-and-workflows.md#reviewing-work).

# Glossary

The words the UI and these docs use, including the internal names you'll meet in the
API, the CLI, log lines and the developer docs. Alphabetical.

## Agent

The technical term for a [teammate](#teammate) or the [leader](#leader): an AI coding
agent connected to the daemon. The HTTP API uses it (e.g. `/api/agents`).

## Agent state

A workflow step worked by teammates. Entering it gives the task a fresh
[run](#run); finishing the run moves the task on. The other kind is a
[manual state](#manual-state). See
[Workflows](02-stories-and-workflows.md#workflows).

## Board task

A [task](#workdef) that belongs to a [story](#story) and moves through its
[workflow](#workflow) on the Board. Also called a story task.

## CONWIP

"Constant work in progress": how a story admits its tasks. Only one task of a story
is in flight at a time — the next one (in story order) starts only when none of the
story's tasks is between `todo` and `done`. Rework keeps the story's place: moving a
task backward never lets another start. See
[Stories](02-stories-and-workflows.md#stories).

## Directory

The folder a story or task is worked in. Teammates move into it before starting, and
read its AGENTS.md.

## Directory affinity

How the daemon picks *who* gets work: a teammate prefers work in the folder it was
started in, then work with no directory, and only takes another folder's work when no
teammate is homed there. See [Teammates](03-teammates.md#how-a-teammate-works).

## Directory lease

How the daemon decides *whether* work can start: while a run is working (or
[at risk](#moribund)) in a directory, other work in that directory — or a folder
inside it, or one containing it — waits. "One teammate per directory" on
Config → Teammates. See
[One teammate per directory](03-teammates.md#one-teammate-per-directory).

## Dock

The panel beside every desktop page with the **Assistant**, **Team** and **Help**
tabs, plus the **+** and the queue summary. It sits on the left by default, or on the
right or across the bottom; it collapses to a rail of icons or goes
[full page](#full-page). Where it sits, its size and its mode are remembered in this
browser. See [Getting around](10-tips.md#getting-around).

## Full page

The [dock](#dock)'s biggest mode: it fills the area below the nav bar, which stays.
The page you were on is hidden, not closed. **Restore**, **Esc** in the dock, or going
to another page puts the dock back. See [Getting around](10-tips.md#getting-around).

## Harness

The agent program a teammate runs: Pi by default; Kiro and Claude Code are
experimental. See
[Teammates](03-teammates.md#experimental-kiro-and-claude-code-teammates).

## Inbox

The home page tab of finished [runs](#run), unread by default — your review queue.
See [The Inbox](01-tasks-and-runs.md#the-inbox).

## Leader

The one agent that isn't a teammate: the [assistant](04-assistant.md) you chat with,
started with `mpt lead`.

## Lost contact

A teammate the daemon has stopped hearing from. Its run becomes [at risk](#moribund).

## Manual state

A workflow step worked by you or the assistant — a review gate or an approval.
Moving the card onward is the completion.

## Mirror

The read-only copy MPT keeps of an item from a [source](#source). Change the item in
the source; each new revision runs once. See [Sources](07-sources.md).

## MORIBUND

A run whose teammate went silent mid-work — shown as **at risk** in the Queue. It's
reaped but not declared dead: it's restored if the teammate reconnects, or you
**force-fail** it (optionally starting a fresh run). See
[Runs](01-tasks-and-runs.md#runs-one-attempt-at-a-task).

## Pending

Written but not running yet. A pending task never runs until you **Activate** it;
a pending story or schedule is paused and can be activated again. See
[Pending](01-tasks-and-runs.md#pending-write-first-run-when-its-right).

## Persona

A markdown file that describes how to do a job (implementer, reviewer, triage…). It's
put at the top of the prompt. Workflow steps, triage, the assistant, tasks and sources
each pick one. See [Personas](06-personas.md).

## Plugin package

An npm package, git repository or local folder that adds [sources](#source) and/or
[personas](#persona) to a team. Managed with `mpt plugins`. To write one, see
[docs/PLUGINS.md](../PLUGINS.md).

## Queue

The home page tab of work in flight: at risk, waiting, and working
[runs](#run). See [The Queue](01-tasks-and-runs.md#the-queue).

## Readiness probe

A shell command the daemon runs every 30 seconds to ask "can this machine work right
now?". While it fails, scheduled jobs and automatic retries wait. See
[Readiness probe](08-configuration.md#readiness-probe).

## Run

One attempt at a task — what a teammate picks up. Internally a [WorkItem](#workitem).

## Run states

A run is **waiting** (`READY`), **working** (`IN_PROGRESS`), **at risk**
(`MORIBUND`), or finished: **COMPLETE**, **FAILED**, or **CANCELED** (canceled before
it ran). It never moves backward.

## Scheduled

A task run on a cron schedule — a **scheduled job** on **Work → Schedule**.

## Solitary

A standalone, one-off task you run on demand from **Work → Tasks**.

## Source

Short for *Work Source*: somewhere work comes from. Stories, tasks and schedules are
built in; an external source (a tracker, a ticket queue) comes from a
[plugin package](#plugin-package) and gets its own tab on **Work**. See
[Sources](07-sources.md).

## Story

A group of related [board tasks](#board-task) with an order, a [workflow](#workflow),
an optional directory, and dependencies on other stories. See
[Stories and workflows](02-stories-and-workflows.md).

## Teammate

One of the AI agents in the team's pool that do the work. See
[Teammates](03-teammates.md).

## Thread

A task's comments and attachments. It belongs to the task, not the run, so it carries
across attempts. See
[Comments and the thread](01-tasks-and-runs.md#comments-and-the-thread).

## Triage

A teammate reading something — a note, or an item from a triage-mode source — and
*proposing* work (tasks, story tasks, stories, scheduled jobs) for you to accept,
edit, or reject. Nothing it proposes runs until you say so. See
[Auto triage](05-thoughts-and-triage.md#auto-triage-notes-that-become-work).

## WorkDef

The internal name for a **task**: the authored definition of a piece of work — a Goal,
Acceptance Criteria and optional Additional Context. There are three kinds, by what
starts them: [board task](#board-task), [Solitary](#solitary), and
[Scheduled](#scheduled). See [Tasks and runs](01-tasks-and-runs.md).

## WorkItem

The internal name for a [run](#run): a single attempt at one WorkDef's work, the
actual unit teammates claim. Retrying always makes a fresh WorkItem.

## Workflow

The ordered list of steps a story's tasks go through, each an
[agent state](#agent-state) or a [manual state](#manual-state). See
[Workflows](02-stories-and-workflows.md#workflows).

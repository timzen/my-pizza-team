# User Guide

## Overview

My Pizza Team (MPT) is a work-coordination daemon for a team of AI **teammates**. You define work, and teammates execute it autonomously by draining a **queue** of work items. You review the results in an **Inbox**.

Teammates *are* AI agents — autonomous coding assistants (Pi, Claude Code, Codex, …) that connect to the daemon and poll for work. We call them "teammates" throughout the UI because that's how you work with them; "agent" is just the underlying technical term (and the one the HTTP API uses, e.g. `/api/agents`).

The web UI at `http://localhost:7437` is your control center.

---

## Core Concepts

### WorkDef — the unit of work

Everything a teammate does is defined by a **WorkDef**: a small authored document with a **Goal**, **Acceptance Criteria**, and optional **Additional Context**. There are three kinds, distinguished only by *what triggers them*:

- **Board task** — a WorkDef that belongs to a **Story** and moves through a **workflow**.
- **Solitary** — a standalone one-shot you run on demand (the **Tasks** page).
- **Scheduled** — driven by a cron **Schedule** (the **Schedule** page).

### Stories

A story groups related board tasks and gives them order + a workflow. Each story has an **ID**, **Title**, **Description**, a **Workflow**, an optional **Directory** (where the work happens), **Dependencies** (other stories that must finish first), and an ordered list of its tasks with each task's current status.

### WorkItems — the queue

A **WorkItem** is a single attempt to do one WorkDef's work — the actual unit teammates claim. It's deliberately dumb and terminal-only: it moves `READY → IN_PROGRESS → COMPLETE / FAILED` and never backward. Retrying is always a *fresh* WorkItem. A board task emits a WorkItem each time it enters an agent state (initial work + any rework); a Schedule emits one per cron tick; a Solitary WorkDef emits one when you hit **Run**.

If a teammate goes silent mid-work, its WorkItem becomes **MORIBUND** (reaped but not declared dead) — you can force-fail it (optionally re-enqueuing) or it's restored if the teammate reconnects.

### Workflows

A workflow is an ordered list of **states** a board task passes through, e.g. `todo → in_progress → review → done` (`todo`/`done` are implicit buckets). Each state is one of two types:

- **agent** — worked by teammates (claiming its WorkItem). Has an optional **persona** file — role framing injected into the prompt for that state.
- **manual** — worked by you or the leader; moving the card onward *is* the completion (review gates, approvals).

**Workers never move tasks.** Completing an agent state advances the task automatically; you make the judgment moves (send to review, approve, send back for rework). There are no per-transition permissions to configure — just the state type.

### Teammates

Teammates are a **flat generalist pool** — no skills or capabilities to configure. Each registers its **working directory** (its startup cwd), and the daemon biases work by **directory affinity**: a teammate prefers WorkItems whose story/WorkDef names its directory, then un-homed work, and only reaches into another directory's work when no teammate is homed there. They loop:

1. Poll for a `READY` WorkItem (chosen by directory affinity)
2. Claim it (→ `IN_PROGRESS`); receive the daemon-assembled prompt
3. Do the work (cd-ing into the WorkDef's directory)
4. Set the outcome — **COMPLETE** (the task advances) or, if blocked, post a comment and mark it **FAILED** (the task is left stuck for you)

---

## Navigation

The nav bar has four destinations, plus help/config/theme icons:

- **Board** — story swimlanes; sub-tabs for Backlog, Archive, and Workflows.
- **Tasks** — standalone Solitary WorkDefs.
- **Schedule** — cron-driven Scheduled jobs.
- **Context** — the reusable context library.

The **home page** (`/`) has a quick-create row (New Story / Solitary Task / Scheduled Job / Spawn Teammate) over two tabs: **Inbox** and **Assistant**.

### Inbox

The Inbox is your review queue: completed WorkItems (**COMPLETE** and **FAILED**), unread by default. Each row links to the work it came from — a board task opens its task page, standalone work opens its WorkDef page — where the completion summary lives as a comment. Clicking a row marks it read.

---

## The Board

The board (`/board`) shows active stories as horizontal swimlanes with task cards arranged by workflow state.

### Creating a Story

Use **New Story** (from the home quick-create row, or `/stories/new`):

1. **ID** — a URL-safe identifier
2. **Workflow** — which workflow governs this story's tasks
3. **Title** & **Description** (markdown)
4. **Directory** — where teammates work (also the affinity bias)
5. **Context** — context-library entries injected into every task's prompt
6. **Tasks** — optionally add initial tasks inline

### Managing tasks

The board is for glancing and light triage; editing happens on the task page.

- **Add a task** — the `+` on a story swimlane
- **Move a task** — drag its card to another column (that's how you send to review, approve, or send back for rework)
- **Open a task** — the `details →` link opens the task page (edit title/description/context, move, delete, read comments, upload/review files)
- **Edit a story** — click the story title to open its page (title, description, directory, context, paused)

A card shows its title/ID, assignee, cost (if tracked), and a small chip when it has an active WorkItem: **queued** (READY), **working** (IN_PROGRESS), or **at risk** (MORIBUND).

---

## Tasks & Schedule (standalone work)

Not all work belongs on the board. Two pages manage standalone WorkDefs:

- **Tasks** — **Solitary** one-shots. Create one, then hit **Run** to enqueue it whenever you want it done. Good for ad-hoc chores ("audit dependencies").
- **Schedule** — **Scheduled** jobs. Each is a WorkDef attached to a cron **Schedule**; the daemon enqueues a run every time the cron fires, and **Run now** triggers one immediately.

Both use the same create form (`New Solitary Task` / `New Scheduled Job`). **Acceptance criteria** are entered as an add-as-you-go checklist, and each line gets a live badge scoring it against [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — normative (MUST/SHALL), recommended (SHOULD), optional (MAY), or vague — nudging you toward testable, unambiguous criteria.

---

## Workflows

The **Workflows** tab (under Board) lists workflow definitions.

### Viewing / editing a workflow

Open a workflow to see its ordered states and edit them: add/remove states and set each state's **type** (**agent** or **manual**). There are no transitions or permissions to configure — the pipeline is the ordered list, and the daemon advances agent states automatically.

### State personas

Each **agent** state can have a markdown **persona** file — role framing the teammate receives when working that state (implementer, reviewer, CR-writer, …). Write clear, actionable guidance; it's injected into the prompt verbatim.

---

## Teammates

Teammates appear in a persistent right-hand column on every page, grouped by role — leader, assistant, and the teammate pool — each showing status, current work, and its working directory. Below them, a **Queue** section lists non-terminal WorkItems with recovery actions.

### Spawning

Click **Spawn** to request a teammate:
- **Host** — which machine starts it
- **Working Directory** — where it operates (this is its affinity bias)

### Recovery actions (the Queue section)

- **Cancel** a `READY` item you don't want run.
- **Force-fail** a `MORIBUND` item (a teammate that went silent), optionally **re-enqueuing** a fresh attempt.

### Managing a teammate

- **Reset** (↺) — clears its context window (the harness realizes this as Pi's `/new`).
- **Dismiss** (🗑) — removes it.

### Pausing distribution

The **pause button** (⏸) in the navbar stops the daemon from handing out new WorkItems; in-flight work continues. Use it while reorganizing.

---

## Comments & Review

Comments are the channel between you and your teammates, and they live on the **work** (the task or WorkDef), not the WorkItem — so they persist across attempts:

- **You → Teammate**: comment on a task to give feedback or answer questions.
- **Teammate → You**: teammates post their completion summary as a comment when they finish (that's what you review in the Inbox).

When a teammate completes an agent state, the task advances to the next state. If that's a **manual** state (like `review`), it waits for you: review the work and any attached diffs, then **drag it forward** (approve → `done`) or **back** (send to rework) with a comment explaining what to fix. Moving it back into an agent state enqueues a fresh WorkItem, and the teammate picks it up again with your comments in the prompt.

---

## Context Library

The **Context** page stores reusable prompt/context entries to inject into teammates or the assistant.

- **Metadata** — title, short description, tags
- **Filter** — tag chips + free-text search (client-side; the collection is meant to stay small)
- **Markdown body** — the prompt/context text itself

Good things to keep: coding conventions, architecture decisions, common patterns/gotchas, project-specific context.

### Attaching context to work

Attach entries to a **story** (applies to all its tasks) or an individual **WorkDef** from its editor. Attached entries are inlined into the prompt under a **Reference Context** section when a teammate claims the work — so the daemon vends the right context to every harness, no per-agent tools needed.

### Assistant personas

Tag a context entry with **`persona`** to make it a swappable assistant persona. On the Assistant tab, persona entries appear as chips above the chat; picking one starts a fresh chat with that entry as the assistant's system prompt. **Default** returns to the built-in persona. Swapping resets the assistant's context window.

---

## Thoughts

A personal workspace — the **Thoughts** tab on the home page (alongside Inbox and Assistant). An infinite canvas of markdown sticky notes you can pan, zoom, drag, color, pin, and group.

- **Capture** — hit **+ Note** and write markdown; checklists (`- [ ] task`) render as checkboxes you can tick right on the note.
- **Organize** — drag notes around, group related ones (they get a labeled, tintable plate), pin the important ones, **Tidy** to grid-arrange, archive what's done. Select mode (`S`) or shift+drag marquee-selects; `Delete` archives, `1–6` recolor, `G` groups, `M` toggles the minimap.
- **Assistant access** — the assistant can *read* your notes ("look at the thoughts in the Q3 group and help me draft a task") and turn them into stories/tasks/schedules that flow to your Inbox, and *write* the board (leave a follow-up note, annotate, archive, group).

Notes live under the team directory as `thoughts/<id>.md` (markdown + frontmatter) — easy to hand-edit or grep; groups are in `groups.json`.

---

## Configuration

Visit `/config`:

- **General** — port, session, autosave (flush/commit cadence)
- **Teammates** — name generation
- **Theme** — palette (a client-side preference)

---

## Tips

- **Write testable acceptance criteria** — use RFC 2119 keywords (MUST/SHOULD/MAY). The editor scores them for you.
- **Home the right teammates** — a teammate started in a repo preferentially picks up that repo's work. Spawn teammates where the work is.
- **Review early** — drain the Inbox; quick feedback loops keep teammates productive.
- **Use workflow personas** — give each agent state phase-specific role framing.
- **Use the context library** — store patterns and decisions so every teammate works consistently.
- **One story per concern** — small focused stories beat one giant story.
- **Standalone for chores** — recurring or ad-hoc work that isn't a feature belongs on Tasks/Schedule, not the board.

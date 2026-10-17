# User Guide

## Overview

My Pizza Team (MPT) is a work-coordination daemon for a team of AI **teammates**. You define work, and teammates execute it autonomously by draining a **queue** of work items. You review the results in an **Inbox**.

Teammates *are* AI agents — autonomous [Pi](https://pi.mariozechner.at/) coding agents, each running in its own tmux window, that connect to the daemon and poll for work. We call them "teammates" throughout the UI because that's how you work with them; "agent" is just the underlying technical term (and the one the HTTP API uses, e.g. `/api/agents`). The **leader** is the one agent that isn't a teammate: it's the one you chat with (start it with `mpt lead`).

The web UI at `http://localhost:7437` is your control center.

---

## Core Concepts

### WorkDef — the unit of work

Everything a teammate does is defined by a **WorkDef**: a small authored document with a **Goal**, **Acceptance Criteria**, and optional **Additional Context**. There are three kinds, distinguished only by *what triggers them*:

- **Board task** — a WorkDef that belongs to a **Story** and moves through a **workflow**.
- **Solitary** — a standalone one-shot you run on demand (the **Tasks** page).
- **Scheduled** — driven by a cron **Schedule** (the **Schedule** page).

### Drafts — write first, publish when it's right

Any WorkDef can start as a **draft**: **Save as draft** on the create forms (**Save tasks as drafts** on New Story), or ask the assistant to write tasks up "as drafts" for you to review. A draft carries an amber **Draft** badge and **never runs** — no Run, no cron, and on the board it **holds its place**: the story waits at that task (later tasks don't jump ahead) until you publish it.

While it's a draft, you and the assistant can both revise it: open it and press **Edit** (Save draft / Cancel). When it's right, press **Publish**. Publishing is one-way and **locks the definition**: a Solitary task is enqueued straight away, a board task is picked up when its story reaches it, and a scheduled job fires on its next cron time. To change published work, do what you always do — add a comment on its **Thread** and **Run** it again (for a board task, move it back into an agent state); the comments go into the next attempt's prompt. A scheduled job's **cron** stays editable after publishing — it belongs to the schedule, not the definition.

Everything created before drafts existed counts as published.

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

**One teammate per directory.** While work runs in a directory, other work for that directory (or a folder inside it, or one containing it) waits its turn, so two teammates never edit and commit in the same checkout at once. Work with no directory always runs in parallel. Turn this off under **Config → Teammates → One teammate per directory**.

---

## Navigation

The nav bar has five destinations, plus pause / **usage** / help / config / theme icons:

- **Thoughts** — sticky notes, where ideas start: a canvas, or a list with folders.
- **Board** — story swimlanes; sub-tabs for Backlog, Archive, and Workflows.
- **Tasks** — standalone Solitary WorkDefs, with a **Templates** tab.
- **Schedule** — cron-driven Scheduled jobs.
- **Context** — the reusable context library.

Board, Tasks, and Schedule only appear while their kind is switched on under **Config → General → Work items** (a new team starts with Tasks only; see [Work items](#work-items-feature-toggles)).

The highlighted destination is the section you're in, detail pages included: a Solitary task's page lights **Tasks**, a scheduled job's lights **Schedule**, a story or board task lights **Board**. The ← back arrow on a detail page returns to wherever you opened it from (the Inbox, a teammate, the Usage page…); only when there's nowhere in-app to go back to (say, a link opened in a new tab) does it take you to that section's list.

The **home page** (`/`, the pizza logo) has two tabs — **Queue | Inbox** — work in flight, then finished work. The pizza logo carries two small count badges, each hidden at zero: a **neutral** one (bottom corner) for WorkItems **queued** and not yet picked up, and an **accent** one (top corner) for **unread** Inbox items. Hover a badge for what it counts. They stay on the icon when the nav bar is too narrow for the "Pizza Team" wordmark, refresh every ~10 seconds, and update right away when you mark Inbox items read or unread. Quick-create (the **+** beside the queue summary) and the assistant live in the left dock, on every page.

### Queue

The Queue is work **in flight** — every WorkItem that hasn't finished — grouped by what it needs from you:

- **At risk** (MORIBUND, amber) — its teammate went silent mid-work. Nothing retries it automatically: **Force-fail** it, or **Re-enqueue** a fresh attempt.
- **Waiting** (READY) — not picked up yet, with how long it's waited. **Cancel** it if you don't want it run. If waiting work is stuck, a banner says why (distribution paused, no teammates online, everyone busy). Work in a paused story, or one waiting on a dependency, isn't offered to anyone. An item whose directory is busy reads **waiting — directory busy (teammate, item)**. It starts when that item finishes. If the busy item is *at risk*, force-fail it to free the directory.
- **Working** (IN_PROGRESS) — which teammate has it (click through to watch it) and for how long.

You don't have to open the tab to keep an eye on it: the **queue summary** at the top of the left dock (the row beside the nav bar, above both tabs) always shows the counts — `2 waiting · 1 working`, with **at risk** in amber. **Hover** it to preview every item and its status; click it to open the Queue tab. With the dock collapsed, the rail's ⏱ badge (amber when anything is at risk) does the same.

### Inbox

The Inbox is your review queue: completed WorkItems (**COMPLETE** and **FAILED**), unread by default. Each row links to the work it came from — a board task opens its task page, standalone work opens its WorkDef page — where the completion summary lives as a comment. Clicking a row marks it read.

---

## The Board

The board (`/board`) shows active stories as horizontal swimlanes with task cards arranged by workflow state.

### Creating a Story

Use **New Story** (from the dock's **+** menu, or `/stories/new`):

1. **ID** — a URL-safe identifier
2. **Workflow** — which workflow governs this story's tasks
3. **Title** & **Description** (markdown)
4. **Directory** — where teammates work (also the affinity bias). Pick from the dropdown — your **favorite directories** first, then recently used ones — or type a path (see [Favorite directories](#favorite-directories))
5. **Context** — context-library entries injected into every task's prompt
6. **Tasks** — optionally add initial tasks inline

### Managing tasks

The board is for glancing and light triage; editing happens on the task page.

- **Add a task** — the `+` on a story swimlane
- **Move a task** — drag its card to another column (that's how you send to review, approve, or send back for rework)
- **Open a task** — the `details →` link opens the task page (read it — or **Edit**/**Publish** it while it's a [draft](#drafts--write-first-publish-when-its-right) — move, delete, read comments, upload/review files)
- **Edit a story** — click the story title to open its page (title, description, directory, context, paused)

### Expanding and collapsing stories

Every story starts **expanded** (its task columns showing). The chevron at the left of a story's header collapses it to just the header row — the title and its actions (`+`, archive, backlog) — and clicking it again expands it. **Expand all** / **Collapse all** in the toolbar (next to search and sort) apply to the stories currently shown, so with a search active they only touch the matching stories. Searching doesn't expand collapsed stories. The board remembers each story's choice in this browser.

A card shows its title/ID, assignee, cost (if tracked), and a small chip when it has an active WorkItem: **queued** (READY), **working** (IN_PROGRESS), or **at risk** (MORIBUND).

---

## Tasks & Schedule (standalone work)

Not all work belongs on the board. Two pages manage standalone WorkDefs:

- **Tasks** — **Solitary** one-shots. Create one, then hit **Run** to enqueue it whenever you want it done. Good for ad-hoc chores ("audit dependencies"). Drafts show **Publish** instead of Run; the **All / Drafts / Published** buttons filter the list. Each row shows how many times the task has run ("never run", "1 run", "3 runs" — hover for the last run); **Never run** narrows the list to the ones you haven't started yet, and the sort menu orders by **Fewest runs** / **Most runs**. A run is any WorkItem created for the task — queued, running, done, or failed — except one you **canceled** before it ran.
- **Schedule** — **Scheduled** jobs. Each is a WorkDef attached to a cron **Schedule**; the daemon enqueues a run every time the cron fires, and **Run now** triggers one immediately. Each row shows its run count and last run.

A task's or job's page (and a board task's page) shows the same run count in its header. Templates have none — they never run.

A failed run leaves the WorkDef in place — read its Thread, add a comment with what to change, and **Run** it again (a published definition is locked; see [Drafts](#drafts--write-first-publish-when-its-right)).

### Templates

The **Templates** tab (on the Tasks page) holds reusable molds for one-shots you write again and again ("investigate a ticket"). A template has the same fields as a task but never runs itself: **New Task** on a template (or **Task from Template** on the Tasks page) opens a pre-filled Solitary task form.

Both pages use the same create form (`New Solitary Task` / `New Scheduled Job`). **Acceptance criteria** are entered as an add-as-you-go checklist, and each line gets a live badge scoring it against [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — normative (MUST/SHALL), recommended (SHOULD), optional (MAY), or vague — nudging you toward testable, unambiguous criteria.

---

## Workflows

The **Workflows** tab (under Board) lists workflow definitions.

### Viewing / editing a workflow

Create a workflow by name (it starts as `in_progress` → `review`). Open one to see its ordered states and edit them: add/remove states and set each state's **type** (**agent** or **manual**), or make it the default. There are no transitions or permissions to configure — the pipeline is the ordered list, and the daemon advances agent states automatically. Every story picks its workflow when it's created.

### State personas

Each **agent** state can have a markdown **persona** file — role framing the teammate receives when working that state (implementer, reviewer, CR-writer, …). Write clear, actionable guidance; it's injected into the prompt. Saving checks it: an unclosed code fence is rejected (it would swallow the rest of the prompt), and headings are nested under the prompt's own sections automatically.

---

## Teammates

Teammates live in the **Team** tab of the left dock (beside the **Assistant** tab), on every page — the teammate pool (the leader isn't listed: it's the agent you talk to on the Assistant tab), each showing its status, the model it's running (hover for provider/id), current work, working directory, how full its context window is, and what its session has cost so far. The icon *is* the status — **person**: pairing with you · **bot**: waiting for work · **spinning loader**: working · **cloud with a slash**: lost contact (hover it for the words). The gauge shows the context window's fill (hover for exact tokens; `?` just after Pi compacts, until its next reply), then the session's cost; both reset when the teammate starts a fresh session for its next work item. On the Assistant tab you can still see the team at a glance: the Team tab shows how many are online, and an amber dot when a team size can't be met (at-risk work shows in the queue strip instead). The collapsed dock shows everyone as avatars.

### Watching a teammate

Click a teammate to watch it work, live, in the middle of the page — its prompt,
its reasoning (folded), what it says, and every tool call with a preview of the
output, like looking over its shoulder at the terminal. Its row stays
highlighted while you're watching.

- It's **watch-only**: nothing you do there reaches the teammate.
- It starts **when you start watching** (a "watching from …" line) — there's no
  history from before. The work item link in the header has the full prompt and
  thread.
- A teammate nobody is watching doesn't stream anything, so leaving the page
  costs nothing.

### Pairing with a teammate

Watching never interrupts anything. To talk to a teammate, click **Pair**: it
stops taking new work and won't mark its current item done while you're
talking, and a message box appears.

- **Enter** queues your message — it lands when the teammate finishes what it's
  doing right now. **⌘↵** (or **Steer**) cuts in at its next tool step.
- Your messages show up in the transcript as `[you · queued]` / `[you · steer]`
  once it has them.
- When you're done, hand it back: **Resume** (it carries on with its work
  item), **Complete** (the item is done — its last reply becomes the summary),
  or **Fail** (the item is marked failed and the task waits for you). If it's
  mid-step, the release waits for that step to finish.

### Team size (how teammates get created)

You don't spawn teammates one at a time — you **declare how many you want**. The
Team tab's row (right of the tabs, while Team is showing) has two icons:

- **Team size** (people icon) — the steady size of the teammate pool: set `3`
  and the daemon keeps three teammates online, spawning replacements whenever one
  is dismissed, crashes, or goes silent long enough to be reaped. An amber dot on
  the icon means no leader is connected, so the pool can't grow yet.
- **Spawn** (person-plus icon) — start one teammate in a specific directory (see
  below).

Details:

- Default is **half of Max Teammates** (rounded down — 2 with the default max
  of 4). Set **0** to spawn nothing; **Use default** in the dialog clears your
  value back to the default.
- The number is saved in `config.json` (also editable as **Min Teammates** on
  Config › General — leave it blank for the default), so it's the target the
  daemon applies at startup.
- It's capped by **Max Teammates**, and it waits for the **leader** to be
  connected (`mpt lead`). Until one is, the dialog tells you so. The daemon starts
  the tmux windows itself; if it can't reach tmux, the leader does.
- Lowering the number never kills anyone: it just stops replacements. Dismissing
  a teammate stays your call (but with a non-zero minimum, expect a fresh one to
  take its place).
- Pool teammates spawn in the leader's working directory. To home a teammate in
  a specific repo, use **Spawn** and pick the directory — directory affinity then
  biases that repo's work toward it. It counts toward the team size like any
  other teammate.

The **leader** isn't part of the pool: there is exactly one, and it's the agent
the chat talks to.

The Team tab also shows **pending spawns** (starting up) and **failed spawns** with
the reason (e.g. a directory that doesn't exist) — dismiss a failed one once you've
seen it.

### Experimental: Kiro and Claude Code teammates

A team can also run **Kiro** or **Claude Code** teammates alongside Pi ones. They're
experimental, so they're off until the team opts in and the machine is prepared (`mpt
setup --harness kiro` or `--harness claude`). Opt in under **Config → Teammates →
Experimental Harnesses** — tick **Enabled** and **Save**; it applies immediately, no
restart. (Or set `"experimental": { "harnesses": true }` in `config.json` by hand and
restart the daemon.) Then the **Spawn** dialog has a **Harness** choice.

The same section sets the **Default Harness** — what a spawn that doesn't pick one
uses, including the teammates the daemon keeps online. It's only selectable while
experimental harnesses are on; turning them off resets it to Pi (the daemon won't
save a non-Pi default without the opt-in).

They pick up work like any teammate: each item in a fresh session, finished with a
summary in its thread, or given up with a reason. You can watch them live; their row
shows the harness. Not yet: **Pair** (the button is disabled for them) and **Reset**
(they start every item fresh anyway). Claude Code's usage and cost appear on the Usage
page; Kiro's don't, since it reports credits rather than dollars.

### After an upgrade

`mpt upgrade` updates the daemon and the Pi extension together, but running
agents keep the old code until they restart. The Team tab marks each out-of-date
teammate and shows a banner with a **Restart** button that rolls them all (their
context is cleared). Restart the leader yourself (`mpt lead` after quitting it).
An agent too old to speak the daemon's protocol is refused at startup with a
message saying so.

### Recovery actions (the Queue tab)

- **Cancel** a `READY` item you don't want run.
- **Force-fail** a `MORIBUND` item (a teammate that went silent), optionally **re-enqueuing** a fresh attempt.

### Managing a teammate

- **Reset** (↺) — clears its context window (the leader realizes this as Pi's `/new`, so it needs the leader running).
- **Dismiss** (🗑) — removes it; the teammate shuts itself down on its next heartbeat. With a non-zero team size, a replacement takes its place.

### Pausing distribution

The **pause button** (⏸) in the navbar stops the daemon from handing out new WorkItems; in-flight work continues. Use it while reorganizing. It isn't saved — restarting the daemon resumes distribution. To hold just one story, mark it **paused** on its page.

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

## The Big Editor

For anything longer than a line, open the text in a full-screen editor — the web UI's version of Ctrl+G in Pi or Claude Code. It works in the **assistant chat** and the **pairing box** on a teammate's page. **Notes** and **descriptions** (a story's description, a task's goal and additional context) don't need it: their **Edit** mode *is* this editor, inline — with the same **Vim** switch beside Preview and the same mode line under the text (see [Thoughts](#thoughts)).

- **Open it** with the **Edit** button beside the text box, **Ctrl+G** while typing, or by sending **`/editor`** in a chat box (`/editor some text` brings the text with you).
- **Vim keys are on by default.** Don't want them? Click **Vim: On** in the header to turn them off — it's remembered. With vim on, the editor opens ready to type; **Esc** switches to normal mode, and the bar at the bottom always shows the mode and how to get out.
- **Finish** with **Done**, **⌘S**, or `:wq` (vim) / **Esc** (no vim) — your text goes back into the box. In a chat box, **⌘↵** (or the **Send** button) sends it straight away. **Discard** (or `:q!`) closes without keeping changes.
- **Write markdown comfortably** — line numbers, Enter continues lists and checklists, Tab indents, ⌘F searches, and **Preview** shows the rendered markdown beside the text.

## Thoughts

A personal workspace — **Thoughts** in the top nav (`/thoughts`). Markdown sticky notes, organized into groups, with two ways to look at them — switch with **Canvas | List** at the right end of the toolbar (your choice is remembered). Both views share that toolbar: **+ Note** is always first, and **Archived** and the switch always sit at the right; the buttons in between belong to the view you're in.

- **Canvas** — an infinite board you can pan, zoom, drag, and group on.
- **List** — like Apple Notes or OneNote: notes down the left, grouped into folders, and the selected note in full on the right.

### Canvas

- **Notes are all the same size** on the canvas, so the board scans as a board; a long note shows its start and fades out.
- **Open a note** to read or write it in full: **double-click** it, click the **⤢** icon in its corner (on hover), or select it and press **Enter**. The large view opens in Preview (Edit for a new or empty note — double-click the text or hit **Edit** to write). Its header has everything else: **color**, pin, group, copy id, the **Vim** switch (while writing), archive, delete. Closing it any way (Esc, Done, clicking outside, ⌘↵) **saves** — there's no way to lose an edit.
- **Capture** — hit **+ Note**; it opens straight into the editor. Checklists (`- [ ] task`) render as checkboxes you can tick on the canvas or in the large view.
- **Group by dragging** — drag a note **onto a group** to add it: once it's about half over (or your pointer is), the group highlights and **grows to wrap it**, showing where it'll land before you let go. Drag a member **off every group** to take it out (its border goes dashed while it's leaving).
- **Resize a group** with the grip on its bottom-right corner (a group always wraps its notes, so it won't shrink past them). Dragging a selection moves them all. Moving a group carries its notes; moving a group over loose notes doesn't absorb them — only a drop changes membership.
- **Organize** — pin the important ones, **Tidy** to grid-arrange, archive what's done. Select mode (`S`) or shift+drag marquee-selects; `Delete` archives, `1–6` recolor the selection, `G` groups it, `M` toggles the minimap (shown by default; your choice is remembered). Alongside it, a row of **group chips** — biggest group first — jumps the canvas to center that group when clicked.
### List

- **Folders are your groups** — alphabetical, each with its note count. Click one to collapse or expand it (remembered). Notes in no group are listed after the folders, under **Notes**. In each folder, pinned notes come first, then the most recently edited.
- **Click a note** to read it on the right; **↑ / ↓** move through the list. A note's title is its first line.
- **Write** — the right side is the same editor as the canvas's large view (Preview, or **Edit** / double-click the text), with the color, pin, group, archive, and delete controls above it. There's nothing to close: edits **save as you type**, and switching notes saves too. ⌘↵ returns to Preview.
- **File a note** — drag it onto a folder, or onto **Notes** to take it out of every folder. The group picker above the note does the same. On the canvas it moves into (or out from under) that group, so both views stay in step.
- **+ Note** makes a note in the current note's folder; **Folder** makes a new folder and lets you name it straight away. **Double-click** a folder to rename it; its **×** deletes the folder but keeps its notes.
- **Search** filters notes by their text; folders with matches open automatically.
- Switching views keeps your place: the note selected in one is selected (and, on the canvas, centered) in the other.

### Both views

- **Writing a note** uses the same editor as the [big editor](#the-big-editor) — line numbers, lists that continue on Enter, and **vim keys on by default**. Click **Vim: On** in the note's header to turn them off (remembered, and shared with the big editor). With vim on, a note opens ready to type; the line under the text shows the mode and what to press. `:w` or ⌘S saves, and `:wq` (or ⌘↵) finishes — back to Preview in the list, closed on the canvas. With vim on, **Esc** is vim's and doesn't close the canvas's large view; there's no discard — `:q!` finishes too.

- **Auto triage** — every hour, a teammate reads the notes whose text you've changed and proposes what should become work. It waits about ten minutes after your last edit, so it never reads a half-written thought.

  Nothing appears on the note itself except a small **badge**: a lightbulb when there's work waiting on your decision, a **?** when the teammate needs something from you, a **–** when it read the note and found nothing to create. The badge — and the run's **Inbox** row, which is the real notification — opens the note's **triage page**.

  There you get the note on one side and the analysis on the other, with each proposal (a task, a task in one of your stories, a whole story, or a scheduled job) offering **Accept**, **Edit**, and **Reject**. **Accept** creates it and nothing more: a standalone task waits for you to press Run, a scheduled one waits for its cron, and a task added to a story takes its place in that story's workflow exactly as one you added by hand would. **Edit** is the same thing with the fields opened up first, for "nearly right, but…". **Reject** takes one click and needs no reason.

  Then it's **your turn** — and your turn is the note: edit it and the next sweep re-reads it. That's how you answer a question, and how you steer a proposal you didn't like; the next analysis is told what you accepted and rejected, so it won't offer the same thing twice. Accepting and rejecting aren't turns, so they don't trigger a fresh run.

  A run that fails isn't retried on its own — **Triage now**, on the triage page, forces one. Turn triage off, change its timing, or rewrite the instructions it follows in **Config → General**. Archiving a note stops its triage; deleting one removes its analysis with it.

- **Assistant access** — the assistant can *read* your notes ("look at the thoughts in the Q3 group and help me draft a task") and turn them into stories/tasks/schedules that flow to your Inbox, and *write* the board (leave a follow-up note, annotate, archive, group).

Notes live under the team directory as `thoughts/<id>.md` (markdown + frontmatter) — easy to hand-edit or grep; groups are in `groups.json`. A note's "edited" time changes only when its text does — moving, recoloring, pinning, or filing it doesn't count.

---

## Usage

The chart icon in the nav opens **Usage** — what the team is spending, in tokens and dollars:

- **Tiles** — today, the last 7 and 30 days, the past year, and the peak day (by tokens or cost, whichever the grid shades by).
- **The grid** — one square per day for the past year, darker for busier days (shade by **Tokens** or **Cost**). **Hover** a day for its tokens, the full breakdown (input, output, cache read, cache write), cost, number of runs, and how it split between teammate work, the assistant chat, and pairing. **Click** it to list that day's runs, most expensive first.
- **Where it went** — the year split by kind, by cost or tokens.
- **What do these mean?** — a collapsed glossary at the bottom.

Every agent run is counted: teammates' work items, their runs while you pair with them, and the assistant chat. **Token figures leave out cache reads by default** — earlier prompt tokens reused from the cache are cheap and pile up fast on long sessions, swamping everything else. Tick **Include cached** (next to Tokens/Cost; remembered in this browser) to add them back. Cache writes always count. The cost is the harness's own figure, already cache-aware, and doesn't change with the toggle. History is kept even after its story is archived or deleted.

The ledger is saved **in the team directory**, committed with your stories and config: `usage/YYYY-MM.jsonl`, one JSON line per run — easy to `grep` or `jq`, and it travels with the repo. (The daemon's SQLite database is just a cache of it, rebuilt on startup.)

---

## Configuration

Visit `/config`:

- **General** — the **Work items** toggles, port, tmux session, team size (min/max teammates), default workflow, the **readiness probe**, **favorite directories**, autosave (flush/commit cadence, auto-commit)
- **Teammates** — the nouns used to name teammates, and **Experimental Harnesses** (opt in to Kiro / Claude Code teammates and pick the default harness; applies on save, no restart)
- **Theme** — palette (a client-side preference; light/dark is the navbar toggle)

### Work items (feature toggles)

**Config → General → Work items** picks the kinds of work your team uses: **Stories** (the Board, with Backlog, Archive, and Workflows), **Tasks** (standalone Solitary tasks *and* Templates), and **Schedules** (the Schedule page). A brand-new team starts with Tasks only; a team that existed before the toggles has everything on. Tick or untick, then **Save Configuration** — it applies right away, no restart.

When a kind is off:

- its nav link (**Board**, **Tasks**, or **Schedule**) disappears, and so does its entry in the dock's **+** quick-create menu (with all three off, the **+** goes too);
- its pages — lists, detail pages, and create forms — show a "turned off" notice with a link back here, even from a bookmark;
- a triage proposal of that kind can only be **Rejected** (Accept and Edit are disabled until you turn the kind back on);
- the API, the `mpt` CLI, and the assistant's tools refuse it too.

**Thoughts**, **Context**, the **Queue**, and the **Inbox** are always there — even with every kind off — and finished work stays in the Inbox.

You can only turn a kind off when it has no active work: a toggle that's still in use is greyed out with what to clear first (e.g. "archive or delete 3 stories first"). Backlogged stories and drafts count; archived ones don't. Turning a kind back on is always allowed.

### Readiness probe

If your machine sometimes can't work (expired credentials, VPN down), set a **readiness probe**: a shell command the daemon runs every 30 seconds. Exit 0 means ready; anything else means not ready, and its first line of output is the reason. While not ready, **scheduled** jobs are held instead of run — and when it recovers, each held job runs once (not once per missed tick). Board and Solitary work still run. With no probe, the team is always ready.

### Favorite directories

Every directory field — New Story, a story's page, New Task, a WorkDef or template, a triage proposal's edit form, and **Spawn** — has a dropdown of suggestions: your **Favorites** first, then **Recent** directories (where teammates are working now, then recent work and story directories). Click the ☆ on any row to favorite it (★ to unfavorite), or the ☆ inside the field to favorite the path you typed. Manage the list under **Config → General → Favorite Directories**; changes save immediately (no Save button). Paths are stored resolved — `~` expanded and symlinks followed — so `~/repo` and its real path are the same favorite.

### Autosave

Your stories, tasks, notes, and usage are plain files in `.my-pizza-team/`. If that folder is inside a git repository, mpt commits it periodically (only that folder — never your own work) and pushes if there's a remote. Turn it off with **Auto Commit**.

---

## On Your Phone

Open MPT on a phone and you get the **phone view** (`/m`): a quick way to check on
the team, not the whole app. Four tabs along the bottom:

- **Team** — your teammates (what each is working on, its model, context fill, and
  cost), then the queue: at risk, waiting, working, with **Force-fail** /
  **Re-enqueue** / **Cancel**. Tap a teammate to watch it live, or **Pair**. The
  tab gets an amber dot when something is at risk.
- **Chat** — the assistant chat, with history. On a phone **Enter starts a new
  line**; tap ➤ to send. The tab shows how many replies you haven't read.
- **Thoughts** — your notes as a list, in their folders, with search. Tap one to
  read it (checklists are tappable), ✏️ to write (it saves as you type), and change
  its color, pin, archive, or delete it. **+ Note** starts a new one.
- **Inbox** — finished work. Tap a row to read its summary right there (that marks
  it read); **Open full** goes to the task's page in the full UI.

The strip under the header is the queue summary, and ⏸ shows when distribution is
paused. 🖥 switches this device to the full UI, and it stays there until you open
`/m` again. Boards, tasks, schedules, workflows, team size, and config are only in the
full UI (so the Work items toggles don't change the phone view; **Open full** on an
item of a switched-off kind shows the "turned off" notice).

**Getting to it from your phone.** MPT listens only on the machine it runs on. To
reach it from a phone, put a tunnel in front of it that handles login (for example,
an SSO-protected tunnel service your company provides), and open its URL in a browser
that can sign in to it. Set an API token too: the phone asks for it once.

---

## Tips

- **Write testable acceptance criteria** — use RFC 2119 keywords (MUST/SHOULD/MAY). The editor scores them for you.
- **Home the right teammates** — a teammate started in a repo preferentially picks up that repo's work. Use **Spawn** to put one where the work is (pool teammates spawn in the leader's directory).
- **Review early** — drain the Inbox; quick feedback loops keep teammates productive.
- **Use workflow personas** — give each agent state phase-specific role framing.
- **Use the context library** — store patterns and decisions so every teammate works consistently.
- **One story per concern** — small focused stories beat one giant story.
- **Standalone for chores** — recurring or ad-hoc work that isn't a feature belongs on Tasks/Schedule, not the board.

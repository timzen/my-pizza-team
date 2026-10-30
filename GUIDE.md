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
- **Solitary** — a standalone one-shot you run on demand (**Work → Tasks**).
- **Scheduled** — driven by a cron **Schedule** (**Work → Schedule**).

### Pending — write first, activate when it's right

Any WorkDef can start as **pending**: **Save as pending** on the create forms (**Save tasks as pending** on New Story), or ask the assistant to write tasks up "as pending" for you to review. A pending task carries an amber **Pending** badge and **never runs** — no Run, no cron, and on the board it **holds its place**: the story waits at that task (later tasks don't jump ahead) until you activate it.

While it's pending, you and the assistant can both revise it: open it and press **Edit** (Save / Cancel). When it's right, press **Activate**. Pending stories, Solitary tasks, and scheduled jobs are listed on **Work → Pending** — the Board, Tasks, and Schedule tabs show only active work (a pending board task stays in its story's swimlane, holding its place). Activating is one-way and **locks the definition**: a Solitary task is enqueued straight away, a board task is picked up when its story reaches it, and a scheduled job fires on its next cron time. To change active work, do what you always do — add a comment on its **Thread** and **Run** it again (for a board task, move it back into an agent state); the comments go into the next attempt's prompt. A scheduled job's **cron** stays editable after activating — it belongs to the schedule, not the definition.

Everything created before pending existed counts as active. (Pending used to be called *draft*, and Activate was *Publish*; old drafts show up as pending.)

**Stories can be pending too — and back again.** A whole story can be **pending**: tick **Pending** on New Story, press **Make pending** on its page (or the ⌛ on its swimlane), or ask the assistant. Unlike a task, a story goes back and forth: **Activate** (▶) resumes it where it left off. While a story is pending, a task that's already running finishes normally, but nothing new is handed out, and stories that depend on it wait. Pending stories live on **Work → Pending**. (This replaces the old story *pause* and the *Backlog*: paused and backlogged stories show up as pending.)

**Schedules go back and forth too.** Once a scheduled job is active, its schedule can be paused: press **Make pending** on its row on **Work → Schedule** or in the job page's header (or ask the assistant). The job moves to **Work → Pending** and its cron stops firing; **Activate** there (or on its page) turns it back on. It picks up at its **next** scheduled time — runs it missed while pending are *not* made up, so a long pause never comes back as a burst. **Run now** still works on a pending schedule. A job runs on its cron only when both the schedule and the job itself are active: a job you saved as pending stays pending until you **Activate** it from its page.

### Stories

A story groups related board tasks and gives them order + a workflow. Each story has an **ID**, **Title**, **Description**, a **Workflow**, an optional **Directory** (where the work happens), **Dependencies** (other stories that must finish first), and an ordered list of its tasks with each task's current status.

### WorkItems — the queue

A **WorkItem** is a single attempt to do one WorkDef's work — the actual unit teammates claim. It's deliberately dumb and terminal-only: it moves `READY → IN_PROGRESS → COMPLETE / FAILED` and never backward. Retrying is always a *fresh* WorkItem. A board task emits a WorkItem each time it enters an agent state (initial work + any rework); a Schedule emits one per cron tick; a Solitary WorkDef emits one when you hit **Run**.

If a teammate goes silent mid-work, its WorkItem becomes **MORIBUND** (reaped but not declared dead) — you can force-fail it (optionally re-enqueuing) or it's restored if the teammate reconnects.

### Workflows

A workflow is an ordered list of **states** a board task passes through, e.g. `todo → in_progress → review → done` (`todo`/`done` are implicit buckets). Each state is one of two types:

- **agent** — worked by teammates (claiming its WorkItem). Can pick a **persona** from the library — role framing injected into the prompt for that state.
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

The nav bar has two destinations, plus pause / **usage** / help / config / theme icons:

- **Thoughts** — sticky notes, where ideas start: a canvas, or a list with folders.
- **Work** — all your work, in five tabs:
  - **Board** (`/work/board`) — active stories as swimlanes.
  - **Tasks** (`/work/tasks`) — active standalone Solitary tasks.
  - **Schedule** (`/work/schedule`) — active cron-driven Scheduled jobs.
  - **Pending** (`/work/pending`) — everything held back until you activate it: stories, tasks, and scheduled jobs, in one list.
  - **Archived** (`/work/archived`) — retired stories, tasks, and jobs, in one list (restore or delete tasks and jobs here).

**Pending** and **Archived** are each one mixed list. Every row has a type badge (**Story**, **Task**, or **Schedule**), its title, its directory, and a time when there is one (when a story was archived, otherwise when the task or job last ran) — newest first; rows with no time come last, by title. Click a row to open it. The chips at the top — **Stories · Tasks · Schedules**, each with its count — narrow the list (all on to start; click to turn one off or on), and the search box matches a title, id, or directory. On **Pending**, each row has **Activate** and an archive button; on **Archived**, tasks and jobs have **Restore** and **Delete**. Archived stories can't be restored — click one to read its synopsis. Board tasks aren't listed on their own: a pending board task waits in its story's swimlane on the **Board** (open it there to **Activate** it).

Workflows and the persona library live under the **config** (gear) icon, as **Config → Workflows** and **Config → Personas**.

The Board, Tasks, and Schedule tabs only appear while their kind is switched on under **Config → General → Work items** (a new team starts with Tasks only; see [Work items](#work-items-feature-toggles)); Pending and Archived stay while any kind is on, and **Work** itself goes away only when all three are off. Clicking **Work** opens its first tab. Old addresses (`/board`, `/tasks`, `/schedule`, `/pending`, `/archived`) still work and take you to the matching tab.

**External sources.** When the team has an external work source connected (a [plugin package](#writing-a-work-source-plugin) your team added, or the development fixture source), it gets its own read-only tab between **Schedule** and **Pending**, named after the source. It lists what the source supplies — title, an **Open in <source>** link, the last revision seen, the state of its latest run, and how many times it has run — and refreshes from the source on its own (**Sync now** pulls at once; **Show archived** includes items the source no longer has; **Configure** opens its settings on Config → Sources). Each new revision of an item runs once. Opening an item shows the usual details page, but read-only: change it in the source, not here. Its **Thread** works as usual — comments and attachments — and comments and run outcomes are passed back to the source. If the source reports its own comments, they appear in the Thread too, in time order, each with a badge naming the source and, where it has several threads, the channel (**SIM-T · Correspondence**, **SIM-T · Worklog**). Those came *from* the source, so they're never sent back; a comment you post here and the source then reports back isn't shown twice. A new comment in the source doesn't re-run the item.

**Triage-mode sources.** Some sources (or some of their items) are **triage-only** — a ticket queue you'd rather *think about* than hand straight to a teammate. Such an item is marked **Triage** on its source's tab, and nothing ever works it directly: each new revision gets a **triage** run instead, exactly like a note's [auto triage](#thoughts). A teammate reads the item and the team's triage instructions and proposes tasks, story tasks, stories, or scheduled jobs. The row then wears the same badge a note gets (a lightbulb for proposals waiting, **?** for a question, **–** for nothing to create), the finished run lands in your **Inbox**, and both open the item's **Triage** tab: the item read-only (with **Open in <source>**), the latest analysis with **Accept / Edit / Reject** per proposal, and earlier rounds. Accepting creates the work and never starts it; the item itself stays where it is. Your turn is the item *in its source*: when it changes there, the next sync triages the new revision (your earlier decisions are passed along, so rejected ideas aren't re-offered). **Triage now** — the button that replaces Run on that page — forces a fresh run, e.g. after one failed. Proposals aren't written back to the external system; comments and run outcomes still are. (Plugin authors: see [Triage mode](#writing-a-work-source-plugin).)

The highlighted destination is the section you're in, detail pages included: a story, board task, Solitary task, or scheduled job page lights **Work**, and every Config tab (Workflows and Personas included) lights the gear. The ← back arrow on a detail page returns to wherever you opened it from (the Inbox, a teammate, the Usage page…); only when there's nowhere in-app to go back to (say, a link opened in a new tab) does it take you to that section's list.

The **home page** (`/`, the pizza logo) has two tabs — **Queue | Inbox** — work in flight, then finished work. The pizza logo carries two small count badges, each hidden at zero: a **neutral** one (bottom corner) for WorkItems **queued** and not yet picked up, and an **accent** one (top corner) for **unread** Inbox items. Hover a badge for what it counts. They stay on the icon when the nav bar is too narrow for the "Pizza Team" wordmark, refresh every ~10 seconds, and update right away when you mark Inbox items read or unread. Quick-create (the **+** beside the queue summary) and the assistant live in the left dock, on every page.

### Queue

The Queue is work **in flight** — every WorkItem that hasn't finished — grouped by what it needs from you:

- **At risk** (MORIBUND, amber) — its teammate went silent mid-work. Nothing retries it automatically: **Force-fail** it, or **Re-enqueue** a fresh attempt.
- **Waiting** (READY) — not picked up yet, with how long it's waited. **Cancel** it if you don't want it run. If waiting work is stuck, a banner says why (distribution paused, no teammates online, everyone busy). Work in a pending story, or one waiting on a dependency, isn't offered to anyone. An item whose directory is busy reads **waiting — directory busy (teammate, item)**. It starts when that item finishes. If the busy item is *at risk*, force-fail it to free the directory.
- **Working** (IN_PROGRESS) — which teammate has it (click through to watch it) and for how long.

An item marked **retry · attempt 2 · in 4m** is an automatic retry: the teammate's model call failed last time (a service outage, expired credentials), so it runs again after a short backoff — and only once the readiness probe passes. Each failed attempt leaves an amber **[retry]** comment on the work's thread.

You don't have to open the tab to keep an eye on it: the **queue summary** at the top of the left dock (the row beside the nav bar, above both tabs) always shows the counts — `2 waiting · 1 working`, with **at risk** in amber. **Hover** it to preview every item and its status; click it to open the Queue tab. With the dock collapsed, the rail's ⏱ badge (amber when anything is at risk) does the same.

### Inbox

The Inbox is your review queue: completed WorkItems (**COMPLETE** and **FAILED**), unread by default. Each row links to the work it came from — a board task opens its task page, standalone work opens its WorkDef page — where the completion summary lives as a comment. Clicking a row marks it read.

If a teammate's model call kept failing (say, Bedrock was unavailable) the item is **FAILED** after its automatic retries, never quietly "completed": the row shows the error, and the thread ends with a red **[failed] … after N attempts** comment. Earlier failed attempts appear already read — only the final outcome is news.

---

## The Board

The board (**Work → Board**, `/work/board`) shows active stories as horizontal swimlanes with task cards arranged by workflow state.

### Creating a Story

Use **New Story** (from the dock's **+** menu, or `/stories/new`):

1. **ID** — a URL-safe identifier
2. **Workflow** — which workflow governs this story's tasks
3. **Title** & **Description** (markdown)
4. **Directory** — where teammates work (also the affinity bias). Pick from the dropdown — your **favorite directories** first, then recently used ones — or type a path (see [Favorite directories](#favorite-directories))
5. **Tasks** — optionally add initial tasks inline

(How each task is worked comes from its workflow state's [persona](#personas). Project knowledge — conventions, build commands — belongs in the directory's AGENTS.md, which teammates read before starting.)

### Managing tasks

The board is for glancing and light triage; editing happens on the task page.

- **Add a task** — the `+` on a story swimlane
- **Move a task** — drag its card to another column (that's how you send to review, approve, or send back for rework)
- **Open a task** — the `details →` link opens the task page (read it — or **Edit**/**Activate** it while it's [pending](#pending--write-first-activate-when-its-right) — move, delete, read comments, upload/review files)
- **Edit a story** — click the story title to open its page (title, description, directory; **Make pending** / **Activate**)
- **Hold a story** — the ⌛ on its swimlane makes it [pending](#pending--write-first-activate-when-its-right) (it moves to **Work → Pending**); ▶ there activates it again
- **Retire a story** — the archive button on its swimlane; archived stories (with their synopses) are on **Work → Archived**

### Expanding and collapsing stories

Every story starts **expanded** (its task columns showing). The chevron at the left of a story's header collapses it to just the header row — the title and its actions (`+`, archive, pending/activate) — and clicking it again expands it. **Expand all** / **Collapse all** in the toolbar (next to search and sort) apply to the stories currently shown, so with a search active they only touch the matching stories. Searching doesn't expand collapsed stories. The board remembers each story's choice in this browser.

A card shows its title/ID, assignee, cost (if tracked), and a small chip when it has an active WorkItem: **queued** (READY), **working** (IN_PROGRESS), or **at risk** (MORIBUND).

---

## Tasks & Schedule (standalone work)

Not all work belongs on the board. Two Work tabs manage active standalone WorkDefs:

- **Tasks** — **Solitary** one-shots. Create one, then hit **Run** to enqueue it whenever you want it done. Good for ad-hoc chores ("audit dependencies"). Pending tasks aren't listed here — find them on **Pending**, with **Activate**. Each row shows how many times the task has run ("never run", "1 run", "3 runs" — hover for the last run); **Never run** narrows the list to the ones you haven't started yet, and the sort menu orders by **Fewest runs** / **Most runs**. A run is any WorkItem created for the task — queued, running, done, or failed — except one you **canceled** before it ran.
- **Schedule** — **Scheduled** jobs. Each is a WorkDef attached to a cron **Schedule**; the daemon enqueues a run every time the cron fires, and **Run now** triggers one immediately. Each row shows its run count and last run; **Make pending** moves it to **Pending**.

The archive button on a row moves the task or job to **Work → Archived**, where **Restore** brings it back and **Delete** removes it for good.

A task's or job's page (and a board task's page) shows the same run count in its header.

A failed run leaves the WorkDef in place — read its Thread, add a comment with what to change, and **Run** it again (an active definition is locked; see [Pending](#pending--write-first-activate-when-its-right)).

Both tabs use the same create form (`New Solitary Task` / `New Scheduled Job`), with an optional **Persona** — how a teammate does the work (every run of a schedule uses it; see [Personas](#personas)). It stays changeable on the Details tab after you create it, even once it's active, because it's *how* the work is done, not *what*. The Details tab also lists the item's **Runs**, newest first, each with the persona it ran with. **Acceptance criteria** are entered as an add-as-you-go checklist, and each line gets a live badge scoring it against [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — normative (MUST/SHALL), recommended (SHOULD), optional (MAY), or vague — nudging you toward testable, unambiguous criteria.

---

## Workflows

**Config → Workflows** (`/config/workflows`) lists workflow definitions. It only appears while Stories are switched on — workflows only apply to stories. (The old `/workflows` address still works and takes you there.)

### Viewing / editing a workflow

Create a workflow by name (it starts as `in_progress` → `review`). Open one to see its ordered states and edit them: add/remove states and set each state's **type** (**agent** or **manual**), or make it the default. There are no transitions or permissions to configure — the pipeline is the ordered list, and the daemon advances agent states automatically. Every story picks its workflow when it's created.

### State personas

Each **agent** state can pick a **persona** — role framing the teammate receives when working that state (implementer, reviewer, CR-writer, …). On a workflow's page, **State Personas** has a picker per agent state; a change saves at once and applies from the next claim. **edit** (or **view**, for a built-in or package persona) beside the picker opens the persona itself on [Config → Personas](#personas). No persona means just a one-line "you're working in the … state" framing.

---

## Teammates

Teammates live in the **Team** tab of the left dock (beside the **Assistant** tab), on every page — the teammate pool (the leader isn't listed: it's the agent you talk to on the Assistant tab), each showing its status, the model it's running (hover for provider/id), current work and the **persona** it's working with (a ✦ chip — click it to open the persona), working directory, how full its context window is, and what its session has cost so far. The icon *is* the status — **person**: pairing with you · **bot**: waiting for work · **spinning loader**: working · **cloud with a slash**: lost contact (hover it for the words). The gauge shows the context window's fill (hover for exact tokens; `?` just after Pi compacts, until its next reply), then the session's cost; both reset when the teammate starts a fresh session for its next work item. On the Assistant tab you can still see the team at a glance: the Team tab shows how many are online, and an amber dot when a team size can't be met (at-risk work shows in the queue strip instead). The collapsed dock shows everyone as avatars.

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

The **pause button** (⏸) in the navbar stops the daemon from handing out new WorkItems; in-flight work continues. Use it while reorganizing. It isn't saved — restarting the daemon resumes distribution. To hold just one story, make it **pending** on its page.

---

## Comments & Review

Comments are the channel between you and your teammates, and they live on the **work** (the task or WorkDef), not the WorkItem — so they persist across attempts:

- **You → Teammate**: comment on a task to give feedback or answer questions.
- **Teammate → You**: teammates post their completion summary as a comment when they finish (that's what you review in the Inbox).

When a teammate completes an agent state, the task advances to the next state. If that's a **manual** state (like `review`), it waits for you: review the work and any attached diffs, then **drag it forward** (approve → `done`) or **back** (send to rework) with a comment explaining what to fix. Moving it back into an agent state enqueues a fresh WorkItem, and the teammate picks it up again with your comments in the prompt.

---

## Personas

How a teammate — or the assistant, or triage — behaves is a **persona**: a markdown file in your team's persona library (`personas/<id>.md`). Workflow states, triage, the assistant, Solitary and Scheduled tasks, and Work Sources each *pick* a persona instead of carrying their own instructions, so one edit changes everywhere it's used.

**Config → Personas** (`/config/personas`) is the library:

- **The list** — every persona, with a search box and tag chips. A badge says where each comes from: **team** (yours, editable), **built-in** (MPT's defaults: `builtin:worker`, `builtin:triage`, `builtin:assistant`), or the name of the **plugin package** that ships it. The small labels on the right (**worker**, **triage**, **assistant**) say which pickers list it first — a hint only; any persona can be picked anywhere.
- **New persona** — a title, an optional id (made from the title if you leave it), a one-line description (shown in pickers), tags, which pickers to suggest it in, and the **instructions**: what's injected into the prompt. Saving checks them: an unclosed code fence is refused (it would swallow the rest of the prompt); top-level headings and stray `---` lines are saved with a warning (headings are nested under the prompt's own sections automatically).
- **A persona's page** (`/config/personas/<id>`) — its instructions, and **Used by**: every workflow state, setting, task, and source that picks it, each linked to where you'd change it. A team persona has **Edit**, **Duplicate**, and **Delete** — Delete is off while anything uses it (re-point those first). Built-in and package personas are read-only: **Duplicate to edit** copies one into your library as a new persona you can change (it doesn't follow later updates to the original).

**Where you pick one:**

| What | Where | None picked means |
|---|---|---|
| A workflow's agent state | Config → Workflows → a workflow → **State Personas** | a one-line state framing |
| Note triage | Config → **Triage** → **Persona** | the built-in triage persona |
| The assistant | the chips above the chat, or Config → General → Assistant → **Persona** | the built-in assistant |
| A Solitary task or a Scheduled job | **Persona** on its create form and its Details tab (changeable any time — every run of a schedule uses it) | no persona |
| A Work Source | Config → Sources → the source → **Personas** | what the source declares, if anything |
| One item from a source | **Persona** on its Details tab (an override, kept across syncs) | the source's choice |

Board tasks get their persona from the workflow state they're in.

**Seeing who's working how.** While a teammate works, a ✦ **persona chip** shows the persona it was given — on its row in the Team tab, on Queue rows, in the header when you watch it, and in the **Runs** list on a task's Details tab. Click it to open the persona. The chip records what the run actually got, so editing or deleting the persona later doesn't change it: a deleted one shows its name marked **(deleted)**, without a link. A run with no persona has no chip. An amber outline means the persona it asked for was missing, so a built-in stood in (hover for which).

**The Context Library was removed.** *How to do the work* belongs in a persona; *what the project is* (conventions, architecture, build commands) belongs in the project itself — its AGENTS.md or README — where teammates already read it. When your team first starts on this version, MPT moves things over for you, in one commit:

- context entries tagged **`persona`** become personas (and the assistant keeps the one you'd picked);
- entries that were **attached** to a story or task are copied into those tasks' **Additional Context**, under a heading naming the entry, so their prompts carry the same text;
- the old `context/` folder is kept as `context.migrated/`, and a one-time notice says how many entries were moved and how many were left there — turn the useful ones into personas, or move them into the project's AGENTS.md.

Old links to the Context page (`/context`, `/config/context`) open Config → Personas.

### Assistant style: chat or terminal

**Config → General → Assistant** picks how you talk to the assistant. **Chat (bubbles)**, the default, is the iMessage-style chat: short replies, one bubble per paragraph. **Terminal** shows the assistant's session the way a teammate's page does when you watch and pair with it — a terminal-style transcript and the same composer. The assistant's reply style follows the choice (no bubble-shaped answers in terminal mode). It applies as soon as you save, from the assistant's next reply: no restart, and the current conversation carries on.

In terminal mode the composer is always open — there's no **Pair** step, since the assistant has no queue of work to pause. As with a paired teammate, **Enter** queues your message after the current run and **⌘/Ctrl+Enter** steers it in at the next step. Like a teammate's page, the view is live from when you open it (no backfill); reading an earlier session from the session menu shows it as the chat.

### Assistant personas

Who the assistant is comes from the persona library too. Above the chat, **Default** (the built-in assistant) and the personas suggested for the assistant appear as chips — **Other…** picks any other persona, and **edit**/**view** opens the current one. Picking one starts a fresh chat with that persona as the assistant's system prompt (the old chat stays in the session history, which notes each session's persona). The same choice is on **Config → General → Assistant → Persona**. Swapping resets the assistant's context window.

### Distributing a persona package

Personas you want to share between teams travel as a **plugin package** — the same npm package, git repository, or local folder a [Work Source plugin](#writing-a-work-source-plugin) uses, with or without any sources. Install one with `mpt plugins add` and restart the daemon; its personas appear on **Config → Personas** with the package's name as their badge, ready to pick anywhere.

**Layout.** Persona files are ordinary persona markdown (frontmatter `title`, `description`, `tags`, optional `kinds`, then the instructions):

```
acme-mpt-personas/
├── package.json
└── personas/
    ├── reviewer.md
    └── implementer.md
```

**Manifest.** List the files in `package.json` under `"mpt"`. Paths are relative to the package and must stay inside it; a `*` is allowed in the last part of a path only (`personas/*.md`, or name files one by one). A package can ship personas alone, or beside its `"sources"`:

```json
{
  "name": "acme-mpt-personas",
  "version": "1.2.0",
  "mpt": { "personas": ["personas/*.md"] }
}
```

**Naming.** A package persona's id is `<package name>/<file name without .md>` — `acme-mpt-personas/reviewer`, or `@acme/personas/reviewer` for a scoped name. The `name` is required, and it's the package.json `name` (not how you installed it), so a workflow keeps working when you switch from a local checkout to npm or git. File names follow the team-id rules: lowercase letters, digits, and `-`. Two different packages with the same `name` can't both ship personas — the second one's are refused. A source in the same package can name its own personas (`defaultPersona: "acme-mpt-personas/implementer"`).

**Checking it.** `mpt plugins doctor ./acme-mpt-personas` lists each persona with ✓, ⚠ for a lint warning (a top-level heading, a stray `---`), and ✗ for an unclosed code fence, a file outside the package or missing, a bad file name, no `name`, or a `name` another configured package already uses. `mpt plugins add` and `update` run the same checks and refuse a package with a ✗, leaving `config.json` as it was. `mpt plugins list` shows how many personas each package provides. A persona-only package needs no build: MPT never runs npm in a cloned persona-only repository.

**Versioning.** Version the package like any other (semver tags for git, `version` for npm), and pin it in the spec (`npm:acme-mpt-personas@1.2.0`, `git:…@v1.2.0`) when you don't want updates; `mpt plugins update` re-fetches unpinned ones. New persona text takes effect after a daemon restart; work already running keeps the persona it started with, and each run's persona chip records what it actually got.

**Customizing.** Package personas are read-only. To change one for your team, open it on Config → Personas and **Duplicate to edit**: you get a team copy to edit and point your workflows at. The copy doesn't follow later updates to the package.

**Removing.** `mpt plugins remove` lists anything still using the package's personas — workflow states, triage, the assistant, tasks, sources — and what each will fall back to (`builtin:worker`, `builtin:triage`, or `builtin:assistant`; a triage-mode source's triage persona has no fallback, so that source stops syncing until you pick another). Re-point them, or duplicate the personas first.

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

  A run that fails isn't retried on its own — **Triage now**, on the triage page, forces one. Turn triage off, change its timing, or pick the persona it follows in **Config → Triage** (and edit that persona on Config → Personas). Archiving a note stops its triage; deleting one removes its analysis with it.

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

- **General** — the **Work items** toggles, the **Assistant** style (see below), port, tmux session, team size (min/max teammates), default workflow, the **readiness probe**, **favorite directories**, autosave (flush/commit cadence, auto-commit)
- **Teammates** — the nouns used to name teammates, **One teammate per directory**, and **Experimental Harnesses** (opt in to Kiro / Claude Code teammates and pick the default harness; applies on save, no restart)
- **Sources** — your Work Source plugins: switch each on or off, edit its settings, **Preview** what it would pull, and **Save** (see [Setting up a plugin from the UI](#setting-up-a-plugin-from-the-ui))
- **Workflows** — your story workflows and their state personas (see [Workflows](#workflows)); hidden while Stories are off
- **Personas** — the persona library: create, edit, duplicate, and see what uses each one (see [Personas](#personas))
- **Triage** — [auto triage](#thoughts): on/off, the sweep interval, the quiet period, and the **persona** every note-triage run follows (edit it on Personas)
- **Theme** — palette (a client-side preference; light/dark is the navbar toggle)

Each tab has its own address (`/config/teammates`, `/config/sources`, `/config/workflows`, `/config/personas`, `/config/triage`, `/config/theme`). **Save Configuration** appears on General, Teammates, and Triage — it saves the edits from all three at once. Sources has its own Save per plugin (and source personas apply at once), Workflows and Personas save as you go, the assistant's persona applies at once, and Theme applies immediately.

### Work items (feature toggles)

**Config → General → Work items** picks the kinds of work your team uses: **Stories** (the Board tab, plus Config → Workflows), **Tasks** (standalone Solitary tasks — the Tasks tab), and **Schedules** (the Schedule tab). A brand-new team starts with Tasks only; a team that existed before the toggles has everything on. Tick or untick, then **Save Configuration** — it applies right away, no restart.

When a kind is off:

- its **Work** tab (**Board**, **Tasks**, or **Schedule**) disappears, and so do its chip and rows on the **Pending** and **Archived** tabs (for Stories, so does Config's **Workflows** tab; with all three off, **Work** leaves the nav), and so does its entry in the dock's **+** quick-create menu (with all three off, the **+** goes too);
- its pages — lists, detail pages, and create forms — show a "turned off" notice with a link back here, even from a bookmark;
- a triage proposal of that kind can only be **Rejected** (Accept and Edit are disabled until you turn the kind back on);
- the assistant stops offering it: its tools for that kind leave its tool list (within about 10 seconds, or at its next reply) and it will tell you the kind is off if you ask for one;
- the API refuses it too, and `mpt status` leaves out its counts.

**Thoughts**, **Personas**, the **Queue**, and the **Inbox** are always there — even with every kind off — and finished work stays in the Inbox.

You can only turn a kind off when it has no active work: a toggle that's still in use is greyed out with what to clear first (e.g. "archive or delete 3 stories first"). Pending stories and pending tasks count; archived ones don't. Turning a kind back on is always allowed.

**External sources** (plugins like a tracker — see [Writing a Work Source plugin](#writing-a-work-source-plugin)) are switched on the **Sources** tab instead (Work items links there), where each one's switch applies at once — no Save needed. Switching one off stops it syncing: nothing new is pulled or run from it, its Work tab disappears (a bookmark shows a "turned off" notice), and anything a teammate is already working on finishes. While it still has mirrored items, switching it off asks first — **Turn off and archive N items**: after you confirm, it switches the source off at once, archives its items (nothing is deleted; their threads stay), and cancels their queued runs. Turn it back on later and the next sync — which runs right away — brings back the items the source still has, without re-running ones already done.

### Readiness probe

If your machine sometimes can't work (expired credentials, VPN down), set a **readiness probe**: a shell command the daemon runs every 30 seconds. Exit 0 means ready; anything else means not ready, and its first line of output is the reason. While not ready, **scheduled** jobs are held instead of run — and when it recovers, each held job runs once (not once per missed tick). Board and Solitary work still run. With no probe, the team is always ready.

### Favorite directories

Every directory field — New Story, a story's page, New Task, a WorkDef, a triage proposal's edit form, and **Spawn** — has a dropdown of suggestions: your **Favorites** first, then **Recent** directories (where teammates are working now, then recent work and story directories). Click the ☆ on any row to favorite it (★ to unfavorite), or the ☆ inside the field to favorite the path you typed. Manage the list under **Config → General → Favorite Directories**; changes save immediately (no Save button). Paths are stored resolved — `~` expanded and symlinks followed — so `~/repo` and its real path are the same favorite.

### Setting up a plugin from the UI

Once a plugin package is installed (`mpt plugins add …`, then restart the daemon —
see [Writing a Work Source plugin](#writing-a-work-source-plugin), step 5), you can
do the rest on **Config → Sources**:

1. **Find it in the list.** Every plugin source is listed with its package, a status
   pill — **Off**, **Init failed**, **Needs a triage persona**, **Not synced yet**, **Synced 5m ago**, **Sync
   failed 2m ago** (hover for the error), or **Backing off** — and how many items it
   mirrors. A package that failed to load is listed in red with why. No plugins yet?
   The tab says so and shows how to add one.
2. **Click it** to open its settings (`/config/sources/<id>` — the **Configure** button
   on its Work tab goes here too, and the ↗ button goes back to its Work tab). If the
   plugin describes its settings (a `configSchema`), you get a form: text, number,
   checkbox, drop-down, multi-choice and one-per-line list fields, each with its
   title, help text, placeholder and default; a red `*` marks required fields. A
   field left empty is unset, so the plugin's default applies. A plugin that doesn't
   describe its settings gets a JSON editor instead, which checks the syntax as you
   type.
3. **Secrets.** A token field takes the *name* of an environment variable (say
   `ACME_TOKEN`), never the token: put the token in the daemon's environment. Next to
   the name you see **set** or **not set** — whether the daemon has that variable
   (checked once saved). Values that look like secrets are never sent to the browser.
4. **Preview.** Press **Preview** to see what the plugin *would* pull with the
   settings on screen — saved or not: a table of items (title, linked to the item;
   external id; Work or Triage; directory), how many, and any warnings. Nothing is
   created, mirrored, queued or saved. Wrong settings come back as red messages
   under the fields they're about.
5. **Save.** **Save** writes the settings to the team's `config.json` and restarts
   just that plugin's setup — no daemon restart. You see "Saved — re-initialized",
   or the error if its setup failed (the settings stay saved; fix them and save
   again), and the status pill refreshes. **Discard changes** goes back to what's
   saved; leaving the page (a link, another source, a reload) with unsaved changes
   asks first.
6. **Switch it on.** Tick its checkbox in the list — that applies right away, and an
   enabled source syncs straight after. Unticking a source that still has mirrored
   items offers **Turn off and archive N items** (see
   [Work items](#work-items-feature-toggles)).
7. **Personas.** Under the settings, **Personas** picks how a teammate works the
   source's items: a **Work persona** for items it works, and a **Triage persona**
   for items it triages into proposals. Each applies at once (no Save, and the
   plugin isn't restarted); "Source default" means whatever the plugin declares. A
   source in **triage mode must have a triage persona**: without one it doesn't
   sync, its pill says **Needs a triage persona**, and this section says so in red
   until you pick one. Your notes' triage persona (Config → Triage) is never used for
   a source. To work one item differently, set **Persona** on that item's Details
   tab — an override that survives every sync.

### Autosave

Your stories, tasks, notes, and usage are plain files in `.my-pizza-team/`. If that folder is inside a git repository, mpt commits it periodically (only that folder — never your own work) and pushes if there's a remote. Turn it off with **Auto Commit**.

---

## Writing a Work Source plugin

A **plugin package** brings work in from somewhere else — a tracker, a folder, an
API — as an external Work Source. It shows up as its own read-only tab (see
[External sources](#navigation)), and each new revision of an item runs once. A
plugin is an ordinary npm package, git repository, or local folder; this section is
for whoever writes one. (Adding someone else's is `mpt plugins add` — see below.)

**1. The manifest.** The package's `package.json` lists its source entries under
`"mpt"`, and declares this app as a peer dependency rather than installing it:

```json
{
  "name": "mpt-acme-tracker",
  "version": "1.0.0",
  "type": "module",
  "mpt": { "sources": ["./dist/index.js"] },
  "peerDependencies": { "my-pizza-team": "*" },
  "devDependencies": { "my-pizza-team": "*", "typescript": "^6.0.0" },
  "scripts": { "build": "tsc" }
}
```

The peer dependency is what lets you `import … from "my-pizza-team/plugin"`: the
daemon answers that import with **its own** copy (even if the plugin has none
installed), so you always see the running app's types and constants. Keep it in
`devDependencies` too if you want the types while you write. Entries must be files
inside the package; other keys under `"mpt"` are ignored.

**On/off.** An external source (one with `sync`) gets a toggle for free: it's listed
on **Config → Sources** by its `label`, as `features.<id>` in
config.json, and can be switched off or disconnected (see [Work items](#work-items-feature-toggles)).
While it's off the daemon never calls your `sync` or `tick`, and `ctx.upsertDef` /
`ctx.enqueue` return null. To name the flag yourself, declare `toggle: { feature:
"…" }`; to make the source always on, declare `toggle: null`. A feature name must be
unique and can't be `stories`, `tasks`, or `schedules` (nor can your id be, unless
you name another feature) — the daemon refuses such a source at load and says why.

**2. The entry.** Each entry's **default export** is either a Work Source object,
or a factory `(options, { teamDir }) => source` (it may be `async`) — use the
factory when the source needs its settings up front:

```ts
import { WORK_SOURCE_API_VERSION, type ExternalDef, type PluginFactory } from "my-pizza-team/plugin";

const factory: PluginFactory = (options) => {
  const tokenEnv = String(options.tokenEnv ?? "ACME_TOKEN");
  return {
    id: "acme",                        // lowercase letters, digits, dashes
    label: "Acme",                     // the tab's name and "Open in Acme"
    apiVersion: WORK_SOURCE_API_VERSION,
    syncEveryMs: () => 5 * 60_000,     // how often to pull (default 60s)
    async sync(ctx): Promise<ExternalDef[]> {
      const token = process.env[tokenEnv];
      if (!token) throw new Error(`set ${tokenEnv}`);
      // Return every item the source has *now*; an unchanged revision is a no-op.
      return [{ externalId: "ACME-1", revision: "2024-06-01T10:00:00Z", title: "Fix login", goal: "…", url: "https://acme.example/ACME-1" }];
    },
    onComment(def, comment, ctx) { /* optional: write the comment back */ },
    onItemTerminal(def, item, ctx) { /* optional: write the outcome back */ },
  };
};
export default factory;
```

The hooks, and what the daemon does with each, are documented on the
`WorkSource` and `SourceContext` types themselves. `ctx.kv` keeps small strings
(cursors, stamps) across restarts; `ctx.log` prefixes your output.

**Triage mode.** If your items are requests to *think about* rather than work to
do — a ticket queue, say — set `mode: "triage"` on the source (or `mode` on
individual `ExternalDef`s; an item's own wins). Each new revision then gets a
**triage** run, like a note's Auto Triage: a teammate reads the item (with the
source's **triage persona** — see Personas below) and proposes tasks, stories,
or schedules, which you accept or reject. Accepting creates the work without starting it;
nothing runs the item itself. In this mode the daemon sets the item's title
("Triage: …"), directory, prompt, and Run (Triage now), so your `resolveItem`,
`buildPrompt`, and `run` aren't called for those items; write-back hooks still are.
It's an optional field, so `apiVersion` stays 1.

```ts
return {
  id: "acme-tickets", label: "Acme Tickets", apiVersion: WORK_SOURCE_API_VERSION,
  mode: "triage",                    // every item from this source is triaged
  async sync() {
    return tickets.map((t) => ({
      externalId: t.key, revision: t.updatedAt, title: t.summary, goal: t.description, url: t.link,
      mode: t.type === "Task" ? "work" : undefined,   // "work" | "triage"; omitted = the source's mode
    }));
  },
};
```

The revision is the turn, so make it cover what the item *says* (an
`updatedAt`, or a hash of the title and body), not comments you write back
yourself — otherwise your own write-back re-triggers a triage. A source can flip
an item's mode without a new revision; the change applies to its next run. The
demo team's `mpt-source-demo-tracker` plugin shows both modes end to end.

In the web UI such an item is marked **Triage** on its source's Work tab, with
the same badge a note gets (proposals waiting, a question, nothing to create).
Its page opens on a **Triage** tab: the item read-only (with **Open in
<source>**) beside the latest analysis, each proposal with **Accept**, **Edit**,
or **Reject**, and earlier rounds; the header's button is **Triage now**. A
finished triage run lands in your Inbox and opens that tab. To answer a
question, change the item in its source — the next revision is triaged again.

**Personas.** Say how your items should be worked by naming a persona (see
[Personas](#personas)) — the daemon puts
it at the top of each item's prompt, as **Your Role**, before your `buildPrompt`
sees it, so you never write that part yourself:

```ts
return {
  id: "acme", label: "Acme", apiVersion: WORK_SOURCE_API_VERSION,
  defaultPersona: "mpt-acme-tracker/acme-worker",   // work-mode items (optional)
  triagePersona: "builtin:triage",                   // triage-mode items (required for mode: "triage")
  async sync() {
    return issues.map((i) => ({ /* … */ persona: i.type === "Bug" ? "bug-fixer" : undefined }));  // per item (optional)
  },
};
```

A persona id is a team persona (`reviewer`), a built-in (`builtin:triage`,
`builtin:worker`), or one a package ships (`<package name>/<id>`). Who wins, first
to last: a person's override on the item (`PUT /api/work-defs/<id>/persona`), the
item's own `persona`, the team's choice for your source (config.json
`sourcePersonas.<id>.persona` / `.triagePersona`, set with `PUT
/api/sources/<id>/persona` — saving it never re-runs your `init`), then your
`defaultPersona` / `triagePersona`. Nothing named means no persona for a
work-mode item. An id that doesn't exist falls back to the built-in when the item
runs (logged, and a ⚠ in `mpt plugins doctor`). Each run records the persona it
used, so the UI can show it.

**A triage-mode source must have a triage persona** — declared as
`triagePersona`, or set by the team for your source. Without one (or with one
that doesn't exist) the daemon **doesn't sync it**: the source shows the error on
**Config → Sources** ("needs a triage persona — set one on Config → Sources, or
declare triagePersona") and `mpt plugins doctor` marks it ✗. The team's
note-triage persona is deliberately not used instead. In a work-mode source, an
individual triage item without one is mirrored but not queued until one is set.
(Teams upgrading with a triage plugin already installed get the team's triage
persona filled in for it automatically, once, so nothing stops working.) These
are optional fields too, so `apiVersion` stays 1.

**The thread.** To mirror an item's comments too, return them as
`comments` on its `ExternalDef` — `{ externalId, author, createdAt, body,
channel? }` each (`ExternalComment`). The daemon appends the ones the mirror's
thread hasn't seen (by `externalId`), marked as coming from your source; they
never fire `onComment`, so nothing is echoed back. Omit `comments` on an item
to leave its thread as it is (fetch threads only for items that changed, if
that's expensive); a comment missing from the list isn't deleted. Comments
aren't content: keep them out of `revision`, or every comment re-runs the item.
When `onComment` posts a comment, return (or resolve with) its new id —
`{ externalId }` — so it isn't pulled in again when your sync reports it:

```ts
async sync(ctx) {
  return issues.map((i) => ({
    externalId: i.key, revision: i.contentUpdatedAt, title: i.summary, goal: i.description,
    comments: i.comments.map((c) => ({ externalId: c.id, author: c.author, createdAt: c.created, body: c.text, channel: c.thread })),
  }));
},
async onComment(def, comment, ctx) {
  const posted = await api.addComment(def.parent!.id, `${comment.from}: ${comment.body}`);
  return { externalId: posted.id };   // recognised when it comes back
},
```

**3. Settings and secrets.** The `config` of the team's package entry —
`{ "source": "npm:mpt-acme-tracker", "config": { "tokenEnv": "ACME_TOKEN" } }`
in `config.json` `packages` — is the factory's `options` and the source's
`ctx.options()` (read-only). **Never put a secret there:** take the *name* of an
environment variable (`tokenEnv`) and read `process.env`, so `config.json` stays
safe to share and commit.

**4. Build to JavaScript.** Node won't run TypeScript from inside
`node_modules`, so an npm package must ship compiled `.js` (point `"mpt.sources"`
at `dist/`). A git repository can ship sources plus a `build` script, or commit
its built entries — see [Distributing a plugin](#distributing-a-plugin). A local
folder loads in place, so a plain `.js` entry needs no build at all.

**5. Add it, then restart.**

```
mpt plugins add ./mpt-acme-tracker --config '{"tokenEnv":"ACME_TOKEN"}'   # local, loads in place
mpt plugins add npm:mpt-acme-tracker@1.0.0                                 # or git:github.com/acme/mpt-acme-tracker@v1.0.0
mpt plugins list                                                           # installed? loaded? the error if not
mpt plugins update [<spec>]                                                # re-fetch unpinned npm/git packages
mpt plugins remove <spec>
```

Plugins load when the daemon starts, so **restart it after any change** — to the
package list or to a plugin's code (`mpt stop && mpt start --daemon`, or restart
the service). A plugin that fails to load (no manifest, a throw, a wrong
`apiVersion`, an id another source already has) is skipped and the rest of the
team carries on; `mpt plugins list` and `mpt doctor` show why. A plugin runs
inside the daemon with its permissions, so only add ones you trust.

**Installed on start.** `packages` in `config.json` is enough: when the daemon
starts, any npm or git package listed there that isn't installed yet (say, a
teammate's fresh checkout of the team's config) is installed first, exactly as
`mpt plugins add` would, and logged with `[plugins]`. Each package is on its own:
one whose install fails is skipped and its error shows in `mpt plugins list`,
`mpt doctor` and `mpt plugins doctor`, while the rest load. Each install command
is limited to 10 minutes (set `MPT_PLUGIN_INSTALL_TIMEOUT_MS` in the daemon's
environment to change it), a failed one isn't retried until the next restart,
and local paths are never installed or changed. config.json is never written.

### Describing your settings (configSchema) and preview

Two optional fields make a plugin easy to set up without hand-editing JSON.
`configSchema` describes your settings — a small subset of JSON Schema: an
object of `string`, `number`, `integer`, `boolean`, `enum`, and string-`array`
fields, with objects nested one level — plus hints for the form: `title`,
`description`, `placeholder`, `default`. Mark a secret reference with
`format: "env-var"`: the field holds the *name* of an environment variable,
never the secret, and anything that isn't a valid name is refused. `preview`
answers "what would you pull with these settings?" without pulling anything.

```ts
const factory: PluginFactory = () => ({
  id: "acme", label: "Acme", apiVersion: WORK_SOURCE_API_VERSION,
  configSchema: {
    type: "object",
    required: ["project"],
    properties: {
      project:  { type: "string", title: "Project key", placeholder: "ACME" },
      tokenEnv: { type: "string", title: "Token", format: "env-var", default: "ACME_TOKEN",
                  description: "The environment variable that holds your API token" },
      status:   { type: "string", enum: ["open", "all"], default: "open" },
      maxItems: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  async sync(ctx) { return fetchItems(ctx.options()); },
  // Optional: without it, Preview runs `sync` with the draft settings.
  async preview(ctx, draftOptions) {
    const items = await fetchItems(draftOptions);
    return { items: items.slice(0, 10), note: `${items.length} items match` };
  },
});
```

**Which settings the schema describes.** By default your whole package entry
`config`. If your package ships **several sources**, give each its own block
and say so with `configScope: "source"`: the schema then describes
`config["<source id>"]`, e.g. `{ "config": { "sim-t": { … }, "taskei": { … } } }`.
Either way `ctx.options()` (and a factory's `options`) is the whole `config`, as
before.

**Checked at load.** When the daemon starts it checks each source's settings
against its schema. A mismatch is logged (`[plugins] … warning: config.project:
is required`) and reported with the package's status (`GET /api/work-sources`,
`plugins[].warnings`) — the source still loads.

**Preview has no side effects.** Preview (and the `sync` it falls back to) gets
a restricted `ctx`: `ctx.options()` is the draft, `upsertDef`, `enqueue`, and
`enqueueRevision` do nothing (and show up as a warning), and `kv.set` /
`kv.delete` change a scratch copy that's thrown away. It's limited to your
`syncTimeoutMs` (default 30s). Don't write to the external system from it
either. If your `sync` has side effects of its own, relies on a kv cursor (a
preview would see only what changed), or reads settings your factory captured
(so the draft can't reach it), implement `preview`. Return `{ items, warnings?,
note? }`; items the mirror would refuse (no `externalId`, `revision`, or
`title`, or a repeated `externalId`) are dropped with a warning.

**Saving settings re-runs `init` — make it idempotent.** Settings saved from
the daemon (`PUT /api/sources/<id>/config`, what the Config page's Save calls)
are written to the team's `config.json` and applied without a restart: your
`ctx.options()` starts returning them, `init(ctx)` is called **again** (awaited,
limited to `syncTimeoutMs`), any sync backoff is cleared, and an enabled source
syncs straight away. So `init` must cope with running more than once: replace
clients and caches rather than adding to them. Read settings from
`ctx.options()` — a factory's `options` argument is *not* refreshed (the
factory isn't called again), and neither are `syncEveryMs` / `tickEveryMs`
(restart for those). If `init` throws, the new settings stay saved and the
source is shown as errored until a later save succeeds. Settings that look
like secrets (a `token`/`secret`/`password`/`apiKey` key holding text) are
never sent to the browser; env-var references are shown by name, with whether
the daemon's environment has them.

**Adopting it in an existing plugin.** What the bundled examples
(mpt-demo-team's demo-tracker, MPTSimWorkSources' sim-t and taskei) needed:

- Settings read once in the factory and closed over: move them into a
  variable that `init` refreshes from `ctx.options()`, and have every hook read
  that variable. A source-level `mode` that depends on a setting can be a getter.
- `preview`: run your fetch-and-map path on the draft (`draftOptions`) and skip
  your own side effects — a `dryRun` gate, logging what a sync would mirror,
  bookkeeping in kv (the ctx's kv is a scratch copy anyway). Turn problems the
  person can fix ("not configured", a bad value, an expired login) into
  `warnings` instead of throwing; a throw shows as the preview's error.
- The schema has no "string or list": declare such a setting as a list. An
  old config with a lone string still loads (with a `[plugins]` warning) and
  shows in the form as one line; Preview and Save ask for a list until it's
  edited.

### Distributing a plugin

A plugin travels as an npm package (from your npm registry) or a git repository.
MPT doesn't know about build systems — no Brazil, Bazel or the like — so a **git
plugin must meet one contract**: either

- it **installs and builds with plain npm** against the user's configured
  registry (`npm config get registry`): `npm install --omit=peer` then
  `npm run build` must succeed in a fresh clone, or
- it **ships prebuilt entries**: every `mpt.sources` file is committed, so it
  exists right after `git clone`.

What `mpt plugins add <git url>` (and the daemon's install-on-start) does after
cloning:

| The clone has… | MPT runs |
|---|---|
| every `mpt.sources` entry committed, no `dependencies` | nothing — no npm at all |
| every entry committed, some `dependencies` | `npm install --omit=peer --omit=dev` (runtime deps only, no build) |
| an entry missing | `npm install --omit=peer` (dev deps too), then `npm run build`; the entries must exist afterwards |

When an npm step fails you see the command, its exit code and the end of npm's
error output (often an `E404` for a package your registry doesn't have), plus the
contract above. A failed `add` leaves `config.json` unchanged and removes the
partial clone.

**Brazil / NpmPrettyMuch packages** usually carry internal-only devDependencies
(the template's `@amzn/brazil`, used just by a coverage `posttest`) that a public
or personal registry can't serve. Either move those to `optionalDependencies` —
npm skips an optional package it can't fetch, so `npm install` and `npm run
build` still pass (MPTSimWorkSources does this) — or commit the built entries so
no npm run is needed. Check it the way a user will:

```
git clone <your repo> /tmp/check && cd /tmp/check && npm install --omit=peer && npm run build
mpt plugins doctor ssh://git.example.com/you/your-plugin     # installs into a temp cache and checks it
```

### Testing your plugin

Before a plugin goes into a real team, check it with `mpt plugins doctor`. It
prints a ✓ / ⚠ / ✗ line per check, grouped by package and then by source, and
exits non-zero if anything failed (`--json` gives the same report as JSON).

```
mpt plugins doctor                         # every package in config.json
mpt plugins doctor ./mpt-acme-tracker      # one package: a path, a spec, or a configured identity —
                                           # it doesn't have to be configured
```

A spec that isn't configured or installed (`mpt plugins doctor
npm:mpt-acme-tracker`, or a git URL) is first installed into a temporary cache,
removed afterwards, so you can check a package straight from its registry or
repository without adding it.

On its own it is an **install check** — no network (beyond that install), no
`init`, no `sync`, and a factory is *not* called. It checks that the spec parses and the package is there,
that `package.json` has a valid `"mpt"` manifest, that each persona it ships is
usable (see [Distributing a persona package](#distributing-a-persona-package)), and that each source entry is
inside the package and **imports the way the daemon imports it**
(`my-pizza-team/plugin` resolving to this app). For an object export it also
checks `apiVersion`, the id's format, and that no other package (or built-in)
uses the id, and its personas: a `defaultPersona` or `triagePersona` that
isn't a team, built-in, or package persona is ⚠ (package personas are checked
against the configured packages' persona files), and a triage-mode source with no
triage persona — declared, or the team's `sourcePersonas` choice — is ✗, since the
daemon won't sync it. A failed import says why and, for the usual causes, what to do: a
native module built for another Node shows its `NODE_MODULE_VERSION` against this
Node's and tells you to rebuild the package with this Node (`npm rebuild`).

Add `--config` to also run the package **live**, once, on a throwaway context:

```
mpt plugins doctor ./mpt-acme-tracker --config '{"tokenEnv":"ACME_TOKEN"}'
mpt plugins doctor npm:mpt-acme-tracker --config team      # use its config from config.json
mpt plugins doctor ./mpt-acme-tracker --config '{}' --source acme --hooks
```

The factory is called with that config (frozen, as the daemon does), then each
source's `init` and `sync` run against a scratch context: a temp directory as
`teamDir`, an in-memory `kv`, `ctx.log` printed under the source, and queue calls
(`enqueue`, `enqueueRevision`, `upsertDef`) recorded but not applied — **your
team directory is never written**. Each item is listed (externalId, revision,
mode, title, url, directory) and checked: required fields, duplicate
externalIds, a mirror id the file system can hold. `sync` runs twice, and a
revision that changes when the content didn't (or the reverse) is a warning.
`--source <id>` runs just one source; `--hooks` also calls `onComment` and
`onItemTerminal` (with a fake completed item) on the first item — that is a real
write-back if your hooks do one, so point it at a test project. `--config` needs
exactly one package: name it when the team has several.

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
- **Use personas** — give each agent state phase-specific role framing, and give recurring jobs a persona of their own.
- **Keep project knowledge in the project** — conventions and build commands go in the repo's AGENTS.md, where every teammate reads them.
- **One story per concern** — small focused stories beat one giant story.
- **Standalone for chores** — recurring or ad-hoc work that isn't a feature belongs on Work → Tasks/Schedule, not the board.

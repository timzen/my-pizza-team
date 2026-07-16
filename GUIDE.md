# User Guide

## Overview

My Pizza Team (MPT) is a task coordination daemon for a team of AI **teammates**. You create **stories** (units of work), break them into **tasks**, and your teammates execute them autonomously through a defined **workflow**.

Teammates *are* AI agents — autonomous coding assistants (Pi, Claude Code, Codex, …) that connect to the daemon and poll for work. We call them "teammates" throughout the UI because that's how you work with them; "agent" is just the underlying technical term (and the one the HTTP API uses, e.g. `/api/agents`).

The web UI at `http://localhost:7437` is your control center for managing all of this.

---

## Core Concepts

### Stories

A story is a high-level unit of work — like a feature, bug fix, or research task. Each story has:

- **ID** — A unique slug (e.g., `auth-system`)
- **Title** — Human-readable name
- **Description** — What needs to be accomplished (supports markdown)
- **Workflow** — Which workflow governs its tasks
- **Directory** — Optional working directory for teammates
- **Dependencies** — Other stories that must complete first

### Tasks

Tasks are the individual steps within a story. They're worked on sequentially — the first unblocked task gets picked up by a teammate. Each task has:

- **Title & Description** — What to do (supports markdown)
- **Status** — Current state in the workflow (e.g., `todo`, `in_progress`, `review`)
- **Assignee** — Which teammate is currently working on it
- **Comments** — Communication between you and your teammates
- **Attachments** — Files teammates upload (diffs, screenshots, etc.)

### Workflows

A workflow defines the lifecycle of tasks: what states they pass through and who can trigger each transition. For example:

```
todo → in_progress → leader_review → done
```

Each transition has a permission:
- **any** — Anyone (lead or teammate) can trigger it
- **teammate** — Only teammates can trigger it (autonomous work)
- **lead** — Only you can trigger it (review gates, approvals)

Workflows also have **instruction files** — markdown documents that tell teammates what to do when entering each state and what criteria must be met to exit.

### Teammates

Teammates are autonomous AI agents that connect to the daemon. They follow a simple loop:

1. Poll for available work
2. Claim a task (daemon transitions it to the working state)
3. Do the work
4. Release the task (daemon advances to the next state)
5. Repeat

You don't need to manage a teammate's state — the daemon handles assignments, transitions, and handoffs.

Each teammate advertises **capabilities** — a set of things it can do. The working **directory** is one such capability (it's just a well-known one); teammates can also advertise skills like `python` or `docker`. The daemon only hands a task to a teammate whose capabilities meet the story's requirements.

---

## The Board

The board (`/board`) is the main view showing all active stories as horizontal swimlanes with task cards arranged by workflow state.

### Creating a Story

Click **Add Story** to open the creation dialog:

1. **ID** — A URL-safe identifier (auto-suggested from title)
2. **Directory** — Where teammates should work (select from recent directories or type custom)
3. **Workflow** — Select which workflow governs this story's tasks (required)
4. **Title** — What the story is about
5. **Description** — Detailed requirements (markdown supported)
6. **Tasks** — Optionally add initial tasks inline

### Managing Tasks

The board is for glancing and light triage — editing happens on the dedicated pages, not on the board.

- **Add tasks** — Click the `+` button on a story swimlane
- **Preview a story** — Click the 👁 (eye) button on a story header for a read-only popup showing the story description and a link to the story page
- **Preview a task** — Click the 👁 (eye) button on a card for a read-only popup showing the description and a link to the task page
- **Nudge status** — Use the arrow buttons (◀ ▶) on a card to move it a step along the workflow
- **Edit a task** — Click `details →` on a card to open the task page, where you can edit the title, description, move status, delete, and read comments/files
- **Edit a story** — Click the story title to open its story page (`/story/:id`), where you edit its title, description, requirements, and paused state

> Clicking the body of a task card does nothing — opening a task is always an explicit action, and editing is reserved for the task/story pages.

### Task Cards

Each card shows:
- Title and ID
- Current assignee (if claimed)
- Token cost (if tracked)
- Status badge with navigation arrows (◀ ▶)
- A 👁 preview button and a `details →` link to the task page

---

## Workflows

The **Workflows** tab on the home page (`/`) lets you view and manage workflow definitions.

### Viewing a Workflow

Click any workflow to see:
- **State graph** — Visual representation of states and transitions
- **Lifecycle preview** — How a task flows through the states
- **Instructions** — Markdown instruction files for each state

### Editing States & Transitions

Click **Edit States & Transitions** to open the editor dialog where you can:
- Add/remove states
- Add/remove transitions between states
- Set permissions (any, teammate, lead) for each transition

### Instruction Files

Each state can have a markdown instruction file that teammates receive when entering that state. These guide the teammate on:
- **What to do** in this phase
- **Exit criteria** — what must be true before releasing the task

Write clear, actionable instructions. Teammates receive these verbatim.

---

## Teammates

Teammates are shown in a persistent column on the right of every page — each with its status, current task, and capabilities. The team is always in view, so you never leave what you're doing to check on it.

### Spawning Teammates

Click **Spawn** at the top of the teammates column to request a new teammate:
- **Host** — Which machine should start the teammate
- **Working Directory** — Where the teammate operates (recent + story dirs shown)

### Teammate Lifecycle

Teammates are autonomous — once spawned, they:
1. Register with the daemon
2. Poll for work every few seconds
3. Claim and work on tasks
4. Release when done
5. Repeat until dismissed

### Managing a Teammate

- **Reset** (↺) — Resets a teammate's session, clearing its context window (the harness realizes this as Pi's `/new`). Useful when a teammate's context is full or has drifted.
- **Dismiss** (🗑) — Removes the teammate. Offline teammates can be cleared in bulk with **Dismiss all**.

### Pausing Distribution

The **pause button** (⏸) in the navbar stops the daemon from handing out new tasks. Existing in-progress work continues. Use this when you need to reorganize stories without teammates claiming things.

---

## Comments & Review

Comments are the communication channel between you and your teammates:

- **You → Teammate**: Add comments on a task to provide feedback, request changes, or answer questions
- **Teammate → You**: Teammates post status updates, summaries, and questions

When a teammate releases a task that moves to a lead-only state (like `review`), it will appear on the board in that column. Review the work, check any attached diffs or comments, then either:
- **Approve** — Move the task forward (e.g., `review → done`)
- **Send back** — Move it back (e.g., `review → in_progress`) with comments explaining what to fix

The teammate will pick it up again, see your comments, and address them.

---

## Context Library

The context library (the **Context** tab on the home page, `/context`) stores reusable prompt/context entries that you can inject into teammates or the assistant.

- **Metadata** — Each entry has a title, a short description, and tags
- **Filter** — Tag chips and free-text search narrow the list (client-side; the collection is meant to stay small)
- **Markdown body** — The entry body is the prompt/context text itself

Good things to keep in the context library:
- Coding conventions and style guides
- Architecture decisions
- Common patterns and gotchas
- Project-specific context

### Attaching context to work

Attach context entries to a **story** (applies to all its tasks) or an individual **task** from the story/task editor. Attached entries are inlined into the task prompt under a **Reference Context** section when a teammate claims the task — so the daemon vends the right context to every harness, no per-agent tools needed.

### Assistant personas

Tag a context entry with **`persona`** to turn it into a swappable assistant persona. On the Assistant page (when a persona-capable assistant is online), persona entries appear as chips above the chat. Picking one starts a fresh chat in which that entry's body becomes the assistant's system prompt; **Default** returns to the daemon's built-in assistant persona. Swapping resets the assistant's context window, and **New chat** does the same without changing persona.

---

## Scratch Pad

A personal space for quick capture (`/scratchpad`), rendered as a todo list on the left and free-form notes on the right.

- **Todos** — add, check off (stamps a completion date), and delete items. Stored in `todo.jsonl`.
- **Notes** — a free-form markdown doc with edit/preview; saves on blur. Stored in `notes.md`.
- **Assistant access** — the assistant can *read* your scratch pad on request ("take a look at my scratch pad and help me plan my day") via its `read_scratchpad` tool. It's read-only; the assistant summarizes and helps, it doesn't edit.

Both files live at the root of the team directory as plain text — easy to hand-edit or grep.

---

## Configuration

Visit `/config` to manage settings:

- **Port & Session** — Daemon network settings
- **Autosave** — How often work is flushed to disk and git-committed
- **Favorite Directories** — Quick-access paths shown in directory dropdowns
- **Host Settings** — Per-machine configuration for multi-host setups

---

## Tips

- **Write good task descriptions** — Teammates work from what you give them. Be specific about requirements, constraints, and expected outcomes.
- **Use workflow instructions** — They're your chance to give teammates phase-specific guidance (what tools to use, what to check, what to produce).
- **Review early** — Don't let review queues build up. Quick feedback loops keep teammates productive.
- **Use the context library** — Store patterns, conventions, and decisions so every teammate works consistently.
- **One story per concern** — Keep stories focused. Multiple small stories with clear tasks work better than one giant story.

# User Guide

## Overview

My Pizza Team (MPT) is a task coordination daemon for multi-agent teams. You create **stories** (units of work), break them into **tasks**, and assign them to AI **agents** that execute autonomously through a defined **workflow**.

The web UI at `http://localhost:7437` is your control center for managing all of this.

---

## Core Concepts

### Stories

A story is a high-level unit of work — like a feature, bug fix, or research task. Each story has:

- **ID** — A unique slug (e.g., `auth-system`)
- **Title** — Human-readable name
- **Description** — What needs to be accomplished (supports markdown)
- **Workflow** — Which workflow governs its tasks
- **Directory** — Optional working directory for agents
- **Dependencies** — Other stories that must complete first

### Tasks

Tasks are the individual steps within a story. They're worked on sequentially — the first unblocked task gets picked up by an agent. Each task has:

- **Title & Description** — What to do (supports markdown)
- **Status** — Current state in the workflow (e.g., `todo`, `in_progress`, `review`)
- **Assignee** — Which agent is currently working on it
- **Comments** — Communication between you and agents
- **Attachments** — Files agents upload (diffs, screenshots, etc.)

### Workflows

A workflow defines the lifecycle of tasks: what states they pass through and who can trigger each transition. For example:

```
todo → in_progress → leader_review → done
```

Each transition has a permission:
- **any** — Anyone (lead or agent) can trigger it
- **teammate** — Only agents can trigger it (autonomous work)
- **lead** — Only you can trigger it (review gates, approvals)

Workflows also have **instruction files** — markdown documents that tell agents what to do when entering each state and what criteria must be met to exit.

### Agents

Agents are autonomous AI coding assistants that connect to the daemon. They follow a simple loop:

1. Poll for available work
2. Claim a task (daemon transitions it to the working state)
3. Do the work
4. Release the task (daemon advances to the next state)
5. Repeat

You don't need to manage agent state — the daemon handles assignments, transitions, and handoffs.

---

## The Board

The board (`/board`) is the main view showing all active stories as horizontal swimlanes with task cards arranged by workflow state.

### Creating a Story

Click **Add Story** to open the creation dialog:

1. **ID** — A URL-safe identifier (auto-suggested from title)
2. **Directory** — Where agents should work (select from favorites or type custom)
3. **Workflow** — Select which workflow governs this story's tasks (required)
4. **Title** — What the story is about
5. **Description** — Detailed requirements (markdown supported)
6. **Tasks** — Optionally add initial tasks inline

### Managing Tasks

- **Add tasks** — Click the `+` button on a story swimlane
- **Edit tasks** — Click any task card to open the edit dialog
- **Move tasks** — Use the arrow buttons on cards, or the "Move To" buttons in the edit dialog
- **View details** — Click "details & comments →" on a card to see the full history

### Task Cards

Each card shows:
- Title and ID
- Current assignee (if claimed)
- Unread comment indicator (orange)
- Token cost (if tracked)
- Status navigation arrows (◀ ▶)

---

## Workflows

The workflows page (`/workflows`) lets you view and manage workflow definitions.

### Viewing a Workflow

Click any workflow to see:
- **State graph** — Visual representation of states and transitions
- **Lifecycle preview** — How a task flows through the states
- **Default categories** — Memory categories for stories using this workflow
- **Instructions** — Markdown instruction files for each state

### Editing States & Transitions

Click **Edit States & Transitions** to open the editor dialog where you can:
- Add/remove states
- Add/remove transitions between states
- Set permissions (any, teammate, lead) for each transition

### Instruction Files

Each state can have a markdown instruction file that agents receive when entering that state. These guide the agent on:
- **What to do** in this phase
- **Exit criteria** — what must be true before releasing the task

Write clear, actionable instructions. Agents receive these verbatim.

---

## Agents

The agents page (`/team`) shows all connected agents with their status, current task, and last heartbeat.

### Spawning Agents

Click **Spawn** in the board header to request a new agent:
- **Host** — Which machine should start the agent
- **Working Directory** — Where the agent operates (favorites + story dirs shown)

### Agent Lifecycle

Agents are autonomous — once spawned, they:
1. Register with the daemon
2. Poll for work every few seconds
3. Claim and work on tasks
4. Release when done
5. Repeat until dismissed

### Pausing Distribution

The **pause button** (⏸) in the navbar stops the daemon from handing out new tasks. Existing in-progress work continues. Use this when you need to reorganize stories without agents claiming things.

---

## Comments & Review

Comments are the communication channel between you and agents:

- **You → Agent**: Add comments on a task to provide feedback, request changes, or answer questions
- **Agent → You**: Agents post status updates, summaries, and questions

When an agent releases a task that moves to a lead-only state (like `leader_review`), you'll see it in your inbox. Review the work, add comments, then either:
- **Approve** — Move the task forward (e.g., `review → done`)
- **Send back** — Move it back (e.g., `review → in_progress`) with comments explaining what to fix

The agent will pick it up again, see your comments, and address them.

---

## Knowledge Base

The knowledge base (`/memory`) stores reusable notes that agents can search during work.

- **Categories** — Organize notes by topic (e.g., "coding", "architecture", "style-guide")
- **Search** — Agents use `search_memory` to find relevant notes
- **Auto-hints** — When a story has categories, agents are told relevant knowledge exists

Good things to put in the knowledge base:
- Coding conventions and style guides
- Architecture decisions
- Common patterns and gotchas
- Project-specific context

---

## Configuration

Visit `/config` to manage settings:

- **Port & Session** — Daemon network settings
- **Autosave** — How often work is flushed to disk and git-committed
- **Categories** — Global knowledge base categories
- **Favorite Directories** — Quick-access paths shown in directory dropdowns
- **Host Settings** — Per-machine configuration for multi-host setups

---

## Tips

- **Write good task descriptions** — Agents work from what you give them. Be specific about requirements, constraints, and expected outcomes.
- **Use workflow instructions** — They're your chance to give agents phase-specific guidance (what tools to use, what to check, what to produce).
- **Review early** — Don't let review queues build up. Quick feedback loops keep agents productive.
- **Use the knowledge base** — Store patterns, conventions, and decisions so every agent works consistently.
- **One story per concern** — Keep stories focused. Multiple small stories with clear tasks work better than one giant story.

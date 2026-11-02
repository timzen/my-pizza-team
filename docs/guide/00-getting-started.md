# Getting Started

My Pizza Team (MPT) runs a small team of AI **teammates** for you. You describe a
piece of work — a **task** — and a free teammate picks it up, does it, and reports
back. You read the result and decide what happens next.

Teammates are AI coding agents ([Pi](https://pi.mariozechner.at/) by default), each
running in its own terminal window. The **assistant** is the one you chat with: it
plans work with you and writes tasks for you. The web UI at
`http://localhost:7437` is where you watch it all.

## The five things you'll do

1. **Ask the assistant.** The chat is in the left dock, on every page. Tell it what
   you want ("add a dark mode toggle", "write these up as tasks for me to review").
   See [The assistant](04-assistant.md).
2. **Create a task.** The **+** in the dock (beside the queue summary) makes a task,
   a scheduled job, or a story. A task has a goal, what "done" means, and the folder
   to work in. See [Tasks and runs](01-tasks-and-runs.md).
3. **Watch the Queue.** The home page (the pizza logo) has two tabs. **Queue** shows
   work waiting and work in progress, and which teammate has it. Click a teammate to
   watch it work live. See [Teammates](03-teammates.md).
4. **Review in the Inbox.** Finished work lands in the **Inbox** tab, unread. Open a
   row to read the teammate's summary; comment and run it again if it needs more.
5. **Capture Thoughts.** **Thoughts** in the top nav is a board of sticky notes. Jot
   ideas there; a teammate reads changed notes every hour and suggests what could
   become work. See [Thoughts and triage](05-thoughts-and-triage.md).

## The Welcome checklist

A new team's home page starts with a **Welcome** card: the first steps above, as a
checklist with a progress meter. Each step ticks off by itself when you do it, wherever
you do it (the card, the CLI, the assistant), and the next one is highlighted with what
to do:

- **Start the leader** — run `mpt lead` in your team's directory (the card has a copy
  button). The leader is the assistant you chat with.
- **Get a teammate** — **Spawn a teammate**, or the reason it can't happen yet.
- **Create your first task** — **Use a sample task** fills in "Summarize this project"
  in the leader's directory; change anything, then **Run**. Or **Write your own**.
- **Watch it run**, **Review the result**, **Ask the assistant something**, **Capture a
  thought** — each links to where you do it.

Every step has a **Learn more** link to its part of this guide. When all are done the
card says **You're set**, with a few pages to read next, and goes away. **Dismiss**
hides it sooner; **Show the Welcome checklist**, at the bottom of the Help panel and
under this guide's contents, brings it back. A team that already has finished work
doesn't see it unless it asks.

## Read next

- [Tasks and runs](01-tasks-and-runs.md) — tasks, runs, pending, the Queue and Inbox
- [Stories and workflows](02-stories-and-workflows.md) — bigger work in ordered steps, on the Board
- [Teammates](03-teammates.md) — the team, watching, pairing, and what it costs
- [The assistant](04-assistant.md) — the chat and the big editor
- [Thoughts and triage](05-thoughts-and-triage.md) — notes that turn into work
- [Personas](06-personas.md) — how a teammate approaches a job
- [Sources](07-sources.md) — work from a tracker or another system
- [Configuration](08-configuration.md) — settings
- [On your phone](09-phone.md) — a quick look from your phone
- [Tips](10-tips.md) — good habits, getting around, and keyboard use
- [Glossary](glossary.md) — the words the UI and the docs use

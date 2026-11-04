# Getting Started

My Pizza Team (MPT) runs a small team of AI **teammates** for you. You describe a
piece of work — a **task** — and a free teammate picks it up, does it, and reports
back. You read the result and decide what happens next.

Teammates are AI coding agents ([Pi](https://pi.mariozechner.at/) by default), each
running in its own terminal window. The **assistant** is the one you chat with: it
plans work with you and writes tasks for you. The web UI at
`http://localhost:7437` is where you watch it all.

## The five things you'll do

1. **Ask the assistant.** The chat is in the dock (on the left, unless you
   move it), on every page. Tell it what
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

- **Start the assistant** — the button opens it for you (or, under **Or from
  a terminal**, run `mpt assistant` in your team's directory). The assistant is the
  agent you chat with.
- **Get a teammate** — **Spawn a teammate**, or the reason it can't happen yet.
- **Create your first task** — **Use a sample task** fills in "Summarize this project"
  in the assistant's directory; change anything, then **Run**. Or **Write your own**.
- **Watch it run**, **Review the result**, **Ask the assistant something**, **Capture a
  thought** — each links to where you do it.

Every step has a **Learn more** link to its part of this guide. When all are done the
card says **You're set**, with a few pages to read next, and goes away. **Dismiss**
hides it sooner; **Show the Welcome checklist**, at the bottom of the Help panel and
under this guide's contents, brings it back. The card also offers a short
[tour](#the-tour) of the screen. A team that already has finished work
doesn't see it unless it asks.

## The tour

Want to see where things are first? **Take the tour** shows each area of the screen in
turn — the top bar (Home, Work, Thoughts), the side dock with the assistant, Home's
Queue and Inbox, Work, Thoughts, Config, and Help — with a couple of sentences beside
each and the area outlined. It's on the Welcome card (until you've taken it), at the
bottom of the Help panel, and under this guide's contents.

- **Next** and **Back** move through the steps ("Step 3 of 7"); **Skip tour** or
  **Esc** ends it at any point, and **Done** on the last step.
- It doesn't take over the page: click or Tab out to try something, and the tour stays
  where it was. Areas that aren't on screen — Work with every kind switched off, say —
  are left out.
- With a screen reader, each step is announced, focus is on the step's buttons, and the
  outlined area is described by the step's text.
- This browser remembers you've taken it. The phone view has no tour: its four tabs
  are all there is to it.

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

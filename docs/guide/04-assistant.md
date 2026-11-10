# The assistant

The **assistant** is the agent you chat with, started from the web UI or with
`mpt assistant` (internally it's the [leader](glossary.md#leader), which is why its
window — a tmux window, or a herdr tab — is called `leader`). It isn't one of the teammates:
it helps you plan, and it creates and edits work for you. It lives in the **Assistant** tab of the dock (on the left, unless you
[move it](10-tips.md#getting-around)), on every page.

Things to ask it:

- to write up stories, tasks or scheduled jobs — "as pending" if you want to review
  them before anything runs (see
  [Pending](01-tasks-and-runs.md#pending-write-first-run-when-its-right));
- to make a story or a schedule pending, or activate it again;
- to read your [Thoughts](05-thoughts-and-triage.md) and turn them into work, or
  write the board (leave a follow-up note, annotate, archive, group).

It only offers the kinds of work your team has switched on (see
[Work items](08-configuration.md#work-items-feature-toggles)).

## Starting the assistant

When the assistant isn't running, the top of the chat says so — anything you send waits,
queued, until it starts — and offers **Start the assistant**. The daemon opens it in
its window (`<session>:leader`, in your project directory, in your team's
[terminal](08-configuration.md#terminal)); the button reads
**Starting…** until it connects, then the notice goes — if that takes a minute, it
shows the command that lets you look at the window (`tmux attach -t …`, or `herdr`). If it can't be started from the
web UI (the terminal unreachable, or no assistant command for your harness), the notice says why
and how to fix it. **Or from a terminal** shows the same start as a command,
`mpt assistant` (or its alias `mpt lead`), which also attaches you to the window. The same button is on the Welcome
checklist, the empty Team tab and the team-size dialog.

There is only ever one assistant. If you open a second Pi in the project directory
while the assistant is connected (or a terminal's session restore reopens one), it
shows *"This team already has a leader (another Pi is connected). This Pi stays
inactive."* and does nothing else, so the chat isn't answered twice; `/ppt-help` in it
explains why. Once the assistant exits or goes offline, a newly started Pi takes over.

## Chat in the dock, terminal at full page

The dock's size decides how the assistant looks. Docked (beside the page or across
the bottom), and on a phone or a narrow window, it's the iMessage-style **chat**:
short replies, one bubble per paragraph. Switch the dock to
[**Full page**](10-tips.md#getting-around) and it becomes the **terminal**: the
assistant's session the way a teammate's page shows it when you
[watch and pair with it](03-teammates.md#pairing-with-a-teammate), a terminal-style
transcript with every tool call, and the same composer. **Restore** brings the chat
back. It's the same conversation either way, and there's no setting for it. (The old
**Config → General → Assistant** chat/terminal choice is gone; a config.json that
still has `assistant.chatMode` loads fine and the field is ignored.)

In the terminal the composer is always open — there's no **Pair** step, since the
assistant has no queue of work to pause. As with a paired teammate, **Enter** queues
your message after the current run and **⌘/Ctrl+Enter** steers it in at the next
step. Like a teammate's page, the view opens with the current session so far —
tool calls included — then stays live; reading an earlier session from the session
menu shows it as the chat.

## Assistant personas

Who the assistant is comes from the [persona library](06-personas.md) too. Above the
chat, **Default** (the built-in assistant) and the personas suggested for the
assistant appear as chips — **Other…** picks any other persona, and **edit**/**view**
opens the current one. Picking one starts a fresh chat with that persona as the
assistant's system prompt (the old chat stays in the session history, which notes each
session's persona). The same choice is on **Config → General → Assistant →
Persona**. Swapping resets the assistant's context window.

## The big editor

For anything longer than a line, open the text in a full-screen editor — the web UI's
version of Ctrl+G in Pi or Claude Code. It works in the **assistant chat** and the
**pairing box** on a teammate's page. **Notes** and **descriptions** (a story's
description, a task's goal and additional context) don't need it: their **Edit** mode
*is* this editor, inline — with the same **Vim** switch beside Preview and the same
mode line under the text (see [Thoughts](05-thoughts-and-triage.md#writing-a-note)).

- **Open it** with the **Edit** button beside the text box, **Ctrl+G** while typing,
  or by sending **`/editor`** in a chat box (`/editor some text` brings the text with
  you).
- **Vim keys are on by default.** Don't want them? Click **Vim: On** in the header to
  turn them off — it's remembered. With vim on, the editor opens ready to type;
  **Esc** switches to normal mode, and the bar at the bottom always shows the mode and
  how to get out.
- **Finish** with **Done**, **⌘S**, or `:wq` (vim) / **Esc** (no vim) — your text goes
  back into the box. In a chat box, **⌘↵** (or the **Send** button) sends it straight
  away. **Discard** (or `:q!`) closes without keeping changes.
- **Write markdown comfortably** — line numbers, Enter continues lists and checklists,
  Tab indents, ⌘F searches, and **Preview** shows the rendered markdown beside the
  text.

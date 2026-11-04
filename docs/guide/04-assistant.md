# The assistant

The **assistant** is the agent you chat with — internally the
[leader](glossary.md#leader), started with `mpt lead`. It isn't one of the teammates:
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

## Assistant style: chat or terminal

**Config → General → Assistant** picks how you talk to the assistant. **Chat
(bubbles)**, the default, is the iMessage-style chat: short replies, one bubble per
paragraph. **Terminal** shows the assistant's session the way a teammate's page does
when you [watch and pair with it](03-teammates.md#pairing-with-a-teammate) — a
terminal-style transcript and the same composer. The assistant's reply style follows
the choice (no bubble-shaped answers in terminal mode). It applies as soon as you
save, from the assistant's next reply: no restart, and the current conversation
carries on.

In terminal mode the composer is always open — there's no **Pair** step, since the
assistant has no queue of work to pause. As with a paired teammate, **Enter** queues
your message after the current run and **⌘/Ctrl+Enter** steers it in at the next
step. Like a teammate's page, the view is live from when you open it (no backfill);
reading an earlier session from the session menu shows it as the chat.

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

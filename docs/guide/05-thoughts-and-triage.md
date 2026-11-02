# Thoughts and triage

**Thoughts** (in the top nav, `/thoughts`) is your personal workspace: markdown sticky
notes, organized into groups, with two ways to look at them — switch with **Canvas |
List** at the right end of the toolbar (your choice is remembered). Both views share
that toolbar: **+ Note** is always first, and **Archived** and the switch always sit
at the right; the buttons in between belong to the view you're in.

- **Canvas** — an infinite board you can pan, zoom, drag, and group on.
- **List** — like Apple Notes or OneNote: notes down the left, grouped into folders,
  and the selected note in full on the right.

## Canvas

- **Notes are all the same size** on the canvas, so the board scans as a board; a long
  note shows its start and fades out.
- **Open a note** to read or write it in full: **double-click** it, click the **⤢**
  icon in its corner (on hover), or select it and press **Enter**. The large view
  opens in Preview (Edit for a new or empty note — double-click the text or hit
  **Edit** to write). Its header has everything else: **color**, pin, group, copy id,
  the **Vim** switch (while writing), archive, delete. Closing it any way (Esc, Done,
  clicking outside, ⌘↵) **saves** — there's no way to lose an edit.
- **Capture** — hit **+ Note**; it opens straight into the editor. Checklists
  (`- [ ] task`) render as checkboxes you can tick on the canvas or in the large view.
- **Group by dragging** — drag a note **onto a group** to add it: once it's about half
  over (or your pointer is), the group highlights and **grows to wrap it**, showing
  where it'll land before you let go. Drag a member **off every group** to take it out
  (its border goes dashed while it's leaving).
- **Resize a group** with the grip on its bottom-right corner (a group always wraps its
  notes, so it won't shrink past them). Dragging a selection moves them all. Moving a
  group carries its notes; moving a group over loose notes doesn't absorb them — only
  a drop changes membership.
- **Organize** — pin the important ones, **Tidy** to grid-arrange, archive what's
  done. Select mode (`S`) or shift+drag marquee-selects; `Delete` archives, `1–6`
  recolor the selection, `G` groups it, `M` toggles the minimap (shown by default;
  your choice is remembered). Alongside it, a row of **group chips** — biggest group
  first — jumps the canvas to center that group when clicked.

## List

- **Folders are your groups** — alphabetical, each with its note count. Click one to
  collapse or expand it (remembered). Notes in no group are listed after the folders,
  under **Notes**. In each folder, pinned notes come first, then the most recently
  edited.
- **Click a note** to read it on the right; **↑ / ↓** move through the list. A note's
  title is its first line.
- **Write** — the right side is the same editor as the canvas's large view (Preview,
  or **Edit** / double-click the text), with the color, pin, group, archive, and
  delete controls above it. There's nothing to close: edits **save as you type**, and
  switching notes saves too. ⌘↵ returns to Preview.
- **File a note** — drag it onto a folder, or onto **Notes** to take it out of every
  folder. The group picker above the note does the same. On the canvas it moves into
  (or out from under) that group, so both views stay in step.
- **+ Note** makes a note in the current note's folder; **Folder** makes a new folder
  and lets you name it straight away. **Double-click** a folder (or use its **✎**) to
  rename it; its **×** deletes the folder but keeps its notes.
- **Search** filters notes by their text; folders with matches open automatically.
- Switching views keeps your place: the note selected in one is selected (and, on the
  canvas, centered) in the other.

## Writing a note

Writing a note uses the same editor as the
[big editor](04-assistant.md#the-big-editor) — line numbers, lists that continue on
Enter, and **vim keys on by default**. Click **Vim: On** in the note's header to turn
them off (remembered, and shared with the big editor). With vim on, a note opens ready
to type; the line under the text shows the mode and what to press. `:w` or ⌘S saves,
and `:wq` (or ⌘↵) finishes — back to Preview in the list, closed on the canvas. With
vim on, **Esc** is vim's and doesn't close the canvas's large view; there's no discard
— `:q!` finishes too.

## Auto triage: notes that become work

Every hour, a teammate reads the notes whose text you've changed and proposes what
should become work (this is [triage](glossary.md#triage)). It waits about ten minutes
after your last edit, so it never reads a half-written thought.

Nothing appears on the note itself except a small **badge**:

- a **lightbulb** when there's work waiting on your decision,
- a **?** when the teammate needs something from you,
- a **–** when it read the note and found nothing to create.

The badge — and the run's **Inbox** row, which is the real notification — opens the
note's **triage page**.

There you get the note on one side and the analysis on the other, with each proposal
(a task, a task in one of your stories, a whole story, or a scheduled job) offering
**Accept**, **Edit**, and **Reject**:

- **Accept** creates it and nothing more: a standalone task waits for you to press
  Run, a scheduled one waits for its schedule, and a task added to a story takes its
  place in that story's workflow exactly as one you added by hand would.
- **Edit** is the same thing with the fields opened up first, for "nearly right,
  but…".
- **Reject** takes one click and needs no reason.

Then it's **your turn** — and your turn is the note: edit it and the next sweep
re-reads it. That's how you answer a question, and how you steer a proposal you didn't
like; the next analysis is told what you accepted and rejected, so it won't offer the
same thing twice. Accepting and rejecting aren't turns, so they don't trigger a fresh
run.

A run that fails isn't retried on its own — **Triage now**, on the triage page, forces
one. Turn triage off, change its timing, or pick the [persona](06-personas.md) it
follows in **Config → Triage** (and edit that persona on Config → Personas). Archiving
a note stops its triage; deleting one removes its analysis with it.

Items from a [source](07-sources.md) can be triaged the same way — see
[Triage-mode sources](07-sources.md#triage-mode-sources).

## The assistant and your notes

The [assistant](04-assistant.md) can *read* your notes ("look at the thoughts in the Q3
group and help me draft a task") and turn them into stories/tasks/schedules that flow
to your Inbox, and *write* the board (leave a follow-up note, annotate, archive,
group).

## Where notes are kept

Notes live under the team directory as `thoughts/<id>.md` (markdown + frontmatter) —
easy to hand-edit or grep; groups are in `groups.json`. A note's "edited" time changes
only when its text does — moving, recoloring, pinning, or filing it doesn't count.

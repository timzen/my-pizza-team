# Tips

## Good habits

- **Write testable acceptance criteria** — use RFC 2119 keywords (MUST/SHOULD/MAY).
  The editor scores them for you.
- **Home the right teammates** — a teammate started in a repo preferentially picks up
  that repo's work. Use **Spawn** to put one where the work is (pool teammates spawn
  in the leader's directory).
- **Review early** — drain the Inbox; quick feedback loops keep teammates productive.
- **Use personas** — give each agent step its own role framing, and give recurring
  jobs a persona of their own.
- **Keep project knowledge in the project** — conventions and build commands go in the
  repo's AGENTS.md, where every teammate reads them.
- **One story per concern** — small focused stories beat one giant story.
- **Standalone for chores** — recurring or ad-hoc work that isn't a feature belongs on
  Work → Tasks/Schedule, not the Board.

## Getting around

The nav bar has two destinations, plus pause / **usage** / help / config / theme
icons.

**Help where you are.** Every page has a **?** beside its title. It opens the part of
this guide about that page in the dock's **Help** tab, next to the page, so you can
read and click along; **Esc** (or the ✕ on the tab) closes it and puts you back where
you were. Links in it to other sections open there too. The nav bar's ? icon does the
same, and so does the **?** key anywhere you aren't typing. **Open full guide** at the
top of the tab — or **Shift**-clicking the nav bar's ? — opens the whole guide at that
section.

The full guide (`/help`) lists the topics on the left, with the
sections of the one you're reading under it, and the box above them searches every
page. Each section has its own address (`/help/<topic>#<section>`), so you can
bookmark or share one, and **Previous** / **Next** at the bottom of a page walk the guide
in order. In a narrow window the list folds into a **Contents** button.

- **Thoughts** — sticky notes, where ideas start: a canvas, or a list with folders
  (see [Thoughts and triage](05-thoughts-and-triage.md)).
- **Work** — all your work, in tabs (see
  [The Work tabs](01-tasks-and-runs.md#the-work-tabs)).

Workflows and the persona library live under the **config** (gear) icon, as
**Config → Workflows** and **Config → Personas**.

The highlighted destination is the section you're in, detail pages included: a story,
story task, standalone task, or scheduled job page lights **Work**, and every Config
tab (Workflows and Personas included) lights the gear. The ← back arrow on a detail
page returns to wherever you opened it from (the Inbox, a teammate, the Usage
page…); only when there's nowhere in-app to go back to (say, a link opened in a new
tab) does it take you to that section's list.

## Keyboard and screen readers

Everything works without a mouse, and you can always see where you are: the control
you're on has a visible ring.

- The first **Tab** on any page reaches **Skip to content**, which jumps past the dock
  and the nav to the page's heading.
- Following a link moves you to the new page's heading (and a screen reader announces
  it), while switching tabs — Work's, Config's, Queue | Inbox, a page's Details |
  Thread — keeps you on the tabs, and nothing you open from the dock pulls you out of
  the dock.
- Each browser tab is titled with the page, then the team — e.g. "Board · Work · acme
  · Pizza Team" — so a row of tabs reads at a glance.
- "Are you sure?" questions (archive, delete, discard…) are a small dialog that starts
  on **Cancel**: **Enter** there backs out, **Esc** backs out too, and you land back
  on the button you pressed.
- **?** (when you aren't typing in a box) opens or closes the help for the page
  you're on, in the dock; your place is kept, and closing it brings you back to it.
- In **Help**, type in the search box, then **↓** to the results (**↑** / **↓** move
  through them, **Enter** opens one at its section); **Esc** clears the search. A screen
  reader hears how many results there are once you stop typing. Opening a section's
  link puts you on its heading.
- If your system asks for **reduced motion**, the UI drops its fades, pulses and
  smooth scrolling.

**What a screen reader hears.** Things that change on their own are announced
briefly, without moving you:

- **"Assistant replied"** when a chat answer arrives (the answer itself is in the
  conversation, which a screen reader treats as a log — go there to read it);
- a one-line summary of the queue — **"“Fix login” started"**, or **"Queue: 2
  started, 1 finished · 3 unread in Inbox"** on a busy minute, at most every 15
  seconds;
- **"ripley went offline"** when a teammate drops off.

Saving, activating, archiving or deleting says how it went ("Story saved",
"Activated", "Deleted task …"), and an error is read out at once; a field with a
problem is marked invalid, and focusing it reads the error. Refreshes that find
nothing new say nothing.

**Hints.** Every icon-only button and link says what it does in a small tooltip — when
you **hover** it, and also when you reach it with **Tab** — and **Esc** closes the
tooltip. A screen reader announces the same words as the control's name (longer hints
as its description), so nothing depends on a mouse. Buttons that are greyed out still
take focus when their hint explains why (e.g. **Run now** on a pending task).

The Usage grid has its own keys — see
[Usage](03-teammates.md#usage-what-the-team-costs).

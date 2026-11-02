# Accessibility

The web UI (desktop and the phone view at `/m`) targets **WCAG 2.2 level AA**: everything
works with a keyboard alone, every control has a name a screen reader can announce,
and nothing is conveyed by color, hover or motion alone. This page is the target, how
it's checked, the rules for new UI code, and where the UI stands.

The work is tracked by the "Onboarding 1: Accessibility & labels foundation" story:

| Task | What it fixes |
|---|---|
| `ui-a11y-foundations-1` | The checks below (lint + axe) and this baseline |
| `ui-a11y-foundations-2` | Labelled icon controls, the Tooltip component, text alternatives |
| `ui-a11y-foundations-3` | Page titles, landmarks, skip link, focus, reduced motion, contrast |
| `ui-a11y-foundations-4` | Live announcements; the allowlist emptied, the lint rules back to "error" |

## The checks

Two automated checks, plus a keyboard pass by hand. Automated tools find roughly a third
of real problems — a clean scan is the floor, not the finish.

### Lint: `eslint-plugin-jsx-a11y`

`ui/eslint.config.js` adds jsx-a11y's **recommended** rules to the UI's lint
(`cd ui && npx eslint .`, part of the gates). Every rule is an error — never `"warn"`
or `"off"`. (Task 1 left `no-autofocus`, `click-events-have-key-events` and
`no-static-element-interactions` as warnings; task 3 fixed what they found and turned
them back.)

One project rule rides along: `no-restricted-syntax` rejects a `<Button size="icon…">`
written directly — an icon-only button must be an `IconButton`, whose required `label`
names it (the one exception, the dialog's close button, is named by an `sr-only` "Close"
and carries a disable comment).

A justified exception is an `eslint-disable-next-line <rule> -- <reason>` on the line, not
a config change: e.g. `anchor-has-content` on a `<Button render={<a … />}>`, whose
anchor gets the Button's children from Base UI at render time, or `no-autofocus` on a
field that appears *because the user asked for it* (Rename, Edit, a line's comment box) —
never on something that renders on page load. A click-to-edit surface whose keyboard
path is a real button beside it (the title and markdown fields' **Edit**, a folder's ✎,
a diff line's number) is `role="presentation"`: a pointer shortcut, not a second tab stop.

### Scan: axe-core on every main route

```bash
npm run test:a11y                         # builds the UI, then scans (about a minute)
A11Y_ROUTES=/help,/m npm run test:a11y    # only some routes (by path)
A11Y_REPORT=/tmp/report.md npm run test:a11y   # where the full report goes
```

`tests/a11y/routes.test.ts` starts a daemon on a temp copy of `tests/fixtures/a11y-team`
(the mpt-demo-team's team fixture, minus its plugins: a story with three tasks, a pending
story, a Solitary and a Scheduled WorkDef — plus two notes), loads each route in
Playwright's headless Chromium (`playwright-core`; the browser comes from
`~/.cache/ms-playwright` — `npx playwright-core install chromium` if it's missing) and runs
[`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm) with the WCAG 2.0–2.2
A/AA rules. It is separate from the fast `npm test`.

Routes: `/`, `/queue`, `/thoughts`, `/work/board`, `/work/tasks`, `/work/schedule`,
`/work/pending`, `/work/archived`, a task page, a story page, both WorkDef kinds, `/config`
and every Config tab (plus a workflow's detail), `/help` and two of its topics, `/usage` —
at 1440×900 — and `/m`, `/m/chat`, `/m/thoughts`, `/m/inbox`, `/m/help` with iPhone 13
emulation, all in the light
theme; then every desktop route again in **dark** (`prefers-color-scheme: dark`), for
`color-contrast` only, named `<path> (dark)`. The default palette is scanned; Solarized
isn't (its focus ring is unit-tested, below).

On top of axe's WCAG rules, each light-theme route checks its **structure**: axe's
best-practice `page-has-heading-one`, `heading-order`, `landmark-one-main`,
`landmark-no-duplicate-main`, `landmark-main-is-top-level` and `landmark-unique`
(promoted to serious), and by hand (`structureFindings`): exactly one rendered `<h1>` and
one `<main>`, a title shaped `<page> · <team> · Pizza Team`, and "Skip to content" as the
first Tab. After the routes, a full run walks a few **keyboard** paths and fails if focus
lands anywhere unexpected: the skip link → the page's h1; a NavBar link → the new page's
h1; a Work tab → that tab (not the heading); a confirm dialog opens on **Cancel** and Esc
returns focus to the button that opened it; the dock's Help panel — the page's ?
opens it on the page's section with focus on its heading (and the open panel passes axe),
Esc closes it and focus returns to the ?, the `?` key opens and closes it, the NavBar's
Help opens it, and **Open full guide** lands on that section's heading in `/help`; and the Help — its search box by keyboard
(the result count announced, ↓ + Enter onto a result focuses its heading, Esc clears), a
`#section` deep link focusing its heading with the topic `aria-current` in the Guide nav,
an old `/help#anchor` landing on the right topic, and **Next** moving focus to the next
topic's h1. Then the **announcer**, on the desktop and at
`/m`: exactly one polite and one assertive live region, both silent after a load (nothing
changed, so nothing is said), the chat transcript a `role="log"` that doesn't read itself
out, and a story's **Make pending** spoken as "Story made pending".

**Contrast in every theme** is also a unit test (`tests/contrast-ui.test.ts`, in `npm test`):
it parses `ui/src/index.css` and holds the default palette's text — foreground and muted
text on every surface, button text, destructive text on its own tints — to 4.5:1 in light
and dark, and the focus ring to 3:1 on every surface in every palette.

**What fails** (`tests/a11y/_gate.ts`, unit-tested in `tests/a11y-gate.test.ts`):

- a **serious** or **critical** violation whose route and rule aren't in
  `tests/a11y/allowlist.json`;
- an allowlist entry that no longer matches anything — it was fixed, so remove it. The
  list can only shrink, and a stale entry can't quietly cover a later regression.

Minor and moderate findings never fail; every finding is in the markdown report the run
writes (its path is printed; `$TMPDIR/mpt-a11y-report.md` by default), with a selector for
the first offending element. Each allowlist entry names the task that removes it. Since
task 3 the list is **empty**: any serious or critical finding fails the scan.

### By hand: the keyboard pass

For any UI change, use the changed screens with the keyboard only — Tab / Shift+Tab /
Enter / Space / Esc / arrow keys — on the desktop and at `/m` with phone emulation.
Everything you can do with a mouse, you can do this way, and you can always see where
focus is.

## Rules for new UI code

- **Every control has an accessible name.** Text content, an associated `<Label htmlFor>`
  (`aria-labelledby` for a Base UI `SelectTrigger`), or `aria-label` — a `placeholder`
  is not a name. An icon-only button or link is never just an icon: use
  `IconButton` / `IconLink` (`components/ui/icon-button.tsx`), which require a `label`
  — it becomes the `aria-label` *and* the tooltip; a longer `hint` becomes the tooltip
  and the description instead. A name that differs from the visible text starts with
  it (WCAG 2.5.3 Label in Name), and a repeated control says which item it acts on
  ("Remove ripley", "Cancel Add GET /todos/:id").
- **Hints go in the Tooltip, not `title=`.** `<Tooltip content={…}>` from
  `components/ui/tooltip.tsx` wraps one trigger element: it opens on hover *and*
  keyboard focus, stays open while hovered, closes with Esc, and sets
  `aria-describedby` (a hidden copy of the hint, since the popup only exists while
  open). Pass `describe={false}` when the hint only repeats the trigger's name, and
  `focusable` on a non-interactive trigger whose hint carries information (it becomes a
  tab stop — never inside a link, and sparingly in lists). A disabled `Button` whose
  hint says *why* it's disabled takes `focusableWhenDisabled`, or the keyboard never
  reaches it. `title` is mouse-only; keep it only to reveal text cut off by `truncate`
  (the element's text is already its name).
- **Icons:** lucide icons render `aria-hidden` by default, so a decorative one needs
  nothing. A meaningful one (a status shape, a receipt, a warning) is `role="img"` with an
  `aria-label`; a number-only badge on an icon is `aria-hidden` and its control's name
  says the count in words. Teammate status is announced as text (`statusLabel` names
  the icon; `teammateSummary` names the row's link and the rail avatar) — shape and
  color only reinforce it (docs/DESIGN.md "Teammate Status: Shape, not Color").
- **Hover-revealed controls appear on focus too** (`group-focus-within:` /
  `focus-visible:opacity-100` beside `group-hover:`), so Tab never lands on something
  invisible.
- **Use native elements.** A `<button>` for actions, `<a>`/`<Link>` for navigation,
  real form controls. A clickable `<div>` needs a role, `tabIndex` and key handling — and
  usually should be a button instead.
- **Focus is always visible and never lost.** index.css draws one ring for every
  `:focus-visible` element — a 2px `--ring` outline, unlayered so a utility's
  `outline-none` can't remove it — so don't add your own `focus-visible:ring-*` (a
  CodeMirror frame, which can't take the outline, uses `focus-within:ring-2 ring-ring`).
  Dialogs and menus are Base UI's, which return focus to their trigger; a custom popup
  puts focus back itself when it closes (the directory picker does, on Esc or a pick).
  Never `window.confirm()`: use `useConfirm()` (`components/ui/confirm-dialog.tsx`), an
  AlertDialog that opens on Cancel and gives focus back to the button that asked.
  A route change moves focus to the new page's h1 (`hooks/useRouteFocus`) — except a
  route tab (`RouteTabs` keeps focus on the tab), a `?tab=` switch (Details | Thread),
  and anything while focus is in the side dock (`data-keep-focus`).
- **Structure:** one `<h1>` per page (visually hidden — `sr-only` — where the page has no
  room for one: the canvas, Queue | Inbox, the phone's tabs) and headings in order;
  rendered markdown starts at h2 (`MarkdownView` shifts its headings down a level); one
  `<main>`; `<nav>` landmarks with unique labels ("Main", "Side dock", "Work sections" …);
  "Skip to content" first. Each route's `document.title` is `<Page> · <team> · Pizza
  Team`: add a new top-level route to `lib/page-title.ts` `pageTitleForPath`; a detail
  page calls `useDocumentTitle` with its item's name. The lit nav link or tab is
  `aria-current="page"`.
- **Scrolling regions** take keyboard focus: a code block that scrolls sideways becomes a
  named tab stop (`MarkdownView`'s `ScrollablePre`), only when it scrolls.
- **Small targets** (under 24×24) are fine inside one composite control with a single tab
  stop, like the Usage heatmap's grid (arrow keys between days, Enter to list a day's
  runs) — not as hundreds of separate buttons.
- **Live announcements: politely, briefly, and once.** Things that change without a page
  load go through the app-wide announcer (`components/Announcer.tsx`, mounted once in
  `main.tsx`): `const announce = useAnnounce(); announce("Story saved")` speaks through
  its polite region, `announce(msg, "assertive")` through the assertive one — errors
  only. Never add your own `aria-live` region or `role="alert"`: two regions speaking at
  once garble each other.
  - **A save's result:** every save / activate / archive / delete / send handler says
    how it went ("Saved", "Activated", "Deleted task …", "Queued for ripley"). Keep it
    short and name the item when it isn't obvious.
  - **A form's error** is a `<FormError id=…>{error}</FormError>`
    (`components/ui/form-error.tsx`), not a bare red `<p>`: it's announced assertively
    when it appears or changes (a source check in `tests/live-announce-ui.test.ts`
    rejects `{error && <p className="… text-destructive">{error}</p>}`). When the error
    is about one field, that field gets `aria-invalid` and `aria-describedby` the
    FormError's id (`DirectoryInput` and `PersonaPicker` take an `errorId` for it).
  - **A field's hint** is a `<FieldHint id=… field=…>` (`components/ui/field-hint.tsx`,
    copy in `lib/field-help.ts`), and the field lists its id in `aria-describedby` —
    after the error's, when there is one (`describedBy(errorId, hintId)`;
    `DirectoryInput` / `PersonaPicker` take a `hintId`). Write new copy there, not in
    the form. Hints aren't announced: they're read when you reach the field.
    Errors that change as you type (a JSON field's parse error) describe their field but
    aren't announced.
  - **Polled data is announced only through a diff** (`lib/live-announce.ts`, wired by
    `hooks/useLiveAnnouncements.ts`): the first answer is a baseline, an unchanged poll is
    silent (docs/DESIGN.md "Polling Never Disturbs the Reader"). Today: a new assistant
    reply ("Assistant replied" — never the message itself); queue items starting, at
    risk, finishing, failing or canceled, plus a rise in the Inbox's unread count, folded
    into one summary ("“Fix login” started", "Queue: 2 started, 1 finished · 3 unread in
    Inbox") at most every 15 seconds; a teammate going offline ("ripley went offline").
    A new kind of live news adds a rule there, with a test.
  - **The chat transcript is a `role="log"`** with `aria-live="off"` (overriding the
    role's implicit polite), named "Conversation": a screen reader can find it and read
    it in order, but a long answer never talks over you.
- **Contrast:** 4.5:1 for text, 3:1 for large text, icons and focus rings — in both
  themes. Use the theme's tokens (`text-muted-foreground`, not `/60`–`/70` of it). Status
  colors as text are a 700 shade in light with a 400 in dark (`text-amber-700
  dark:text-amber-400`; `-800` on a `/15` tint of its own color); a 600 is fine only for
  an icon or a dot (3:1).
- **Motion:** `prefers-reduced-motion: reduce` stills every CSS animation and transition
  (index.css: the dialogs' fades and zooms, the thinking dots, pulses, spinners, the
  canvas's drag transitions). Script-driven motion asks `lib/motion.ts` —
  `scrollTo({ behavior: scrollBehavior() })`. The canvas's pans and zooms are instant
  already.
- **Phone view:** touch targets at least 24×24 CSS px (WCAG 2.5.8), and the same names
  and labels as the desktop.

## Baseline (task 1)

The first scan, before any fixes: **35 serious/critical findings on 26 routes**, all
allowlisted. The lint found 23 problems; 5 were fixed and 18 remain as warnings (above).

| Rule | Impact | Routes | What it is | Fixed by |
|---|---|---|---|---|
| `color-contrast` | serious | all 26 | `text-muted-foreground` (the queue summary's "· N running" parts, secondary text, tabs) is below 4.5:1 in the light theme | task 3 |
| `button-name` | critical | `/work/board`, `/config`, `/config/teammates` | buttons with no name: Select triggers with no associated label (the board's and General's), the "×" on a teammate-noun badge and the icon-only add button beside them | task 2 |
| `label` | critical | `/thoughts`, `/config`, `/config/triage` | inputs with no label: an unlabelled input on the Thoughts page, and Config's General and Triage number/text fields, whose visible label isn't tied to the input | task 2 |
| `select-name` | critical | `/config/workflows/default` | the per-state persona `<select>` | task 2 |
| `scrollable-region-focusable` | serious | `/help` | code blocks that scroll sideways but can't take keyboard focus | task 3 |
| `target-size` | serious | `/usage` | the usage heatmap's day cells (365) are smaller than 24×24 px | task 3 |

Fixed in task 1: the favorite-directories "add" button got a name, its Enter-catching
wrapper is `role="presentation"`, and the false positives (`anchor-has-content` on the
three "Open in …" links, `label-has-associated-control` on the Label primitive) carry a
justified disable comment.

## Status after task 2: names, the Tooltip, text alternatives

**28 serious/critical findings, all allowlisted** (`color-contrast` on the routes,
`scrollable-region-focusable` on `/help`, `target-size` on `/usage` — task 3). The seven
`button-name`, `label` and `select-name` entries are gone from the allowlist:

- The board's sort and General's Select triggers are labelled (`aria-label` /
  `aria-labelledby` the visible Label); General's and Triage's fields are tied to their
  `<Label htmlFor>`; the workflow page's per-state persona `<select>` has a name
  (`PersonaPicker`'s `label`); the teammate-noun "×" says which noun it removes; a
  Markdown task checkbox is named by its item's text; the CodeMirror surface is named
  ("Note", the big editor's title, else "Markdown editor").
- Every icon-only control is an `IconButton` / `IconLink` or a `<button aria-label>` in a
  `Tooltip`: the NavBar's pause / Usage / Help / Config / theme, the dock (collapse,
  rail, team size, spawn), story swimlanes, the story page, the Thoughts toolbar,
  zoom, group plates, note editors (desktop and `/m`), chat bubbles, queue rows and more.
- `title=` is gone as a hint (about 230 → 6, all on `truncate` text whose content is
  its name). Hints moved to the Tooltip, so they show on keyboard focus too.
- Meaningful icons got text: teammate status icons and a teammate's skew warning
  (`role="img"`), chat receipts and origin, queue-preview state dots, usage-run dots, a
  source's "always on" and the required-field `*`; the NavBar's and rail's number-only
  badges are hidden from assistive tech and their links say the counts.
- A new axe rule surfaced and was fixed in the same pass: `label-content-name-mismatch`
  on the home link (its name now starts with the visible "Pizza Team").

Known gaps the scan doesn't cover: the dark theme, dialogs and menus in their open state,
the assistant chat with messages, a teammate's live view, and keyboard operability
generally — the keyboard pass covers those.

## Status after task 3: structure, focus, motion, contrast

**0 serious/critical findings on 48 scans** (26 routes light, 22 desktop routes dark); the
allowlist is empty, the lint has no warnings, and the new structure checks and keyboard
walks pass. Before → after:

- **Titles:** every tab said "Pizza Team"; now `<Page> · <team> · Pizza Team` — e.g. "Board
  · Work · acme · Pizza Team", "Theme · Configuration · …", a task's or story's own title.
  The team's name is `/api/status` `teamName` (its repo's directory name).
- **Landmarks and headings:** the NavBar's links and the dock had no `<nav>` (the dock was
  an unnamed `<aside>`), Queue | Inbox, the Thoughts canvas, the story page and the phone
  view had no h1, and Help had two (its guide's `#`). Now: "Main", "Side dock", the
  section tabs' and the phone's tabs' navs, one h1 everywhere, markdown from h2.
- **Skip link:** "Skip to content" is the first Tab on both shells.
- **Route focus:** a NavBar or in-page link left focus on `<body>` (the old page's link
  was gone), so the next Tab started at the top; now focus lands on the new page's h1 (a
  route tab keeps it on the tab, the dock keeps its own).
- **Focus ring:** a 50%-alpha `ring/50` halo (about 1.5:1 in light) on primitives, the
  browser default elsewhere, and none where `outline-none` was set; now one 2px outline,
  3:1 or better in every palette.
- **Confirms:** 17 `window.confirm()`s (Archive, Make pending, every Delete, Discard, the
  unsaved-changes guard, Switch persona, Mark failed) are `useConfirm()` dialogs.
- **Keyboard paths:** folders and canvas groups have a Rename button (double-click was the
  only way); a diff line's number is its "Comment on line N" button; the directory
  picker's list closes with Esc and returns focus; two dialogs no longer autofocus a field
  Base UI would focus anyway, and the terminal composer (on every page in terminal chat
  mode) no longer grabs focus on load.
- **Contrast:** light `--muted-foreground` 0.556 → 0.52 (4.34 → 5.05:1 on `--muted`),
  `--destructive` darker in light and lighter in dark (its text on its own tint was 4.0:1),
  status text from 600 to 700 shades (about 3.2 → 5:1) with 400s in dark, the faded
  "empty" hints at full muted color.
- **Help's code blocks** scroll by keyboard; **the Usage heatmap** is one grid tab stop
  (was 365 undersized buttons).
- **Motion:** reduced motion stills animations and transitions; the chat's smooth scrolls
  jump instead.

Known gaps after task 3 (live announcements are closed by task 4, below): **Solarized** keeps its own colors, and its secondary text
(base0 / base00 on its backgrounds) is under 4.5:1 by design — its focus ring meets 3:1;
CodeMirror editors use Tab to indent (Esc, then Tab, leaves — with vim on, Esc is vim's);
the Thoughts canvas is still pointer-first (its list view is the keyboard path); live
announcements are task 4. The scan still doesn't open dialogs or menus beyond the one
confirm, or see the assistant chat with messages or a teammate's live view.

## Status after task 4: live announcements — the final state

**0 serious/critical findings on 48 scans; the allowlist is empty and every jsx-a11y rule
is an error** (both since task 3), and the keyboard walks now check the announcer too.
Before → after:

- **Live regions:** the UI had one — the NavBar's notice line (`role="status"`) — so a
  chat reply, a queue item starting or failing, a run landing in the Inbox, a teammate
  dropping off, or the result of a Save happened in silence unless you went looking.
  Now one app-wide announcer (a polite and an assertive region) on both shells says each
  of those once, briefly; the queue's news is one summary at most every 15 seconds.
- **Chat:** the transcript was an unnamed `<div>`; now a `role="log"` named
  "Conversation", quiet itself, with "Assistant replied" announced instead.
- **Forms:** 27 error lines were bare red text, never announced; now every one is a
  `FormError` (announced assertively), and the fields they're about — the new-job title,
  team size, a favorite directory, a workflow or state name, a cron, a persona's
  instructions, a state's persona, a source's settings, the pair composer — are
  `aria-invalid` and described by them. About 50 save / activate / archive / delete
  handlers announce their result. The Add Task form's Title is labelled.

Known gaps: **Solarized**'s secondary text is under 4.5:1 by design; CodeMirror editors
use Tab to indent (Esc, then Tab, leaves) and a markdown field (Goal, Description) can't
be marked `aria-invalid` yet — its error is still announced; the Thoughts canvas is
pointer-first (its list view is the keyboard path); the Thoughts note editor autosaves
silently (its "saved" state is visual); and the scan still doesn't open most dialogs and
menus, or see a teammate's live view. The keyboard pass covers those.

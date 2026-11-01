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
(`cd ui && npx eslint .`, part of the gates). Each rule is an error, except those
whose remaining violations need a later task: those are `"warn"` with a `TODO` naming
the task — never `"off"`. Today that is:

| Rule | Why it's a warning | Back to "error" in |
|---|---|---|
| `no-autofocus` | inline editors and dialogs focus their field on open; decided per case with focus management | task 3 |
| `click-events-have-key-events`, `no-static-element-interactions` | click-to-edit surfaces (title and markdown fields, a note's "tap to write", a diff line's comment, a folder's rename) need their own keyboard path | task 3 |

One project rule rides along: `no-restricted-syntax` rejects a `<Button size="icon…">`
written directly — an icon-only button must be an `IconButton`, whose required `label`
names it (the one exception, the dialog's close button, is named by an `sr-only` "Close"
and carries a disable comment).

A justified exception is an `eslint-disable-next-line <rule> -- <reason>` on the line, not
a config change: e.g. `anchor-has-content` on a `<Button render={<a … />}>`, whose
anchor gets the Button's children from Base UI at render time.

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
and every Config tab (plus a workflow's detail), `/help`, `/usage` — at 1440×900 — and
`/m`, `/m/chat`, `/m/thoughts`, `/m/inbox` with iPhone 13 emulation. Only the default
(light) theme is scanned.

**What fails** (`tests/a11y/_gate.ts`, unit-tested in `tests/a11y-gate.test.ts`):

- a **serious** or **critical** violation whose route and rule aren't in
  `tests/a11y/allowlist.json`;
- an allowlist entry that no longer matches anything — it was fixed, so remove it. The
  list can only shrink, and a stale entry can't quietly cover a later regression.

Minor and moderate findings never fail; every finding is in the markdown report the run
writes (its path is printed; `$TMPDIR/mpt-a11y-report.md` by default), with a selector for
the first offending element. Each allowlist entry names the task that removes it; task 4
leaves the list empty.

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
- **Focus is always visible and never lost.** Every interactive element has a
  `focus-visible` ring (don't add `outline-none` without one); dialogs and menus return
  focus to their trigger; a route change moves focus to the page's heading (task 3).
- **Structure:** one `<h1>` per page and headings in order; one `<main>`; labelled
  `<nav>` landmarks; each route sets `document.title` (task 3).
- **Live regions announce changes, politely and once.** Things that change without a
  page load (a chat reply, a run finishing, a save's result) go through the app-wide
  announcer (task 4). Polling must never re-announce unchanged data (docs/DESIGN.md
  "Polling Never Disturbs the Reader").
- **Contrast:** 4.5:1 for text, 3:1 for large text, icons and focus rings — in both
  themes.
- **Motion:** respect `prefers-reduced-motion` for animations, transitions and canvas
  pans (task 3).
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

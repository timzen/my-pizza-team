# fixtures/team-legacy — a pre-0.36.0 team layout

my-pizza-team refuses to start on a team last run on a version older than
0.36.0 (my-pizza-team docs/DESIGN.md "Upgrading from before 0.36.0"). This
fixture has a few of the formats it detects, so tests/e2e/legacy-layout.test.ts
can check the refusal (copied from mpt-demo-team; see ../README.md):

- `stories/add-user-auth.json` — the pre-pending `paused` flag
- `backlog/polish-ui-theme.json` — a story file in the old `backlog/`
- `tasks/add-user-auth-1/workdef.md` — `draft: true` (renamed `pending: true`)
- `triage.md` — the team's triage instructions (replaced by a triage persona)

and one thing it must **not** report: `archived/old-story/story.json`, a nested
folder-per-story leftover the old migrations never handled.

Keep it in the old layout — that's its point.

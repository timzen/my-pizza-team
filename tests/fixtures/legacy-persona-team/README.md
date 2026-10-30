# legacy-persona-team

A team directory in the **pre-persona layout**, used by
tests/persona-migration.test.ts (copied to a temp dir, never migrated in place).
It has one of every legacy source the persona migration handles
(docs/DESIGN.md "Personas" — Migration):

- `workflows/default/in_progress.md` — a state persona file (step 1)
- `workflows/pipeline/review.md` — a leftover beside a state that already names a persona
- `triage.md` — the team's triage instructions (step 2)
- `context/pizzaiolo.md` — a persona-tagged entry that collides with an existing,
  different `personas/pizzaiolo.md` (step 4, collision rule)
- `context/project-conventions.md`, `context/api-style.md` — attached to stories,
  board tasks, a Solitary task, and a template (step 6)
- `context/unused.md` — unattached; only archived (step 7)
- `assistant/sessions/*.md` — a chat snapshot whose persona is the colliding entry (step 5)

The SQLite `assistant_persona` setting and the session row are seeded by the test.

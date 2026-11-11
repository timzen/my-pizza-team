# tests/fixtures/demo — the demo team, for the e2e suites

Copied from the **mpt-demo-team** repo (`fixtures/` and `plugins/`, at its commit
`fd88a46`, "run-e2e.sh: --terminal herdr runs the full flow under herdr"), so the
checks its `run-e2e.sh` made run here as node:test suites with a verdict (see
`tests/e2e/_demo.ts` for how a sandbox lays this out, and the suites that use it:
`legacy-layout`, `pending-workdefs`, `demo-tracker`, `personas`, `assistant-start`,
`team-flow`).

The persona files were re-synced at `4696995` ("Personas: kinds: [teammate]"): every
persona says `kinds: [teammate]` except `plugins/mpt-source-demo-tracker/personas/tracker-worker.md`,
which keeps the deprecated `kinds: [worker]` on purpose so the alias stays exercised
(`tests/e2e/personas.test.ts`) until the `remove-worker-aliases` story removes it.

| Here | From mpt-demo-team | Changes |
|---|---|---|
| `team/` | `fixtures/team/` | see below |
| `team-legacy/` | `fixtures/team-legacy/` | `port` dropped; `tmuxSession` is `__SESSION__` |
| `tracker/tracker.json` | `fixtures/tracker/tracker.json` | none |
| `plugins/mpt-source-demo-tracker/` | `plugins/mpt-source-demo-tracker/` | README dropped |
| `plugins/mpt-personas-demo/` | `plugins/mpt-personas-demo/` | README dropped |

`team/config.json` differs from the demo's so the tests are deterministic and fast:

- `tmuxSession: "__SESSION__"` (the sandbox's session) and no `port` (the sandbox picks one);
- `minTeammates: 0`, so only the tests spawn teammates;
- plugin paths `../../plugins/…` (the sandbox copies `plugins/` next to the project);
- `intervalSeconds: 1`, so syncs (and the "nothing syncs while switched off" check) take
  seconds, not tens of seconds.

Dropped: the nightly schedule (`schedules/nightly-test-run.json` and its WorkDef; a run
at 2am would have been enqueued mid-test), and `fixtures/project/` (the todo API the
agents edit — the scripted teammates never touch code, so the sandbox's empty project
directory stands in for it). `__DEMO_PROJECT__` is replaced with the sandbox's project
directory, as setup-demo.sh did.

The demo repo stays the place to *show* MPT; these copies are what MPT's tests depend
on. A change to one needn't be mirrored in the other.

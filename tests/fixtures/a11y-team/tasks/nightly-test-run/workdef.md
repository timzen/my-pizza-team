---
title: Nightly test run
parentKind: schedule
parentId: nightly-test-run
directory: __DEMO_PROJECT__
---
## Goal

Run the todo API's test suite and report the result. If anything fails, capture
the failing output so a human can triage it in the morning.

## Acceptance Criteria

- The test command MUST be run from the project directory.
- A pass/fail summary MUST be posted as a completion comment on this work.
- On failure, the relevant test output MUST be included in the summary.

## Additional Context

This is scheduled work: its Schedule parent (`nightly-test-run`) enqueues a fresh
run every night at 2am (cron `0 2 * * *`). You can also trigger a run now from
the Schedule page.

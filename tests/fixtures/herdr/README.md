# herdr response fixtures

Real JSON responses from herdr 0.9.5, one file per call, recorded by
`tests/e2e/herdr-contract.test.ts` against an isolated server (see docs/herdr.md).
That test also checks the live responses still have every field recorded here, with
the same JSON type, so these stay true to the installed herdr. Unit tests of the herdr
backend can feed them to a fake exec.

Re-record (overwrites every file):

    MPT_HERDR_RECORD=1 node --test tests/e2e/herdr-contract.test.ts

Scrubbed on recording: the sandbox's temp dir → `/tmp/herdr-sandbox`, its session
name → `mpt-sandbox`, the herdr binary path → `/usr/local/bin/herdr`, pids → `4242`.
Tab/pane/terminal ids are herdr's own and differ between runs.

Error fixtures (`error-*.json`) are what herdr prints on **stderr** with exit status 1
(stdout is empty); every other file is stdout of a successful call.

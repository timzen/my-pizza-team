# TODO

Code issues found while reconciling the docs with the source (docs consolidation,
v0.20.0). Each item names a symbol rather than a line number. Delete an item when it's
fixed.

## Dead code and leftovers

- `mpt --help`'s **Commands** list omits `setup`, `doctor`, and `lead` (they appear
  only under Examples) and its Environment section omits `HOST`.

## Deferred: a second harness (Kiro, Tier 0/1)

Designed, not built. Verified with kiro-cli 2.11.1: `kiro-cli chat --no-interactive
"<prompt>"` runs one task and exits; `--trust-all-tools` suppresses permission
prompts; it executes shell commands. Proposed shape:

1. `mpt work complete <id>`, `mpt work fail <id> "<why>"`, `mpt work comment <id>
   "<text>"` over the existing agent routes, with `MPT_AGENT_ID` / `MPT_DAEMON_URL`
   set in the spawned command's environment — a reporting channel for *any*
   shell-capable agent.
2. Tier 0 teammates registered by the daemon at spawn (`harness: "kiro"`), with "its
   tmux window exists" standing in for heartbeats.
3. A daemon-side loop per idle Tier 0 teammate: claim (same affinity matching),
   render prompt + `mpt work` instructions, run a per-task `task` template
   (`{prompt}` shell-quoted) plus a `tier: 0` marker; if the process exits with the
   item still IN_PROGRESS, mark it FAILED ("exited without reporting").
4. `DEFAULT_HARNESS_TEMPLATES.kiro` (no `leader`), a `doctor` check for `kiro-cli`, and
   README notes on what it gives up (no live transcript, usage ledger, pairing, or
   leading).

Open: one-shot per task (recommended) vs a persistent session nudged with
`send-keys`; e2e uses a stand-in script, real Kiro by hand only.

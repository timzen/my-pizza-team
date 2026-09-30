# TODO

Known code issues and deferred work. Each item names a symbol rather than a line
number. Delete an item when it's done.

## Bugs

- **Deregistering a member orphans its in-flight WorkItem** (`Store.removeMember`):
  `member_id` is set to NULL but the item stays `IN_PROGRESS`, and the reaper only walks
  members, so it is never reaped to MORIBUND. A Pi teammate deregisters on shutdown even
  mid-item. (`mpt agent` fails its item before deregistering, so it avoids this.) Fix:
  move the member's in-flight items to MORIBUND in `removeMember`.

## Auto Triage — stage 1 built; proposals and UI to go

**Built** (docs/DESIGN.md "Auto Triage: a Note Is a Parent", docs/ARCHITECTURE.md
"Thoughts"): the `thought` parent kind and derived type **Triage**, lazy
`triage-<noteId>` containers, the turn rule (`daemon/triage.ts`), the hourly sweep
and `triage` config, `triage.md` + `buildTriagePrompt`, **Triage now**
(`POST /api/thoughts/:id/triage`), note-lifecycle cascade, and the guards that keep
the generic WorkDef verbs off a triage container. Tests: tests/triage.test.ts. The
teammate replies with a plain comment; the run lands in the Inbox like any other.

**Stage 2 — proposals.** Structured analysis, so accepting creates real work without
parsing prose, and decisions recorded without a second file.

- **`propose_work` tool** (teammate-only, valid only while holding a triage item),
  which validates what it's given (the story exists, the cron parses, an `outcome`
  of `proposals` carries at least one) and returns fixable errors.
- **Every analysis has an `outcome`:** `proposals` | `nothing` ("reference note,
  nothing to do") | `question` (it needs one thing from you first).
- **Proposal kinds:** `task` (Solitary WorkDef), `story-task` (into an existing
  story), `story` (new story with tasks), `schedule` (cron WorkDef).
- **Storage:** the analysis is a comment in the triage WorkDef's
  `comments.jsonl` carrying `outcome` + `proposals`; your decisions are **appended**
  to the same file as `kind: "decision"` lines (not comments, not turns), so state
  is a fold over one append-only file and it doubles as the history:

```jsonl
{"from":"swift-neo","at":"…","body":"This note is really two things: …","outcome":"proposals","proposals":[
  {"id":"p1","kind":"task","title":"…","goal":"…","acceptanceCriteria":["MUST …"],"directory":"…"},
  {"id":"p2","kind":"story-task","storyId":"payments","title":"…","goal":"…"}]}
{"from":"you","at":"…","kind":"decision","proposalId":"p1","action":"accepted","workDefId":"td-4821"}
{"from":"you","at":"…","kind":"decision","proposalId":"p2","action":"rejected"}
```

- **Accept creates only** — never enqueues or runs. **Reject** is one click, no
  reason; to steer the next analysis, edit the note.
- **Both directions link:** the decision names what it created; that WorkDef's
  frontmatter gets `origin: {thought, proposal}`.
- **The next run sees the decisions** (the prompt already includes earlier
  analyses — add what happened to each), so a rejected idea isn't re-proposed.
- `Comment` gains three optional fields: `outcome`, `proposals`, `kind`.

**Stage 3 — UI.**

- **The note stays clean.** Its view gains nothing; the only addition is a small
  **state badge** on the card and list row — shape, not color, like teammate status
  — showing the *latest analysis's outcome*, not a count:

| Latest analysis | Badge |
|---|---|
| proposals, at least one pending | **proposal** (e.g. a lightbulb) |
| proposals, all decided | none — dealt with |
| nothing to do | **nothing** (e.g. a dash) |
| a question for you | **question** — answer it by editing the note |
| never triaged, or first run queued | none |

- **The triage page**, `/thoughts/:id/triage` (a page, per "Pages over Modals"): the
  note read-only on the left with an **Edit note** link, the latest analysis on the
  right with **Accept / Edit / Reject** per proposal, earlier analyses and decisions
  below, and **Triage now**. **Edit** is the "make it more detailed work" path: the
  normal New Task / New Story / schedule form, pre-filled, whose save records the
  acceptance.
- **The Inbox row** is the notification — every terminal run is there whatever its
  outcome. `lib/work-item-link.ts` needs a `thought` parent case (→ the triage page);
  today those rows point at the WorkDef page, which shows the thread but is a
  container. The row should show the outcome.
- **Config + `triage.md` editor** (like `workflow/PersonaEditor`). Note:
  `intervalMinutes` only re-arms the timer on daemon restart.
- No cross-note list of pending proposals for now; if it's wanted, it's probably an
  Inbox feature rather than a third Thoughts view.

### Decisions (2026-09-29)

1. **On by default** (`triage.enabled: true`). With no cap, the first sweep after
   upgrading triages every non-archived, non-empty note — accepted.
2. **No cap per sweep** for now.
3. **A failed run counts as analyzed** (the version is stamped at enqueue), so a note
   that breaks triage doesn't cost a run every hour. **Triage now** retries it.
4. **Prompt context:** the note, its **group name** (light context, like a label),
   earlier analyses, and the open stories (so it can propose `story-task`). Not the
   other notes in the group.
5. **The note's own view stays clean;** everything triage lives on its own page,
   reached by the badge — or from the Inbox row, which is the actual notification.
   Every terminal triage run appears in the Inbox whatever its outcome: work done is
   never hidden.
6. **The badge is the outcome** (proposal / nothing / question), not a count.
7. **Only the agent comments** on a triage thread; you answer by editing the note.

## Other harnesses (Kiro, Claude Code) over ACP — experimental

**Built** (behind `experimental.harnesses`): `mpt agent` (agent/), `mpt setup --harness`,
the registration and spawn gates, the Spawn dialog's harness choice, doctor checks, and
tests/e2e/agent.test.ts against a fake ACP agent. Exercised by hand with real Kiro 2.11.1
and Claude Code (adapter 0.81.2): each completed a small job end to end.

**Still to do:**
- **Pairing** from the web UI: poll `/api/agents/:id/pairing`; queue = next prompt,
  steer = Claude's prompt queueing or cancel-and-reprompt for Kiro; forward
  `request_permission` to the web UI while paired. The UI disables Pair for them and the
  daemon refuses it until then.
- **Leading** (the chat mirror over ACP; typing in the tmux window has no path in yet).
- **Graduating** a harness out of the flag once it has been used for real work.

Background: both agents speak the **Agent Client Protocol** (JSON-RPC 2.0 over stdio,
one object per line). The design as built is in docs/DESIGN.md "Harness Tiers, and Why
Not MCP" and docs/ARCHITECTURE.md "agent/"; what the spike verified, and the
decisions, are kept below for reference.

### Verified (spike, 2026-09-27; about $1 of Claude and 5.6 Kiro credits)

Driven with a throwaway ACP client (no SDK) in a scratch project, answering
permission requests as the client.

| | Kiro (`kiro-cli acp`, 2.11.1, native) | Claude Code (`@agentclientprotocol/claude-agent-acp` 0.81.2) |
|---|---|---|
| Runs a prompt; tool calls stream as `tool_call` / `tool_call_update`; ends `end_turn` | ✓ | ✓ |
| `session/request_permission` sent to the client | ✓ (`-a` suppresses it) | ✓ unless the mode allows it; modes: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` via `session/set_mode` |
| `session/load` in a **new process** keeps context | ✓ (replays history as updates) | ✓ |
| `session/cancel` → `stopReason: "cancelled"` promptly | ✓ | ✓ |
| Second `session/prompt` mid-run | ✗ error `Prompt already in progress` | ✓ queued into the run (`promptQueueing: true`); reply covered both |
| Usage / cost | `_kiro.dev/metadata`: `meteringUsage` in **credits** per turn, `contextUsagePercentage` | `session/prompt` result `usage` (input/output/**cache read/write**) + `usage_update` with `cost` in **USD** |
| Uses your installed `claude` (auth, Bedrock) | — | ✓ via `CLAUDE_CODE_EXECUTABLE` |

Gotchas found:
- `@zed-industries/claude-code-acp` is **deprecated** (renamed); it reports no usage. Use
  `@agentclientprotocol/claude-agent-acp`.
- The Claude adapter honors the user's `~/.claude/settings.json`. With
  `permissions.defaultMode: "auto"` it wrote "**Auto mode unavailable** … using Accept
  edits instead." *into the agent's reply text* — it would end up in a completion
  summary. Set the mode explicitly (`session/set_mode`) right after `session/new`.
- Kiro sends extension methods (`_kiro.dev/metadata`, `_kiro.dev/session/update`,
  `…/commands/available`, `…/mcp/server_initialized`); a client must ignore unknown
  notifications and answer unknown requests with "method not found".

### Decisions (2026-09-27)

1. **No credits in the usage ledger.** Nobody knows what a credit is worth. Kiro runs
   record what they can in tokens, or nothing.
2. **Harness choice is per spawn for now** (Spawn dialog; `defaultHarness` for the
   pool), and **non-Pi harnesses sit behind an experimental flag** in team config until
   they're better vetted.
3. **`mpt setup` installs the Claude adapter** (pinned), rather than relying on `npx`.
4. **A fake ACP agent drives the e2e tests**; real agents are exercised by hand.

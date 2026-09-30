# TODO

Known code issues and deferred work. Each item names a symbol rather than a line
number. Delete an item when it's done.

## Bugs

- **Deregistering a member orphans its in-flight WorkItem** (`Store.removeMember`):
  `member_id` is set to NULL but the item stays `IN_PROGRESS`, and the reaper only walks
  members, so it is never reaped to MORIBUND. A Pi teammate deregisters on shutdown even
  mid-item. (`mpt agent` fails its item before deregistering, so it avoids this.) Fix:
  move the member's in-flight items to MORIBUND in `removeMember`.

## Auto Triage — designed, not built

A teammate reads each note you've changed and replies with an analysis that leans
toward **proposed work** — tasks, stories, schedules — which you accept, edit, or
reject. Designed 2026-09-29; nothing below exists yet. As each stage lands, move its
part into docs/DESIGN.md (a "Thoughts" subsection plus a row in "WorkDefs &
Parents") and delete it here.

### The model: a note is a WorkDef parent

A note gets a **triage WorkDef**, created lazily the first time it's eligible. Its
parent is the note — a fourth parent kind (`WorkDefParent.kind: "thought"`), whose
derived type is **Triage**:

| Parent | Type | Emits a WorkItem when |
|---|---|---|
| a Thought | Triage | the triage sweep finds its text changed since the last analysis |

So the thread (`comments.jsonl`), attachments, usage rollups, and the Inbox entry all
come from the existing WorkDef machinery; nothing new stores comments.

- **The WorkDef is a container, not authored work.** Its `workdef.md` is just a title
  and the parent — no goal. The **instructions live once**, in `triage.md` in the team
  dir (edited in the UI like a workflow persona), and the daemon builds the prompt at
  claim time from those instructions plus the note's *current* text. Copying the note
  into `workdef.md` would make the daemon rewrite it on every edit, breaking "workdef.md
  is authored content only." The WorkItem's title is set at enqueue as
  "Triage: <note's first line>", so the queue and Inbox read well.
- **It follows the note.** Archiving a note archives its triage WorkDef; deleting it
  deletes it. Triage WorkDefs never appear on Tasks or Schedule.
- **Runtime state lives on the parent**, as `lastEnqueuedAt` does on a Schedule: the
  note's frontmatter records the version (its `updatedAt`) last sent to triage. That
  doesn't touch the note's `updatedAt`, which changes only when its text does.

### Turns: only editing the note's text is your turn

The teammate is the only one who comments on a triage WorkDef (the Thread tab has no
comment box for it). You answer by **editing the note** — including answering a
question the teammate asked. Moving, recoloring, pinning, grouping, and
accepting/rejecting proposals are not turns.

A note is **eligible** when it is not archived, not empty, has no triage WorkItem
READY or IN_PROGRESS, and its `updatedAt` is newer than the version last sent to
triage. Comparing against the *version analyzed*, not the time of the teammate's
comment, is deliberate: an edit made while a run is in flight lands before that run's
comment, and a time comparison would wrongly count it as answered.

### The sweep

A daemon timer beside the scheduler, not a Schedule (a Schedule enqueues one WorkDef;
the sweep enqueues many). Every `triage.intervalMinutes` (default 60) it enqueues a
WorkItem for each eligible note, skipping notes edited in the last
`triage.quietMinutes` (default 10) so it never catches you mid-sentence — they go next
sweep. A **Triage now** button on a note skips the wait (and the quiet period).

- **Where it runs:** in the leader's directory (the WorkItem's `directory` is set from
  the leader's member row at enqueue; with no leader registered it has none, so any
  teammate may take it). **No special priority** — the queue is oldest-first within
  directory tiers (`Store.getNextWorkItem`), and triage takes its turn like any item.
- **All non-archived, non-empty notes are eligible**, so the first sweep after it's
  enabled triages every note. Accepted (Decisions 1–2).

### Proposals: structured comments, decisions appended

The analysis *is* a comment in the triage WorkDef's `comments.jsonl`, carrying a
structured `proposals` array so that accepting creates real work without parsing
prose. Your decisions are **appended** to the same file as `kind: "decision"` lines —
not comments, not turns — so the file stays append-only and doubles as the history:

```jsonl
{"from":"swift-neo","at":"…","body":"This note is really two things: …","outcome":"proposals","proposals":[
  {"id":"p1","kind":"task","title":"…","goal":"…","acceptanceCriteria":["MUST …"],"directory":"…"},
  {"id":"p2","kind":"story-task","storyId":"payments","title":"…","goal":"…"}]}
{"from":"you","at":"…","kind":"decision","proposalId":"p1","action":"accepted","workDefId":"td-4821"}
{"from":"you","at":"…","kind":"decision","proposalId":"p2","action":"rejected"}
```

- **Every analysis has an `outcome`:** `proposals`, `nothing` ("reference note,
  nothing to do"), or `question` (it needs something from you first). The badge is
  that outcome. `proposals` requires at least one proposal; the other two carry none.
- **Kinds:** `task` (a Solitary WorkDef), `story-task` (a task in an existing story),
  `story` (a new story with tasks), `schedule` (a cron WorkDef).
- **State is a fold** over the file: a proposal is pending until a decision names it.
- **Accept creates only** — it never enqueues or runs anything. **Edit** opens the
  normal create form pre-filled; saving it records an `accepted` decision with the
  resulting id. **Reject** is one click, no reason; to steer the next analysis, edit
  the note.
- **Both directions are linked:** the decision names the WorkDef it created, and that
  WorkDef's frontmatter gets `origin: {thought, proposal}` (structural metadata).
- **The next run sees the history:** the prompt includes earlier proposals and what
  happened to them, so a rejected idea isn't proposed again.
- **Posted through a tool**, `propose_work` (teammate-only, valid only while holding a
  triage WorkItem), which validates the outcome and each proposal (the story exists,
  the cron parses, …) and returns errors the agent can fix. The `Comment` type gains
  three optional fields, `outcome`, `proposals`, and `kind`; existing comments are
  untouched.

### Where you see it

Notes are for tossing out and reorganizing ideas; triage is for the moment you're
ready to promote one to work. So they don't share a screen:

- **The note stays clean.** Its view gains nothing — no analysis, no buttons. The only
  addition is a small **state badge** on the card and list row (below).
- **The badge opens the triage page**, `/thoughts/:id/triage` (a page, per "Pages over
  Modals"): the note read-only on the left, with an **Edit note** link back (editing is
  still your turn); the latest analysis on the right, each proposal a card with
  **Accept / Edit / Reject**; earlier analyses and their decisions below; and
  **Triage now**. **Edit** is the "make it more detailed work" path: the normal New
  Task / New Story / schedule form, pre-filled, whose save records the acceptance.
- **In the Inbox, always.** Every terminal WorkItem belongs there however it ended —
  proposals, nothing, a question, or a failure. It's finished work, and the Inbox is
  how you know there's something to engage with; hiding a run because it "wasn't
  asked for" would hide work done. Its Inbox row links to the **triage page**, not the
  WorkDef page, and says what the outcome was.

**The badge is the latest analysis's outcome, not a count** — shape, not color, like
teammate status (DESIGN "Teammate Status: Shape, not Color"), with a tooltip in words:

| Latest analysis | Badge |
|---|---|
| proposals, at least one still pending | **proposal** (e.g. a lightbulb) |
| proposals, all accepted or rejected | none — it's been dealt with |
| nothing to do | **nothing** (e.g. a dash) |
| a question for you | **question** (e.g. a question mark) — answer it by editing the note |
| never triaged, or first run still queued | none |

The badge reflects the latest analysis until a new one replaces it, even after you've
edited the note (the next sweep will re-triage it). The badge is a shortcut, not the
only way in: the Inbox row is the notification.

### Stages

1. **Parent + sweep + prompt:** `WorkDefParent.kind: "thought"`, lazy creation,
   lifecycle with the note, eligibility (a FAILED run counts as analyzed), the timer
   and config (`triage.enabled` default true, `intervalMinutes`, `quietMinutes`), `triage.md`, the prompt, Triage now. The
   teammate replies with a plain comment.
2. **Proposals:** the `propose_work` tool and validation, the comment fields, decision
   lines, the fold, accept/edit/reject routes, `origin` frontmatter.
3. **UI:** the state badge on cards and list rows, the triage page
   (`/thoughts/:id/triage`) with Accept / Edit / Reject and Triage now, the `triage.md`
   editor, Config, and the Inbox row: `lib/work-item-link.ts` gains a `thought`
   parent case (→ `/thoughts/:id/triage`), and the row shows the outcome.

### Decisions (2026-09-29)

1. **On by default** (`triage.enabled: true`). With no cap, the first sweep after
   upgrading triages every non-archived, non-empty note — accepted.
2. **No cap per sweep** for now.
3. **A failed run counts as analyzed:** its note version is recorded like a completed
   one, so a note that breaks triage doesn't cost a run every hour. **Triage now**
   retries it.
4. **Prompt context:** the note, its **group name** (light context, like a label),
   its earlier proposals and their decisions, and the story list (ids and titles, so
   it can propose `story-task`). Not the other notes in the group.
5. **The note's own view stays clean;** everything triage lives on its own page,
   reached by the badge — or from the Inbox row, which is the actual notification.
   Every terminal triage run appears in the Inbox whatever its outcome: work done is
   never hidden.
6. **The badge is the outcome** (proposal / nothing / question), not a count.
7. **No cross-note list of pending proposals** for now. If it's wanted later, it's
   probably an Inbox feature, not a third Thoughts view.

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

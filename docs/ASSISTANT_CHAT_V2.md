# Assistant Chat v2 — Plan (redline me)

Status: **implemented**. Spans `my-pizza-team` (daemon + web UI) and
`pi-pizza-team` (extension). Supersedes the old "Assistant chat model (turns, not
message pairs)" section of `docs/DESIGN.md`, now rewritten as "Assistant chat
model (a mirror of the Pi session)".

**Deltas from the plan** (decided during implementation):

- **Reasoning offset is per message, not per run.** `message_update` snapshots are
  cumulative *per assistant message*; a run with tool calls emits several, each
  restarting at zero. A per-run high-water mark therefore dropped all reasoning
  after the first tool call. Reset happens on the `message_end` boundary, before
  the "has text" guard — messages that are only thinking + tool calls are exactly
  the ones whose reasoning matters.
- **The peek outlives the run.** The `…` is replaced by a small "thoughts" chip
  once the agent settles, because rendering the affordance only while `thinking`
  made the feature a race against the reply arriving. The panel also fetches
  `GET /api/assistant/thoughts` on open: SSE only carries chunks emitted while
  *that tab* was listening, so after a reload the daemon holds the buffer and the
  panel would otherwise look empty.
- **§3.4 thought expiry** — no 60s grace timer. The peek buffer is simply cleared
  when the *next* run starts, which gives the same "read it after the reply lands"
  behavior with no timer to reason about.
- **§4.3 self-directives** — `new-session`/`resume-session` needed a channel the
  leader doesn't consume: `GET/PUT /api/agents/:id/directives`, with
  `SELF_HANDLED_ACTIONS` filtered *out* of `getLeaderDirectives()`. Without the
  filter the leader marks them done and the agent never sees them.
- **§11.1 soft cap** — dropped as too clever. Splitting is blank lines only (+
  fence/list protection and runt merging). One extra rule earned its place: a short
  paragraph ending in `?` is never merged, because the question is the bubble the
  user replies to.
- **§5.5 session directives** — realized through two registered commands
  (`/ppt-assistant-new-session`, `/ppt-assistant-resume <file>`) that the loop
  queues as user messages, because `newSession()`/`switchSession()` exist only on
  **command** contexts — the same constraint behind the teammate's
  `/ppt-fresh-session`. Calling them from the `session_start` ctx silently no-ops.
- **§11.4 two writers** — accepted as designed: the daemon reflects Pi's accepted
  order.
- **Session ids** carry millisecond precision. Ending and starting a session happen
  in the same tick (new chat, persona swap), and second precision collided on the
  primary key.
- **There is no assistant process.** The dedicated assistant role was retired
  after the fact: the **leader** answers the chat (DESIGN.md "One Agent to Talk
  To"). Its session holds no human work, so every assumption in this document
  still holds — but §5's "the extension's assistant role" is now the leader's chat
  mirror (`pi-pizza-team/src/chat.ts`), the inbox is gated on a daemon-designated
  chat agent, and `queue_request` + the spawn button + the `pi-assistant` template
  are gone.
- **The chat is a dock, not a page.** Shipped as `/assistant` → redirect + left
  dock (collapsible, resizable, floating below `lg`), with quick-create moved in
  beside it. The stream had to move up into the dock so collapsing doesn't drop
  the SSE connection, which is also what makes the unread badge possible.
- **Deprecated config** (`assistantTurnTimeoutSeconds`,
  `assistantTurnDebounceSeconds`) is accepted-and-ignored, and removed from
  `DEFAULT_CONFIG`.
- **`turn_id`/`status` columns** are retained (unused) for one release, per §10;
  `assistant_turns` is dropped outright on first boot.

Test coverage: `my-pizza-team/tests/assistant.test.ts` (17 cases incl. the v1→v2
migration and an SSE frame assertion), `pi-pizza-team/tests/bubbles.test.mjs` (13
behavioral cases), `pi-pizza-team/tests/assistant.test.mjs` (22 source checks).

---

## 1. Goal

Make the assistant feel like a **real chatbot / CLI conversation**, not a
request/response form:

| Want | v1 today | v2 |
| --- | --- | --- |
| Send messages at will | Composer **locks** while a turn runs | Never locks |
| Bubbles L/R | ✅ | ✅ (kept, restyled) |
| Read receipts | ✓/✓✓ driven by turn *claim* | 3 real states: queued → delivered → read |
| `…` while thinking | ✅ (2s poll) | ✅ (SSE, sub-second) |
| Peek at the agent's thoughts | ✗ | Click the `…` → live reasoning stream |
| Reasonably sized replies | Forced via `send_message` tool calls | Natural prose, split into bubbles |
| Pretty markdown | ✅ | ✅ (kept) |
| Expand a bubble fullscreen | ✗ | ✅ |
| Reply to a specific bubble | ✗ | ✅ (quote + reply) |
| Personas | ✅ (but wipes transcript) | ✅ (non-destructive; ends a session) |
| Session snapshots | ✗ (clear = permanent loss) | Markdown under `<teamDir>/assistant/sessions/` |
| Resume a session | ✗ | ✅ (`ctx.switchSession`) |
| tmux chatting shows up in the web UI | ✗ | ✅ (bidirectional mirror) |

## 2. The one architectural inversion

> **The Pi session is the conversation. The daemon is a mirror of it.**

v1 treats the daemon as the source of truth and the Pi session as a worker that
gets fed prompts. That is exactly why tmux and the web UI can't see each other,
and why the composer has to lock.

v2 flips it:

```
Web UI  ──POST /api/assistant/messages──►  daemon  ──pull + ack──►  extension
                                                                       │
                                                    pi.sendUserMessage(deliverAs)
                                                                       ▼
                                                                   Pi agent
                                                                       │
        ◄──── SSE /api/assistant/stream ────  daemon  ◄── mirror ──────┘
                                                        input / message_update /
                                                        message_end / tool_execution_*
```

Consequences that fall out for free:

- **Interleaving is Pi's problem, not ours.** `deliverAs: "steer" | "followUp"`
  already implements "user talked mid-stream" correctly. Delete the daemon's
  turn machine, the pre-claim debounce, and `POST /api/assistant/typing`.
- **tmux parity.** A message typed in the tmux pane fires `input` with
  `source: "interactive"` → mirrored into the chat as a user bubble.
- **Prose, not tool calls.** Remove the `send_message` tool; mirror the agent's
  own assistant text. The TUI transcript and the web chat become the same
  conversation rendered two ways.

### 2.1 Decision log

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Delete `assistant_turns` + claim/complete/typing/reaper | The turn machine fights the chatbot model |
| D2 | Delete the `send_message` tool; mirror assistant text, split on blank lines | Tool-call replies break tmux parity and stilt the model |
| D3 | Thoughts are **ephemeral** (in-memory, capped, per session) | Peek-only feature; not worth DB bloat or snapshot noise |
| D4 | SSE (`GET /api/assistant/stream`) | Thoughts + progressive bubbles need sub-second push; auth is not a real constraint |
| D5 | Nothing is ever destroyed — "new chat" ends a session, it does not delete messages | Snapshots + resume depend on it |
| D6 | Session control moves from tmux keystrokes to real Pi APIs (`ctx.newSession`, `ctx.switchSession`) | Documented API; `/new`-as-keystrokes can't express "resume this path" |

## 3. Data model (daemon)

### 3.1 New: `assistant_sessions`

```sql
CREATE TABLE assistant_sessions (
  id             TEXT PRIMARY KEY,   -- e.g. "2025-06-14T10-22-03-pizzaiolo"
  persona_id     TEXT,               -- context entry id, or NULL for default
  persona_title  TEXT,               -- denormalized for listing after deletes
  title          TEXT,               -- derived from the first user message
  pi_session_path TEXT,              -- absolute path to the Pi .jsonl (for resume)
  status         TEXT NOT NULL,      -- 'active' | 'ended'
  snapshot_path  TEXT,               -- <teamDir>/assistant/sessions/<id>.md
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  message_count  INTEGER DEFAULT 0
);
```

Invariant: **at most one** `status = 'active'` row. The extension reports
`pi_session_path` on register and on every `session_start`.

### 3.2 Changed: `assistant_messages`

```sql
-- added
session_id  TEXT NOT NULL,      -- FK -> assistant_sessions.id
origin      TEXT NOT NULL,      -- 'web' | 'tui' | 'agent' | 'system'
delivery    TEXT,               -- user rows only: 'queued'|'delivered'|'read'
reply_to    TEXT,               -- message id this quotes (nullable)
-- dropped
turn_id     -- (column retained but unused during migration, then dropped)
status      -- replaced by `delivery` (user) / 'ok'|'failed' (assistant)
```

`role` stays `'user' | 'assistant'`; add `'system'` for session markers
("Persona changed to Pizzaiolo", "Resumed from session X") rendered as centered
pills, not bubbles.

### 3.3 Dropped entirely

- table `assistant_turns`
- `Store.getNextAssistantItem` / `claimAssistantItem` / `appendAssistantMessage(turnId,…)` /
  `completeAssistantItem` / `reapStuckAssistantTurns` / `recordAssistantTyping`
- the `reapStuckAssistantTurns()` call in the 30s heartbeat sweep (`store.ts:1574`)
- config keys `assistantTurnTimeoutSeconds`, `assistantTurnDebounceSeconds`
  (`shared/types.ts:25-28`, defaults at `:347-348`) — leave them accepted-and-ignored
  for one release so existing `config.json` files don't fail validation

### 3.4 Ephemeral thoughts (D3)

In-memory only, on the `Store` instance:

```ts
/** Live reasoning peek — ring buffer per session, dropped on restart. */
private thoughtBuffer: { sessionId: string; chunks: string[]; updatedAt: number } | null;
```

Cap: 200 chunks / ~64 KB, whichever first (drop oldest). Cleared when the agent
goes idle *plus* a grace window (~60s) so you can still peek at what it was just
thinking about after the reply lands.

## 4. HTTP API (daemon)

### 4.1 Removed

```
POST   /api/assistant/typing
GET    /api/assistant/next
POST   /api/assistant/messages/:id/claim
POST   /api/assistant/messages/:id/say
POST   /api/assistant/messages/:id/complete
DELETE /api/assistant/messages          (clear-all — replaced by session end)
```

### 4.2 Kept / changed

```
GET    /api/assistant/messages?sessionId=      → { session, messages[], agent }
                                                  (defaults to the active session)
POST   /api/assistant/messages                 → { content, replyTo?, origin? }
                                                  ALWAYS 201. Creates the active
                                                  session on demand. delivery='queued'.
DELETE /api/assistant/messages/:id             → unchanged
GET    /api/assistant/persona                  → unchanged
PUT    /api/assistant/persona                  → NO LONGER clears the transcript;
                                                  ends the active session (snapshot)
                                                  and starts a new one
```

### 4.3 New — agent-facing

```
GET  /api/assistant/inbox                      → { messages: [{id, content, replyTo, quoted}] }
                                                  undelivered user messages, oldest first
POST /api/assistant/inbox/ack                  → { ids[], state: 'delivered'|'read' }
POST /api/assistant/bubbles                    → { content, kind: 'text'|'tool', final? }
                                                  mirror one assistant bubble
POST /api/assistant/thoughts                   → { chunk } | { clear: true }
POST /api/assistant/session                    → { piSessionPath, personaId? }
                                                  extension reports its live Pi session
```

### 4.4 New — session management

```
GET    /api/assistant/sessions                 → { sessions: [...] }  (newest first)
POST   /api/assistant/sessions/new             → snapshot + end active, open a new one,
                                                  emit a `new-session` leader directive
POST   /api/assistant/sessions/:id/resume      → emit a `resume-session` directive
                                                  carrying piSessionPath; reopen as active
GET    /api/assistant/sessions/:id/snapshot    → markdown text
```

### 4.5 New — stream

```
GET /api/assistant/stream                      → text/event-stream
```

Events: `message` (new/updated bubble), `delivery` (receipt change), `thinking`
(`{ active, chunk? }`), `session` (session switched/ended), `agent`
(online/offline). Heartbeat comment every 15s. The UI keeps a slow (10s) poll of
`/api/assistant/messages` purely as a reconciliation safety net.

## 5. Extension (`pi-pizza-team`)

`src/assistant.ts` becomes event-driven; the 5s poll loop, claim/complete, and
`currentItem` bookkeeping all go away.

### 5.1 Inbound pump (daemon → agent)

Short-poll `/api/assistant/inbox` (1s while idle is fine — or piggyback on the
SSE stream later). For each batch:

1. Build the prompt. If `replyTo` is set, prefix the quoted text as
   `> …` so the agent sees what you're answering.
2. `pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? undefined : "steer" })`
   — `steer` so mid-stream messages land after the current tool batch rather
   than being lost or queued behind everything.
3. `POST /api/assistant/inbox/ack { ids, state: "delivered" }` immediately.
4. On the next `agent_start`, ack `read` for everything currently `delivered`.

### 5.2 Outbound mirror (agent → daemon)

| Pi event | Action |
| --- | --- |
| `input` where `source === "interactive"` | POST as a user message, `origin: 'tui'`, already `read` — **this is tmux parity** |
| `agent_start` | ack `read`; `POST /thoughts { clear: true }`; stream `thinking: true` |
| `message_update` | extract reasoning delta → `POST /api/assistant/thoughts { chunk }` (throttled ~250ms, coalesced) |
| `message_end` (assistant) | split `text` parts on `\n\s*\n` → one `POST /api/assistant/bubbles` per chunk |
| `tool_execution_start` | optional `kind: 'tool'` bubble ("Reading the board…") — feature-flagged, off by default |
| `agent_settled` | stream `thinking: false` |
| `session_start` | `POST /api/assistant/session { piSessionPath }` |

Bubble splitting rule: split on blank lines, but **never split inside a fenced
code block or a list**. Merge any chunk under ~40 chars into its neighbour so
you don't get orphan one-word bubbles.

### 5.3 Prompt changes

`ASSISTANT_CHAT_FRAMING` (`daemon/routes/assistant.ts:38`) shrinks from ~30
lines to roughly:

```
# You are in a live chat
You're talking with the user in a real-time chat (like iMessage). Reply the way a
thoughtful person texts: short, direct, a few sentences at a time.

- Separate distinct points with a blank line — each becomes its own bubble.
- Put any question to the user in its own final paragraph.
- The user can message you at any time, including while you're working. If a new
  message arrives mid-task, address it before continuing.
```

`DEFAULT_ASSISTANT_PERSONA` is unchanged. `composeSystemPrompt()` is unchanged.

### 5.4 Tools

- **Removed:** `send_message` (`src/tools.ts:151-190`) and its
  `getActiveTurnId` plumbing in `registerAssistantTools` + `index.ts:462`.
- **Removed:** `client.sayAssistantMessage`, `claimQueueItem`,
  `completeQueueItem`, `getNextQueueItem` (`src/client.ts`).
- **Added:** `client.getInbox`, `ackInbox`, `postBubble`, `postThought`,
  `reportSession`.
- Unchanged: every other assistant tool (stories, tasks, thoughts, context…).

### 5.5 Leader directives

`src/leader.ts:521` currently maps intent → tmux keystrokes
(`"reset-session": "/new"`). New actions are handled **in the assistant's own
extension instance** (it polls its directives like any other member) using real
APIs:

| Directive | Handling |
| --- | --- |
| `new-session` | `ctx.newSession({ parentSession })`, then report the new path |
| `resume-session` | `ctx.switchSession(params.piSessionPath)`, then report |

`reset-session` stays for teammates (the keystroke path is fine there).

## 6. Sessions, snapshots, resume

### 6.1 Snapshot format

`<teamDir>/assistant/sessions/<id>.md`, matching the frontmatter convention used
by `context/` and `thoughts/` (`shared/frontmatter.ts`):

```markdown
---
id: 2025-06-14T10-22-03-pizzaiolo
persona: pizzaiolo
personaTitle: Pizzaiolo
piSession: /Users/tim/.pi/sessions/…/abc123.jsonl
startedAt: 2025-06-14T10:22:03Z
endedAt: 2025-06-14T11:04:55Z
messages: 42
---

# Chat — "why is story auth-refresh blocked?"

**You** · 10:22
why is story auth-refresh blocked?

**Pizzaiolo** · 10:22
Two of its tasks are waiting on review.

…
```

Written on session end (persona swap, new chat, daemon shutdown) and
opportunistically refreshed every ~5 min while active, so a crash doesn't lose
the transcript. Thoughts are **not** included (D3).

### 6.2 Lifecycle

```
new chat / persona swap
  → snapshot active session → status='ended'
  → insert new session (status='active')
  → leader directive `new-session` → ctx.newSession()
  → extension reports piSessionPath
  → system pill: "New chat as Pizzaiolo"

resume
  → snapshot + end active session
  → target session status='active'
  → directive `resume-session` { piSessionPath } → ctx.switchSession()
  → system pill: "Resumed 'why is story auth-refresh blocked?'"
```

If the Pi session file is gone, resume degrades gracefully: reopen the session
read-only in the UI with a banner ("context unavailable — sending a message
starts a fresh session seeded with this transcript").

## 7. Web UI

`ui/src/pages/AssistantPage.tsx` (315 lines, does everything) splits into the
component set below. **Update:** the page itself is gone — the chat became the
left `AssistantDock`, available from every route (see DESIGN.md "The Shell Reads
Left to Right"), and `/assistant` is a redirect that opens the dock.

```
ui/src/components/assistant/
  AssistantDock.tsx      — presentation (dock / rail / floating), stream owner, unread, resize
  AssistantChat.tsx      — the conversation body (presentational; dock owns the stream)
  AssistantDockProvider.tsx — open state, so /assistant can open the dock as it redirects
  MessageBubble.tsx      — bubble + hover actions (expand, reply, copy, delete)
  BubbleDialog.tsx       — fullscreen markdown view of one bubble
  ThinkingBubble.tsx     — the `…`; click → ThoughtsPanel
  ThoughtsPanel.tsx      — live reasoning stream (mono, auto-scroll, dimmed)
  Composer.tsx           — never locks; quoted-reply chip; Esc aborts the agent
  QuotedMessage.tsx      — the `>` quote rendered inside a bubble and in the composer
  SessionMenu.tsx        — session list, resume, new chat, snapshot link
  PersonaChips.tsx       — extracted as-is from today's SegmentedTabs usage
ui/src/hooks/useAssistantStream.ts        — SSE + reconcile poll
ui/src/hooks/useMediaQuery.ts             — dock vs floating (useSyncExternalStore)
```

Behaviour notes:

- **Receipts:** `queued` = hollow ✓ (dim), `delivered` = ✓, `read` = ✓✓ accent.
  A `queued` message with the assistant offline shows "offline — will deliver
  when the assistant is up" instead of an error.
- **Origin marker:** `origin: 'tui'` user bubbles get a small terminal glyph, so
  it's obvious a message came from the tmux pane.
- **Reply:** hover → reply icon sets `replyTo`; composer shows a dismissible
  quote chip; the sent bubble renders the quote inline (tap to scroll to the
  original).
- **Expand:** hover → expand icon opens `BubbleDialog` (wide, scrollable,
  copy-all).
- **Streaming:** bubbles appear as the agent emits paragraphs, so long answers
  arrive progressively instead of all at once.
- Styling/redesign beyond this is explicitly **out of scope** for this plan —
  it's the "second" thing you mentioned.

## 8. Phases

Each phase is independently shippable and leaves the tree working.

| Phase | Scope | Touches |
| --- | --- | --- |
| **1. Daemon core** | sessions + messages schema & migration, non-blocking POST, inbox/ack, bubbles, thoughts, SSE, session routes; delete turn machine | `daemon/store.ts`, `daemon/store/assistant.ts` *(new — extract from store.ts)*, `daemon/routes/assistant.ts`, `shared/protocol.ts`, `shared/types.ts` |
| **2. Extension** | event mirror, inbound pump, TUI mirroring, remove `send_message`, session directives | `pi-pizza-team/src/assistant.ts`, `tools.ts`, `client.ts`, `index.ts`, `leader.ts` |
| **3. UI** | component split, SSE hook, receipts, thoughts peek, quote-reply, fullscreen | `ui/src/pages/AssistantPage.tsx`, `ui/src/components/assistant/*`, `ui/src/hooks/useAssistantStream.ts` |
| **4. Snapshots + resume** | markdown writer, session list/resume UI, degraded-resume path | `daemon/store/assistant-snapshots.ts` *(new)*, `SessionMenu.tsx` |
| **5. Docs + tests** | rewrite DESIGN.md §"Assistant chat model", ARCHITECTURE.md route/module maps, both READMEs | all four projects' docs |

Phase 1 and 2 must land together to keep the assistant functional — 1 removes
the endpoints 2 depends on. Practically: one branch, two commits.

## 9. Tests

- `my-pizza-team/tests/assistant.test.ts` — rewritten. New cases: POST never
  blocks; inbox/ack delivery state machine; bubble mirroring; session create/end/
  resume; thoughts ring buffer cap + expiry; SSE emits on message append;
  persona swap ends-not-clears; migration of v1 rows into a `legacy` session.
- `my-pizza-team/tests/leader-directives.test.ts` — add `new-session` /
  `resume-session` params.
- `pi-pizza-team/tests/assistant.test.mjs` — rewritten: mirror handlers, bubble
  splitting (code fences, lists, short-chunk merge), `steer` vs idle delivery,
  TUI `input` mirroring, ack sequencing.
- `pi-pizza-team/tests/tools.test.mjs` — drop `send_message` assertions.

## 10. Migration

On first boot with the new schema:

1. Create `assistant_sessions` and add the new `assistant_messages` columns.
2. Insert one session `legacy-<timestamp>` (`status='ended'`, no
   `pi_session_path`) and stamp every existing message with it.
3. Map `status` → `delivery`: `sent`→`queued`, `read`→`read`; assistant rows
   `done`→`ok`, `failed`→`failed`.
4. Drop `assistant_turns`. Leave `turn_id` in place (unused) until the release
   after next, then drop.
5. Write a snapshot for the legacy session so it shows up in the session list.

## 11. Risks / open questions

1. **Bubble splitting is a heuristic.** If the model writes one huge paragraph
   you get one huge bubble. Mitigation: the framing prompt asks for blank lines;
   plus a soft cap that splits at sentence boundaries above ~1200 chars.
   *Redline: is the soft cap worth it, or is it too clever?*
2. **`steer` semantics with tool-heavy work.** A message sent mid-tool-batch
   lands after the batch, not instantly. Correct, but the UI should show
   `delivered` (not `read`) so it's honest about the wait. Confirm that reads
   well.
3. **Inbox polling still exists** (1s, extension → daemon). Could become an SSE
   consumer in the extension later; not worth it in v1.
4. **Two writers to the same conversation.** If you type in tmux *and* the web
   UI simultaneously, ordering is whatever Pi accepts — the daemon reflects Pi's
   order, so the chat can differ slightly from the order you pressed enter.
   Acceptable?
5. **Thought stream volume.** Reasoning tokens can be large; 250ms throttle +
   ring buffer should hold, but the SSE payload is the thing to watch.
6. **`ctx.newSession` / `ctx.switchSession` footguns.** Per pi's
   `docs/extensions.md` §"Session replacement lifecycle and footguns", post-switch
   work must use the `withSession` ctx, not captured objects. The reporting of
   the new `piSessionPath` must happen inside `withSession`.
7. **Does the assistant still need `queue_request`?** With a real chat, the
   "queue a request for the team" tool overlaps oddly with just talking. Leaving
   it alone for now — flagging as a follow-up.

---

## Redline checklist

- [ ] §3 schema — fields you'd add/remove
- [ ] §4 route names & shapes
- [ ] §5.2 mirror table — want tool-progress bubbles on by default?
- [ ] §5.3 framing prompt wording
- [ ] §6.1 snapshot markdown format
- [ ] §7 component split + receipt semantics
- [ ] §8 phase order
- [ ] §11.1, §11.4 — the two judgement calls

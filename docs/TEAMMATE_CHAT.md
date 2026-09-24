# Teammate Chat — Plan

Watch a teammate work from the browser, and (optionally) pair with it —
the way you can talk to the leader in the left dock, but for any teammate, in
the **center** of the page, rendered **CLI-ish** rather than as chat bubbles.

Status: **Phase A in progress.** Phases ship (and are validated + committed)
one at a time.

---

## 1. Goals

| Want | How |
| --- | --- |
| Click a teammate → see what it's doing, live | `/teammates/:id` route in the center column; streamed Pi events |
| Takes up the whole center | It's a route, like any page — nav + sidebar selection show what's in the center |
| Never interrupt a working teammate by accident | **Watch** is the default and read-only; **Pair** must be switched on to talk |
| Terminal feel, not iMessage | One monospace column: `▸ user` blocks, streaming prose, `⏺ tool args` lines with collapsible output |

Non-goals (for now): history before you started watching (see §6 Backfill),
driving multiple teammates at once, replacing the leader's chat dock.

## 2. Navigation (Phase A)

The center column shows **one thing**, and whatever put it there is
highlighted: a nav tab for pages, a teammate row for `/teammates/:id`. To make
that ownership legible, the **NavBar spans only the center column** — the
three columns (assistant dock · center · teammate sidebar) are each full
height, with aligned `h-14` headers. The nav stops pretending to own the side
columns, which are independent.

The center can get narrow (both docks open on a laptop), so the nav degrades:
the "Pizza Team" wordmark hides first, then the links scroll horizontally
rather than wrapping or pushing the icons off-screen (a container query on the
center column, not a viewport breakpoint — the docks, not the window, decide
the room).

## 3. Watch (Phase B)

### 3.1 Stream only while watched

No backfill: the view starts at a `── watching from 14:32 ──` marker. The
header links the current work item (whose page has the full prompt + thread),
so the missing context is one click away.

- The daemon tracks **viewers per member** (SSE subscribers). While a member
  has ≥1 viewer — plus a ~30s grace after the last leaves, so page hops don't
  flap — its poll responses carry `watched: true`.
- The extension mirrors events **only while watched**. An unwatched teammate
  costs nothing.

Pi events mirrored (teammate role):

| Pi event | Transcript event |
| --- | --- |
| `session_start` | `session` divider (fresh session per work item) |
| `input` | `user` (work prompt / web message / tmux typing; `origin`) |
| `message_update` | `text` / `thinking` — cumulative per message, so opening mid-reply renders the whole message on the next update |
| `tool_execution_start` | `tool_start { name, args }` |
| `tool_execution_end` | `tool_end { result (truncated), isError }` — rendered standalone ("already running") if its start was missed |
| `agent_start` / `agent_end` | `run` start / end (drives the "working…" cursor) |

### 3.2 Daemon

- In-memory **ring buffer per member** (capped by events and bytes), cleared on
  a `session` event. Kept across viewer disconnects, so navigating away and
  back doesn't blank the view — a `gap` marker notes when nobody was watching.
  Lost on daemon restart (acceptable: it's a live view, not a record).
- `POST /api/agents/:id/transcript` (agent → daemon, batched events)
- `GET  /api/agents/:id/transcript` (buffer snapshot)
- `GET  /api/agents/:id/transcript/stream` (SSE; subscribing = watching)

### 3.3 UI

`TeammatePage` (`/teammates/:id`): header strip (status, current work item
link, directory, Pair toggle), then the terminal column. Long `user` blocks
(the work prompt) and tool output start collapsed.

## 4. Pair (Phase C)

- **Watch** (default): no composer; nothing reaches the teammate.
- **Pair**: composer on; teammate enters *pairing mode* (the same pause tmux
  typing triggers): no new claims, and it won't COMPLETE/fresh-session while
  you're talking.
- Sending while it's working **queues** (`followUp`, lands after the current
  run). **Steer now** (⌘↵) is explicit (`steer`, lands at the next tool
  boundary).
- **Release**: if it holds a work item — *complete* (summary = last reply),
  *fail*, or *keep working* autonomously.

Plumbing: `POST /api/agents/:id/messages`, and `pair` / `release` as member
self-directives (the pattern the leader uses for `new-session`).

## 5. Phases

| Phase | Scope | Projects |
| --- | --- | --- |
| **A** | NavBar spans the center column only | my-pizza-team (ui) |
| **B** | Watch-only transcript: daemon buffer + SSE, extension mirror, TeammatePage | my-pizza-team, pi-pizza-team |
| **C** | Pair + messaging + release | my-pizza-team, pi-pizza-team |

## 6. Future: on-demand backfill

A **Load earlier** button that asks the extension to send the session so far
(`ctx.sessionManager.getBranch()`), prepended above the watching marker. Slots
in without changing §3 — deliberately not built until it's missed.

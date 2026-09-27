# TODO

Known code issues and deferred work. Each item names a symbol rather than a line
number. Delete an item when it's done.

## Next: other harnesses (Kiro, Claude Code) over ACP

Not built. Replaces the earlier one-shot Kiro design: both agents speak the **Agent
Client Protocol** (JSON-RPC 2.0 over stdio, one object per line), which gives a
persistent session with streaming, permissions, and cancellation — far more than
one-shot runs.

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

### Proposed design

- **`mpt agent --harness <name>`**, a supervisor run *inside* the teammate's tmux window
  (the daemon's teammate template), so agents keep surviving daemon restarts as Pi
  teammates do. It is an **ACP client** to the agent and speaks the daemon protocol
  through `harnesses/pi/src/runtime/` (pure TS + `fetch`, importable from Deno — the
  second consumer DESIGN.md said would justify sharing it). The window shows a readable
  transcript.
- Mapping: heartbeat + register (handshake, `harness`); poll → claim → `session/new` (fresh
  context per item; mode set explicitly) → `session/prompt` with the daemon's prompt →
  `end_turn` = COMPLETE (last reply = summary comment), a `fail` path for giving up
  (e.g. `mpt work fail "<why>"`, or an MCP tool); `session/update` → transcript mirror
  (only while watched); usage → `/api/agents/:id/usage`; pairing: queue = next prompt,
  steer = Claude's queueing or cancel-and-reprompt for Kiro; `request_permission` →
  allow while autonomous, forwarded to the web UI while paired (new UI); `reset-session`
  → `session/new`.
- Pi stays native (Tier 2); the leader stays Pi at first.

### Open questions

1. Usage ledger unit for Kiro: add credits, or record tokens/context only?
2. Harness choice in a mixed team: per spawn (Spawn dialog picker; `defaultHarness` for
   the pool) first; routing work to a harness later?
3. Where the Claude adapter comes from: an npm dependency `mpt setup` installs, or the
   user's own `npx`?
4. Testing: a fake ACP agent (a script speaking the protocol) for e2e; real agents by
   hand only.

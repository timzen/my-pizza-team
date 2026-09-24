# TODO

Known-stale documentation and comments, with enough detail to fix them without
re-deriving the context. Line numbers drift — the quoted text is the anchor.

## Leftovers from retiring the assistant role

`refactor(chat): the leader is the agent you chat with; retire the assistant role`
(`1e72fdd`) deleted the dedicated assistant process: the **leader** now answers
the chat, and with it went the assistant's reserved singleton name, the
`pi-assistant` template, the spawn button, and `queue_request`. `feat(ui): move
the assistant into a left dock` (`22647ad`) then moved the chat and the
quick-create buttons off the home page into the left `AssistantDock`.

Several docs still describe the world before those two changes. The code is
correct in every case below — only the prose is stale, so these are safe,
isolated edits. Found while rebasing `86906fc` onto `3257a7b`; all of them
predate that rebase.

### `daemon/store.ts` — `createLeaderDirective` JSDoc contradicts its own body

The JSDoc claims:

> `reason: "assistant"` spawns get the reserved singleton name `"assistant"` […]
> The assistant is a singleton, so a duplicate spawn […] is coalesced into the
> existing request instead of emitting a second directive.

The body immediately below says the opposite, and is right:

> Every spawn is a teammate now: the chat is answered by the leader, so there is
> no reserved singleton name to assign.

There is no coalescing code and no `reason: "assistant"` spawn path left. Fix:
rewrite the JSDoc to document only the generated adjective-noun naming.

This is the highest-value item here — a comment that actively contradicts the
function it sits on is worse than no comment.

### `docs/DESIGN.md` — assistant-singleton spawn semantics

In the numbered "the daemon owns identity, so it assigns spawn names" item:

> a generated adjective-noun for a teammate, or the reserved singleton name
> `assistant` for an assistant spawn (`reason: "assistant"`) […] Because the
> assistant is a singleton (the chat and `reset-session` routing are keyed on the
> `assistant` name), a duplicate assistant spawn […] is coalesced onto the
> existing request instead of emitting a second directive.

Directly contradicted by the **One Agent to Talk To** section later in the same
file ("There is no dedicated 'assistant' process. The leader is the agent you
chat with."). Fix: drop the assistant branch from the naming rule and the whole
coalescing sentence.

The paragraph just after it is subtler and needs a decision, not a deletion:

> Clearing the assistant conversation (`DELETE /api/assistant/messages`) enqueues
> a `reset-session` directive for the assistant, so its in-agent context is
> dropped — not just the stored messages.

The mechanism still exists, but the directive now targets the leader/chat agent.
Reword rather than remove.

### `GUIDE.md` — home page tabs and the Assistant tab

Three spots still describe the pre-dock home page. The user-visible surface is
now Inbox + Thoughts, with chat and quick-create in the left dock.

1. > The **home page** (`/`) has a quick-create row (New Story / Solitary Task /
   > Scheduled Job) over two tabs: **Inbox** and **Assistant**.

   Both halves are wrong: the quick-create row moved into the dock, and the
   second tab is Thoughts. (`/assistant` survives only as a redirect that opens
   the dock.)

2. > A personal workspace — the **Thoughts** tab on the home page (alongside
   > Inbox and Assistant).

   Should read "alongside Inbox".

3. > Tag a context entry with **`persona`** […] On the Assistant tab, persona
   > entries appear as chips above the chat […]

   Personas still work (`PersonaChips`); they now live in the dock, not a tab.

Also worth a pass while in here: `GUIDE.md` references "Spawn" flows in places,
but spawning by button was replaced by the declared team-size box
(`TeamSizeBox`) in `86906fc`.

## Note on scope

These were left untouched deliberately during the `86906fc` rebase to keep that
commit's diff about team size rather than a docs sweep. They are independent of
each other and can be fixed in any order.

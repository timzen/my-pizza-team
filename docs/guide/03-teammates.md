# Teammates

**Teammates** are the AI agents that do the work — autonomous
[Pi](https://pi.mariozechner.at/) coding agents by default, each running in its own
terminal window (tmux by default, or herdr: see [Terminal](08-configuration.md#terminal)),
that connect to the daemon and ask it for work. We call them
"teammates" throughout the UI because that's how you work with them; "agent" is just
the underlying technical term (and the one the HTTP API uses, e.g. `/api/agents`).
The [assistant](04-assistant.md) is the one agent that isn't a teammate: it's the
agent you chat with (start it from the web UI, or with `mpt assistant`).

## How a teammate works

Teammates are a **flat generalist pool** — no skills or capabilities to configure.
Each registers its **working directory** (the folder it started in), and the daemon
prefers to give it work in that folder
([directory affinity](glossary.md#directory-affinity)): a teammate prefers runs whose
story or task names its directory, then work with no directory, and only reaches into
another directory's work when no teammate is homed there. Each teammate loops:

1. Ask for a waiting run (chosen by directory affinity)
2. Claim it (it's now working); receive the prompt the daemon puts together
3. Do the work (moving into the task's directory)
4. Report the outcome — **COMPLETE** (the task advances) or, if blocked, post a
   comment and mark it **FAILED** (the task is left stuck for you)

### One teammate per directory

While work runs in a directory, other work for that directory (or a folder inside it,
or one containing it) waits its turn, so two teammates never edit and commit in the
same checkout at once (internally a [directory lease](glossary.md#directory-lease)).
Work with no directory always runs in parallel. Turn this off under
**Config → Teammates → One teammate per directory**.

## The Team tab

Teammates live in the **Team** tab of the dock (beside the **Assistant** tab),
on every page — the teammate pool (the assistant isn't listed: it's the agent you talk
to on the Assistant tab). Each row shows:

- its status, in the circle down the row's left side — the icon *is* the status:
  - **person**: pairing with you
  - **bot**: waiting for work
  - **spinning loader**: working
  - **cloud with a slash**: lost contact

  (hover it for the words; a screen reader reads the status as text, and the row's
  link — hover or Tab to it — sums up the whole row: status, model, work, persona,
  context and cost),
- the model it's running (hover for provider/id),
- its current work and the **persona** it's working with (a ✦ chip — click it to open
  the persona),
- its working directory,
- how full its context window is, then what its session has cost so far.

The gauge shows the context window's fill (hover for exact tokens; `?` just after Pi
compacts, until its next reply). Both the gauge and the cost reset when the teammate
starts a fresh session for its next run.

With nobody online the tab says so, and how to change it: **Start the assistant**
while the assistant isn't running (it reads **Starting…** until the assistant connects; if the
daemon can't start it, it says why, with the fix; **Or from a terminal** shows the
command, `mpt assistant`), and **Spawn a teammate** (when the daemon can start one — it
doesn't need the assistant for that; otherwise it's greyed out and says why, with the fix).
It also warns when the [readiness probe](08-configuration.md#readiness-probe)
is failing — a new teammate would start but get no work until it passes.

While a model [failover](glossary.md#failover) is in effect, a small banner at the top of
the tab says so in one line — "Failover: *primary* → *fallback* since *time* (*kind*)";
hover it for when the usual model is tried again. It links to Config → Models, and
**End now** switches everyone back at once. The rows don't change (see
[Models and failover](11-models.md#what-youll-see)).

### Unmanaged windows

When the team's terminal (its tmux session, or herdr workspace) holds a window that
isn't a registered teammate, the assistant's, or a teammate still starting up, the
Team tab lists it under **Unmanaged windows** — say, a tab herdr's own session restore
relaunched after a reboot, or one you opened yourself. Each row shows the window's name
and what's running in it (**Running: pi**, an **idle shell**, or not known). Those
windows count toward the agents running on your machine, but not toward MPT's
teammates or the team size.

MPT never closes them by itself — you may have opened that tab on purpose. **Close**
closes one (after you confirm), ending whatever runs in it. The list refreshes every
few seconds, so a window you just opened can take a moment to appear.

On the Assistant tab you can still see the team at a glance: the Team tab shows how
many are online, and an amber dot when a team size can't be met (at-risk work shows
in the queue strip instead). The collapsed dock shows everyone as avatars.

To watch a teammate's own terminal, attach to the team's terminal (`tmux attach -t
<session>`, or `herdr` under herdr) and switch to the window (tmux) or tab (herdr)
with its name; from the assistant, `/ppt-hop <name>` brings it to the front. Under
herdr the Team tab works the same: only the window it lives in differs.

## Watching a teammate

Click a teammate to watch it work, live, in the middle of the page — its prompt, its
reasoning (folded), what it says, and every tool call with a preview of the output,
like looking over its shoulder at the terminal. Its row stays highlighted while you're
watching.

- It's **watch-only**: nothing you do there reaches the teammate.
- It opens with **the teammate's current session so far** — earlier tool calls and
  reasoning included — then carries on live. A very long session shows only its
  latest part (a "… earlier entries not shown" line at the top). A teammate on an
  older extension can't do this: its view starts when you start watching (a
  "watching from …" line). The work item link in the header has the full prompt and
  thread.
- A teammate nobody is watching doesn't stream anything, so leaving the page costs
  nothing.

### Choosing its model

The header's **model chip** shows the model the teammate is running. A pin icon (📌) means you
pinned it (a [model pin](glossary.md#model-pin)); an amber **failover** mark means a
substitute is standing in while its usual model is throttled or failing (see
[Failover](08-configuration.md#failover)). Hover or
focus the chip for the why.

Click the chip (or Tab to it and press Enter) for the models its harness can use:

- **Pick one** to pin it. The chip reads "switching to …" until the teammate
  switches — after its current run, never in the middle of one — then shows the new
  model with its pin. If the teammate can't use it, the reason appears under the chip
  and nothing changes.
- **Clear pin** goes back to its persona's model (or the [team default](glossary.md#team-default-model)).
- **Apply … to all teammates** pins the same model on every live teammate.

A teammate whose harness can't switch models shows the chip without the menu; its
tooltip says it's not supported by that harness. The assistant's model is set on
[Config → General](08-configuration.md#the-assistant). On the
[phone](09-phone.md) the chip is read-only.

## Pairing with a teammate

Watching never interrupts anything. To talk to a teammate, click **Pair**: it stops
taking new work and won't mark its current item done while you're talking, and a
message box appears.

- **Enter** queues your message — it lands when the teammate finishes what it's doing
  right now. **⌘↵** (or **Steer**) cuts in at its next tool step.
- Your messages show up in the transcript as `[you · queued]` / `[you · steer]` once
  it has them.
- When you're done, hand it back: **Resume** (it carries on with its run),
  **Complete** (the item is done — its last reply becomes the summary), or **Fail**
  (the item is marked failed and the task waits for you). If it's mid-step, the
  release waits for that step to finish.

For longer messages, use the [big editor](04-assistant.md#the-big-editor).

## Team size: how teammates get created

You don't spawn teammates one at a time — you **declare how many you want**. The Team
tab's row (right of the tabs, while Team is showing) has two icons:

- **Team size** (people icon) — the steady size of the teammate pool: set `3` and the
  daemon keeps three teammates online, spawning replacements whenever one is
  dismissed, crashes, or goes silent long enough to be reaped. An amber dot on the
  icon means the assistant isn't running, so the pool can't grow yet.
- **Spawn** (person-plus icon) — start one teammate in a specific directory (see
  below).

Details:

- Default is **half of Max Teammates** (rounded down — 2 with the default max of 4).
  Set **0** to spawn nothing; **Use default** in the dialog clears your value back to
  the default.
- The number is saved in `config.json` (also editable as **Min Teammates** on Config ›
  General — leave it blank for the default), so it's the target the daemon applies at
  startup.
- It's capped by **Max Teammates**, and it waits for the **assistant** to be running
  Until one is, the dialog tells you so and offers **Start the assistant**. The daemon starts the
  windows itself; if it can't reach the terminal (tmux or herdr), nothing spawns: the dialog and the Team tab
  say why, with the fix, and `mpt doctor` reports it too.
- Lowering the number never kills anyone: it just stops replacements. Dismissing a
  teammate stays your call (but with a non-zero minimum, expect a fresh one to take
  its place).
- Pool teammates spawn in the assistant's working directory. To home a teammate in a
  specific repo, use **Spawn** and pick the directory — directory affinity then biases
  that repo's work toward it. It counts toward the team size like any other teammate.

The **assistant** isn't part of the pool: there is exactly one, and it's the agent the
chat talks to.

The Team tab also shows **pending spawns** (starting up) and **failed spawns** with
the reason (e.g. a directory that doesn't exist, or the daemon can't reach tmux or herdr —
with the fix) — dismiss a failed one once you've seen it.

## Managing a teammate

- **Reset** (↺) — clears its context window: the teammate starts a fresh session
  itself, within a few seconds. If it was in the middle of a run, that run is
  abandoned and its item is left for you to recover from the Queue. It doesn't need
  the assistant.
- **Dismiss** (🗑) — removes it; the teammate shuts itself down on its next heartbeat.
  With a non-zero team size, a replacement takes its place.

For runs stuck on a teammate that went silent, see the Queue's
[recovery actions](01-tasks-and-runs.md#the-queue).

### Stalled teammates

A teammate can also be alive but stuck, for example on a test that never finishes.
It keeps checking in, and its status still says working. While it works, it reports
what it's doing: thinking, or which tool it's running (for a shell command, the
command, shortened, with passwords and tokens hidden). If nothing finishes for 30
minutes, MPT flags it **stalled**. Nothing finishing means no model turn and no
tool call completes. `mpt status` prints a line for each stalled teammate, for
example ``bright-muad-dib stalled 13h: bash `node --test …` ``.

Where you see it:

- **The Team tab.** The teammate's row shows an amber **⚠** in place of the working
  spinner. Hover (or focus) it for how long and on what: "Stalled 13h — bash:
  node --test …". The row gets no extra buttons. The phone's Team tab shows the same
  mark.
- **The teammate's page.** Under the header, a callout says how long it has been
  stalled, the command it's running and since when, and when it last made progress.
- **The Inbox.** One note per stall, however long it lasts, linking to the teammate
  and to the work item (see [The Inbox](01-tasks-and-runs.md#the-inbox)). The work
  item's thread gets one comment too, for example
  ``[stalled] no progress for 30m: bash `node --test …` ``.

What you can do, from the callout:

- **Interrupt** (after a confirm) stops the stuck command, the way pressing Escape in
  its terminal would, including anything the command started. The teammate keeps its
  work item, and is told its command was interrupted after so long with no progress,
  that it likely hung, and to find out why, re-run it with a timeout, and carry on.
  The callout then says the interrupt was sent, or why it failed (for example, the
  run had already ended). A teammate whose harness can't do this (an older extension,
  or an `mpt agent` teammate) gets a note pointing you to **Pair** instead. On the
  [phone](09-phone.md) the callout is read-only.
- **Pair** (see [Pairing with a teammate](#pairing-with-a-teammate)) to talk it
  through yourself.

Stalled is only a flag. MPT never stops or fails the run itself, because a long
build is legitimate: only you can tell a slow build from a hung one. The flag goes
away as soon as the teammate makes progress again, and its Inbox note reads
"(over)". Change the threshold with `stallMinutes` in `config.json` (0 turns it off).
A workflow step can set its own `stallMinutes`, for example a longer one for a
step known to run long builds.

## Pausing distribution

The **pause button** (⏸) in the navbar stops the daemon from handing out new runs;
work in progress continues. Use it while reorganizing. It isn't saved — restarting the
daemon resumes distribution. To hold just one story, make it
[pending](02-stories-and-workflows.md#pending-stories) on its page.

## After an upgrade

`mpt upgrade` updates the daemon and the Pi extension together, but running agents
keep the old code until they restart. The Team tab marks each out-of-date teammate
and shows a banner with a **Restart** button that rolls them all (their context is
cleared). Restart the assistant yourself (quit it, then **Start the assistant** or `mpt assistant`). An agent too old
to speak the daemon's protocol is refused at startup with a message saying so.

## Experimental: Kiro and Claude Code teammates

A team can also run **Kiro** or **Claude Code** teammates alongside Pi ones (each of
these is a [harness](glossary.md#harness)). They're experimental, so they're off until
the team opts in and the machine is prepared (`mpt setup --harness kiro` or
`--harness claude`). Opt in under **Config → Teammates → Experimental Harnesses** —
tick **Enabled** and **Save**; it applies immediately, no restart. (Or set
`"experimental": { "harnesses": true }` in `config.json` by hand and restart the
daemon.) Then the **Spawn** dialog has a **Harness** choice.

The same section sets the **Default Harness** — what a spawn that doesn't pick one
uses, including the teammates the daemon keeps online. It's only selectable while
experimental harnesses are on; turning them off resets it to Pi (the daemon won't save
a non-Pi default without the opt-in).

They pick up work like any teammate: each item in a fresh session, finished with a
summary in its thread, or given up with a reason. You can watch them live; their row
shows the harness. Not yet: **Pair** (the button is disabled for them) and **Reset**
(they start every item fresh anyway). Claude Code's usage and cost appear on the Usage
page; Kiro's don't, since it reports credits rather than dollars.

## Usage: what the team costs

The chart icon in the nav opens **Usage** — what the team is spending, in tokens and
dollars:

- **Tiles** — today, the last 7 and 30 days, the past year, and the peak day (by
  tokens or cost, whichever the grid shades by).
- **The grid** — one square per day for the past year, darker for busier days (shade
  by **Tokens** or **Cost**). **Hover** a day for its tokens, the full breakdown
  (input, output, cache read, cache write), cost, number of runs, and how it split
  between teammate work, the assistant chat, and pairing. **Click** it to list that
  day's runs, most expensive first. From the keyboard the grid is a single stop:
  **Tab** to it, move between days with the **arrow keys** (←/→ a week, ↑/↓ a day,
  **Home**/**End** along the row) — the same details show — and press **Enter** to
  list that day's runs.
- **Where it went** — the year split by kind, by cost or tokens.
- **What do these mean?** — a collapsed glossary at the bottom.

Every agent run is counted: teammates' runs, their runs while you pair with them, and
the assistant chat. **Token figures leave out cache reads by default** — earlier
prompt tokens reused from the cache are cheap and pile up fast on long sessions,
swamping everything else. Tick **Include cached** (next to Tokens/Cost; remembered in
this browser) to add them back. Cache writes always count. The cost is the harness's
own figure, already cache-aware, and doesn't change with the toggle. History is kept
even after its story is archived or deleted.

The ledger is saved **in the team directory**, committed with your stories and config:
`usage/YYYY-MM.jsonl`, one JSON line per run — easy to `grep` or `jq`, and it travels
with the repo. (The daemon's SQLite database is just a cache of it, rebuilt on
startup.)

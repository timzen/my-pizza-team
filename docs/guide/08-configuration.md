# Configuration

Settings live under the **config** (gear) icon, at `/config`:

- **General** — the **Work items** toggles, the **Assistant**'s persona and model (its chat or
  terminal look follows the dock's size — see
  [The assistant](04-assistant.md#chat-in-the-dock-terminal-at-full-page)), port, the
  **terminal** and its session name, team size (min/max teammates), default workflow, the **readiness probe**,
  the **agent env file**, **favorite directories**, autosave (flush/commit cadence, auto-commit)
- **Teammates** — the nouns used to name teammates, **One teammate per directory**,
  and **Experimental Harnesses** (opt in to Kiro / Claude Code teammates and pick the
  default harness; applies on save, no restart — see
  [Teammates](03-teammates.md#experimental-kiro-and-claude-code-teammates))
- **Models** — the team's **default model** (with **Apply to all teammates now**),
  the **model aliases** personas name, and the **failover** policy — see
  [Models](#models) and [Models and failover](11-models.md)
- **Sources** — your source plugins: switch each on or off, edit its settings,
  **Preview** what it would pull, and **Save** (see
  [Setting up a source from the UI](07-sources.md#setting-up-a-source-from-the-ui))
- **Workflows** — your story workflows and their state personas (see
  [Workflows](02-stories-and-workflows.md#workflows)); hidden while Stories are off
- **Personas** — the persona library: create, edit, duplicate, and see what uses each
  one (see [Personas](06-personas.md))
- **Triage** — [auto triage](05-thoughts-and-triage.md#auto-triage-notes-that-become-work):
  on/off, the sweep interval, the quiet period, and the **persona** every note-triage
  run follows (edit it on Personas)
- **Theme** — palette (a client-side preference; light/dark is the navbar toggle)

Each tab has its own address (`/config/teammates`, `/config/models`, `/config/sources`,
`/config/workflows`, `/config/personas`, `/config/triage`, `/config/theme`). **Save
Configuration** appears on General, Teammates, Models, and Triage — it saves the edits from
all four at once. Sources has its own Save per plugin (and source personas apply at
once), Workflows and Personas save as you go, the assistant's persona and model apply at once,
and Theme applies immediately.

Every Config tab (Workflows and Personas included) lights the gear in the nav.

## The assistant

**Config → General → Assistant** has two pickers, side by side, and both apply at
once — no Save:

- **Persona** — who the assistant is. Switching ends the current chat (it stays in
  the history) and starts a new one (see [Personas](06-personas.md)).
- **Model** — the models the assistant's harness can use. Picking one pins it (a
  [model pin](glossary.md#model-pin)): the line under it reads "Switching to … after
  its current reply…" until the assistant has switched, then names the model it's
  running. **Default** clears the pin. If it can't use the model, the reason shows
  under the picker. The picker is disabled while the assistant isn't running, or
  when its harness can't switch models ("not supported by this harness").

A teammate's model is chosen on its own page — see
[Choosing its model](03-teammates.md#choosing-its-model).

## Models

**Config → Models** (`/config/models`) is where you decide which models the team runs.
Everything here is saved with **Save Configuration**.

- **Default Model** — the model the team uses, one field per harness (Pi always; others
  once they're running or set). Type a model id or pick one of the suggestions — the
  models your running teammates and assistant say they can use. Empty means the
  harness's own default. A teammate or the assistant that starts after you save
  switches to it, unless you pinned its model (a [model pin](glossary.md#model-pin))
  or its persona names a model, which win over the default.
- **Apply to all teammates now** — sends the saved default to every running teammate
  and the assistant that has no pinned model; each switches after its current run.
  When a save changes the default, the card offers this right away (**Apply now** /
  **Not now**). Pinned agents are left as they are, and one whose harness can't switch
  models is counted as "not supported". With unsaved edits the button waits for you
  to save first.
- **Model Aliases** — the names personas use for a kind of model (`strong`, `fast`),
  each mapped to a model id per harness, and **Use persona models** (see
  [Model aliases](06-personas.md#model-aliases)).
- **Failover** — models to fall back on when the usual one is throttled or failing
  (see [Failover](#failover) below).

In `config.json` the default is `"defaultModel": { "pi": "<provider>/<model>" }`.
`mpt doctor` shows the default and the aliases, and warns when one names a model none
of the running agents can use.

### Failover

When the team's model keeps being throttled or failing with server errors, MPT can
switch the **whole team** to another model and switch back once the first one works
again. It's off until you turn it on in the **Failover** card on Config → Models:

- **Fail over automatically** — on or off. Turning it on needs a chain of at least two
  models.
- **Chain** — the models to fall back through, the **primary** (your usual model)
  first. Each is a model id or a [model alias](06-personas.md#model-aliases). Use the
  arrows to reorder and × to remove; the suggestions are the models your running
  teammates report and your aliases.
- **Fail over on** — which failures count: throttling (too many requests) and server
  errors by default, optionally other model errors. Expired credentials and prompts
  too big for the model never switch models: the
  [readiness probe](glossary.md#readiness-probe) and the normal retries handle those.
- **Failures that switch models … within (minutes)** — how many failures on the
  current model, across all teammates, switch the team (default 2 within 10 minutes).
- **Try the primary again after (minutes)** — how long the team stays on the fallback
  before one work item is run on the primary again (default 30). If that item's model
  calls work, everyone switches back; if they're throttled again, the wait starts
  over.

What happens when it switches: every teammate (and the assistant) running a failed
model moves to the next model in the chain after its current run — a pinned model or
a persona's model included; teammates on another model keep it. Work items waiting to
retry after those errors are retried right away (each still counts as one attempt).
If the fallback fails too, the team moves further down the chain; at the end of it,
the team stays on the last model and the normal retries carry on.

While a failover is in effect the **Team** tab shows a one-line banner —
"Failover: *primary* → *fallback* since *time* (*kind*)" — with **End now**, which
switches everyone back at once (the card here has **End failover now**, the same
thing). A teammate's model chip shows the **failover** mark while it runs the
substitute. A work item retried on the fallback gets a `[failover] retried on …`
comment, the Inbox gets one note per failover episode, and `mpt status` prints a
`Failover:` line — see [What you'll see](11-models.md#what-youll-see). Each failed
attempt's `[retry]` comment names the kind of error (throttled, server error, …).

In `config.json`:
`"failover": { "enabled": true, "on": ["throttle", "5xx"], "after": 2, "windowMinutes": 10, "chain": ["strong", "<provider>/<model>"], "revertAfterMinutes": 30 }`.

## Work items (feature toggles)

**Config → General → Work items** picks the kinds of work your team uses: **Stories**
(the Board tab, plus Config → Workflows), **Tasks** (standalone tasks — the Tasks
tab), and **Schedules** (the Schedule tab). A brand-new team starts with Tasks only; a
team that existed before the toggles has everything on. Tick or untick, then **Save
Configuration** — it applies right away, no restart.

When a kind is off:

- its **Work** tab (**Board**, **Tasks**, or **Schedule**) disappears, and so do its
  chip and rows on the **Pending** and **Archived** tabs (for Stories, so does Config's
  **Workflows** tab; with all three off, **Work** leaves the nav), and so does its
  entry in the dock's **+** quick-create menu (with all three off, the **+** goes too);
- its pages — lists, detail pages, and create forms — show a "turned off" notice with
  a link back here, even from a bookmark;
- a triage proposal of that kind can only be **Rejected** (Accept and Edit are
  disabled until you turn the kind back on);
- the assistant stops offering it: its tools for that kind leave its tool list (within
  about 10 seconds, or at its next reply) and it will tell you the kind is off if you
  ask for one;
- the API refuses it too, and `mpt status` leaves out its counts.

**Thoughts**, **Personas**, the **Queue**, and the **Inbox** are always there — even
with every kind off — and finished work stays in the Inbox.

You can only turn a kind off when it has no active work: a toggle that's still in use
is greyed out with what to clear first (e.g. "archive or delete 3 stories first").
Pending stories and pending tasks count; archived ones don't. Turning a kind back on
is always allowed.

[Sources](07-sources.md) (plugins like a tracker) are switched on the **Sources** tab
instead — see [Switching a source off](07-sources.md#switching-a-source-off).

## Readiness probe

If your machine sometimes can't work (expired credentials, VPN down), set a
**readiness probe**: a shell command the daemon runs every 30 seconds. Exit 0 means
ready; anything else means not ready, and its first line of output is the reason.
While not ready, **scheduled** jobs are held instead of run — and when it recovers,
each held job runs once (not once per missed tick). Story tasks and standalone tasks
still run. With no probe, the team is always ready. Automatic
[retries](01-tasks-and-runs.md#retries) also wait for the probe to pass, and so
does a [polling step](02-stories-and-workflows.md#polling-steps)'s next check: it's
held the same way (the card says **Held · team not ready**), runs once on recovery,
and its time limit doesn't run out while held.

## Agent environment file

Some tools your agents use need environment variables (say, a switch that turns on
an MCP server's write tools). Put them in one file and name it in **Config → General
→ Agent Env File** (`agentEnvFile` in config.json):

```
# KEY=value per line; # starts a comment
OUTLOOK_MCP_ENABLE_WRITES=true
GREETING="hello world"
```

Every window mpt opens — each teammate's, and the assistant's (from **Start the assistant** or `mpt assistant`) — gets
these variables. The file is read again each time a teammate starts, so an edit
reaches the next teammate with no restart (teammates already running keep what they
started with). It's the same syntax as systemd's `EnvironmentFile=`: no `export`, and
no shell expansion (`$HOME` stays `$HOME`). `~` works, and a relative path is relative
to the `.my-pizza-team` folder.

If the file is missing or has a bad line, teammates still start — just without it —
and `mpt doctor` names the file and the line. `mpt install` also points the login
service at the file, so the daemon itself has the variables.
A teammate not seeing a variable? See
[Troubleshooting](10-tips.md#troubleshooting).

## Terminal

Teammates and the assistant each run in a window the daemon opens in a terminal
multiplexer. **Config → General → Terminal** (`terminal` in config.json) picks which
one: **tmux** (the default) or **[herdr](https://herdr.dev)**. herdr needs version
0.9.5 or later on the daemon's PATH; without it, new teammates and the assistant
won't start (the Team tab and `mpt doctor` say why, and how to fix it). With herdr,
the team is a workspace in herdr's default session (open it with `herdr`), each
agent a tab; the daemon starts herdr's server if it isn't running. To give the team
its own herdr server instead, set `herdrSession` in config.json to a name (letters,
digits, `.`, `_`, `-`) and open it with `herdr session attach <name>`.

Under herdr, **Start the assistant** opens a `leader` tab (the "Starting…" note names
herdr and the command that shows it), and `mpt assistant` focuses that tab and
attaches you with `herdr` (or `herdr session attach <name>`). Run from a herdr pane of
the team's server, it just focuses the tab; run from inside tmux, it prints the
attach command rather than nesting herdr inside tmux. `mpt doctor` reports herdr's
version, the session and whether its server is running, and warns if the daemon
talks to a different herdr server than your shell.

A change applies to **new** windows only. Agents already running stay where they
were started, and dismissing one or hopping to it (`/ppt-hop`) still works there.
While any are still online, the Terminal field warns, and so does `mpt doctor`. To
move one, dismiss it (the team starts a replacement), or quit the assistant and
start it again.

**Session** (`tmuxSession` in config.json, kept under its old name) is the name of
the team's container in whichever terminal you use: the tmux session
(`tmux attach -t <name>`), or the herdr workspace.

## Favorite directories

Every directory field — New Story, a story's page, New Task, a task's page, a triage
proposal's edit form, and **Spawn** — has a dropdown of suggestions: your
**Favorites** first, then **Recent** directories (where teammates are working now,
then recent work and story directories). Click the ☆ on any row to favorite it (★ to
unfavorite), or the ☆ inside the field to favorite the path you typed. Manage the list
under **Config → General → Favorite Directories**; changes save immediately (no Save
button). Paths are stored resolved — `~` expanded and symlinks followed — so `~/repo`
and its real path are the same favorite.

## Autosave

Your stories, tasks, notes, and usage are plain files in `.my-pizza-team/`. If that
folder is inside a git repository, mpt commits it periodically (only that folder —
never your own work) and pushes if there's a remote. Turn it off with **Auto
Commit**.

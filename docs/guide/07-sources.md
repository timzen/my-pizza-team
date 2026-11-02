# Sources

A **source** (in full, an external *Work Source*) brings work in from somewhere else
— a tracker, a ticket queue, a folder, an API — so teammates can work it. Sources
come in **plugin packages** your team adds (or the development fixture source). This
page is about using them; to write one, see the developer docs,
[docs/PLUGINS.md](../PLUGINS.md).

## A source's tab

Each connected source gets its own read-only tab on **Work**, between **Schedule** and
**Pending**, named after the source. It lists what the source supplies — title, an
**Open in <source>** link, the last revision seen, the state of its latest run, and
how many times it has run — and refreshes from the source on its own:

- **Sync now** pulls at once;
- **Show archived** includes items the source no longer has;
- **Configure** opens its settings on Config → Sources.

Each new revision of an item runs once. Opening an item shows the usual details page,
but read-only: change it in the source, not here (internally the item is a
[mirror](glossary.md#mirror)). Its **Thread** works as usual — comments and
attachments — and comments and run outcomes are passed back to the source.

If the source reports its own comments, they appear in the Thread too, in time order,
each with a badge naming the source and, where it has several threads, the channel
(**SIM-T · Correspondence**, **SIM-T · Worklog**). Those came *from* the source, so
they're never sent back; a comment you post here and the source then reports back
isn't shown twice. A new comment in the source doesn't re-run the item.

## Triage-mode sources

Some sources (or some of their items) are **triage-only** — a ticket queue you'd
rather *think about* than hand straight to a teammate. Such an item is marked
**Triage** on its source's tab, and nothing ever works it directly: each new revision
gets a **triage** run instead, exactly like a note's
[auto triage](05-thoughts-and-triage.md#auto-triage-notes-that-become-work).

A teammate reads the item with the source's **triage persona** (a triage-mode source
must have one — set it in the source's Personas section on Config → Sources; until
then it doesn't sync and shows the error there) and proposes tasks, story tasks,
stories, or scheduled jobs. The row then wears the same badge a note gets (a lightbulb
for proposals waiting, **?** for a question, **–** for nothing to create), the
finished run lands in your **Inbox**, and both open the item's **Triage** tab: the
item read-only (with **Open in <source>**), the latest analysis with **Accept / Edit /
Reject** per proposal, and earlier rounds.

Accepting creates the work and never starts it; the item itself stays where it is.
Your turn is the item *in its source*: when it changes there, the next sync triages
the new revision (your earlier decisions are passed along, so rejected ideas aren't
re-offered). **Triage now** — the button that replaces Run on that page — forces a
fresh run, e.g. after one failed. Proposals aren't written back to the external
system; comments and run outcomes still are. (Plugin authors: see
[Triage mode](../PLUGINS.md#triage-mode).)

## Adding a source

Add a plugin package from a terminal, then restart the daemon — plugins load when the
daemon starts:

```
mpt plugins add ./mpt-acme-tracker --config '{"tokenEnv":"ACME_TOKEN"}'   # local, loads in place
mpt plugins add npm:mpt-acme-tracker@1.0.0                                 # or git:github.com/acme/mpt-acme-tracker@v1.0.0
mpt plugins list                                                           # installed? loaded? the error if not
mpt plugins update [<spec>]                                                # re-fetch unpinned npm/git packages
mpt plugins remove <spec>
mpt stop && mpt start --daemon                                             # or restart the service
```

Restart after any change to the package list or to a plugin's code. A plugin that
fails to load is skipped and the rest of the team carries on; `mpt plugins list` and
`mpt doctor` show why. A plugin runs inside the daemon with its permissions, so only
add ones you trust. When the daemon starts, it installs any npm or git package listed
in `config.json` `packages` that isn't installed yet (say, on a teammate's fresh
checkout of the team's config). More detail — and how to check a package with
`mpt plugins doctor` — is in [docs/PLUGINS.md](../PLUGINS.md#5-add-it-then-restart).

## Setting up a source from the UI

Once a plugin package is installed and the daemon restarted, you can do the rest on
**Config → Sources**:

1. **Find it in the list.** Every plugin source is listed with its package, a status
   pill — **Off**, **Init failed**, **Needs a triage persona**, **Not synced yet**,
   **Synced 5m ago**, **Sync failed 2m ago** (hover for the error), or **Backing
   off** — and how many items it mirrors. A package that failed to load is listed in
   red with why. No plugins yet? The tab says so and shows how to add one.
2. **Click it** to open its settings (`/config/sources/<id>` — the **Configure**
   button on its Work tab goes here too, and the ↗ button goes back to its Work tab).
   If the plugin describes its settings, you get a form: text, number, checkbox,
   drop-down, multi-choice and one-per-line list fields, each with its title, help
   text, placeholder and default; a red `*` marks required fields. A field left empty
   is unset, so the plugin's default applies. A plugin that doesn't describe its
   settings gets a JSON editor instead, which checks the syntax as you type.
3. **Secrets.** A token field takes the *name* of an environment variable (say
   `ACME_TOKEN`), never the token: put the token in the daemon's environment. Next to
   the name you see **set** or **not set** — whether the daemon has that variable
   (checked once saved). Values that look like secrets are never sent to the browser.
4. **Preview.** Press **Preview** to see what the plugin *would* pull with the
   settings on screen — saved or not: a table of items (title, linked to the item;
   external id; Work or Triage; directory), how many, and any warnings. Nothing is
   created, mirrored, queued or saved. Wrong settings come back as red messages under
   the fields they're about.
5. **Save.** **Save** writes the settings to the team's `config.json` and restarts
   just that plugin's setup — no daemon restart. You see "Saved — re-initialized", or
   the error if its setup failed (the settings stay saved; fix them and save again),
   and the status pill refreshes. **Discard changes** goes back to what's saved;
   leaving the page (a link, another source, a reload) with unsaved changes asks
   first.
6. **Switch it on.** Tick its checkbox in the list — that applies right away, and an
   enabled source syncs straight after. Unticking a source that still has mirrored
   items offers **Turn off and archive N items** (see
   [Switching a source off](#switching-a-source-off)).
7. **Personas.** Under the settings, **Personas** picks how a teammate works the
   source's items: a **Work persona** for items it works, and a **Triage persona** for
   items it triages into proposals. Each applies at once (no Save, and the plugin
   isn't restarted); "Source default" means whatever the plugin declares. A source in
   **triage mode must have a triage persona**: without one it doesn't sync, its pill
   says **Needs a triage persona**, and this section says so in red until you pick
   one. Your notes' triage persona (Config → Triage) is never used for a source. To
   work one item differently, set **Persona** on that item's Details tab — an
   override that survives every sync.

## Switching a source off

Sources are switched on the **Sources** tab rather than with the other
[Work items](08-configuration.md#work-items-feature-toggles) toggles (Work items links
there), and each one's switch applies at once — no Save needed. Switching one off
stops it syncing: nothing new is pulled or run from it, its Work tab disappears (a
bookmark shows a "turned off" notice), and anything a teammate is already working on
finishes.

While it still has mirrored items, switching it off asks first — **Turn off and
archive N items**: after you confirm, it switches the source off at once, archives its
items (nothing is deleted; their threads stay), and cancels their queued runs. Turn it
back on later and the next sync — which runs right away — brings back the items the
source still has, without re-running ones already done.

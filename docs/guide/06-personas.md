# Personas

How a teammate — or the assistant, or triage — behaves is a **persona**: a markdown
file in your team's persona library (`personas/<id>.md`) describing the role to play
(see [persona](glossary.md#persona)). Workflow steps, triage, the assistant,
standalone tasks, scheduled jobs, and [sources](07-sources.md) each *pick* a persona
instead of carrying their own instructions, so one edit changes everywhere it's used.

## The library

**Config → Personas** (`/config/personas`) is the library:

- **The list** — every persona, with a search box and tag chips. A badge says where
  each comes from: **team** (yours, editable), **built-in** (MPT's defaults:
  `builtin:worker`, `builtin:triage`, `builtin:assistant`), or the name of the
  **plugin package** that ships it. The small labels on the right (**worker**,
  **triage**, **assistant**) say which pickers list it first — a hint only; any
  persona can be picked anywhere.
- **New persona** — a title, an optional id (made from the title if you leave it), a
  one-line description (shown in pickers), tags, which pickers to suggest it in, and
  the **instructions**: what's put into the prompt. Saving checks them: an unclosed
  code fence is refused (it would swallow the rest of the prompt); top-level headings
  and stray `---` lines are saved with a warning (headings are nested under the
  prompt's own sections automatically).
- **A persona's page** (`/config/personas/<id>`) — its instructions, and **Used by**:
  every workflow step, setting, task, and source that picks it, each linked to where
  you'd change it. A team persona has **Edit**, **Duplicate**, and **Delete** — Delete
  is off while anything uses it (re-point those first). Built-in and package personas
  are read-only: **Duplicate to edit** copies one into your library as a new persona
  you can change (it doesn't follow later updates to the original).

## Where you pick one

| What | Where | None picked means |
|---|---|---|
| A workflow's agent step | Config → Workflows → a workflow → **State Personas** | a one-line state framing |
| Note triage | Config → **Triage** → **Persona** | the built-in triage persona |
| The assistant | the chips above the chat, or Config → General → Assistant → **Persona** | the built-in assistant |
| A standalone task or a scheduled job | **Persona** on its create form and its Details tab (changeable any time — every run of a schedule uses it) | no persona |
| A source | Config → Sources → the source → **Personas** | what the source declares, if anything |
| One item from a source | **Persona** on its Details tab (an override, kept across syncs) | the source's choice |

Story tasks get their persona from the workflow step they're in (see
[State personas](02-stories-and-workflows.md#state-personas)). For the assistant, see
[Assistant personas](04-assistant.md#assistant-personas).

## Seeing who's working how

While a teammate works, a ✦ **persona chip** shows the persona it was given — on its
row in the Team tab, on Queue rows, in the header when you watch it, and in the
**Runs** list on a task's Details tab. Click it to open the persona. The chip records
what the run actually got, so editing or deleting the persona later doesn't change
it: a deleted one shows its name marked **(deleted)**, without a link. A run with no
persona has no chip. An amber outline means the persona it asked for was missing, so
a built-in stood in (hover for which).

## Personas from a package

Personas you want to share between teams travel as a **plugin package** (an npm
package, git repository, or local folder). Install one with `mpt plugins add` and
restart the daemon; its personas appear on **Config → Personas** with the package's
name as their badge, ready to pick anywhere. A package persona's id is
`<package name>/<file name>` — e.g. `acme-mpt-personas/reviewer`. Pin a version in
the spec (`npm:acme-mpt-personas@1.2.0`, `git:…@v1.2.0`) when you don't want updates;
`mpt plugins update` re-fetches unpinned ones. New persona text takes effect after a
daemon restart; work already running keeps the persona it started with, and each
run's persona chip records what it actually got. To build one, see
[Distributing a persona package](../PLUGINS.md#distributing-a-persona-package) in the
developer docs.

**Customizing.** Package personas are read-only. To change one for your team, open it
on Config → Personas and **Duplicate to edit**: you get a team copy to edit and point
your workflows at. The copy doesn't follow later updates to the package.

**Removing.** `mpt plugins remove` lists anything still using the package's personas
— workflow steps, triage, the assistant, tasks, sources — and what each will fall back
to (`builtin:worker`, `builtin:triage`, or `builtin:assistant`; a triage-mode source's
triage persona has no fallback, so that source stops syncing until you pick another).
Re-point them, or duplicate the personas first.

## The Context Library was removed

*How to do the work* belongs in a persona; *what the project is* (conventions,
architecture, build commands) belongs in the project itself — its AGENTS.md or
README — where teammates already read it. Versions 0.34–0.36 moved an old team over on
its first start (tagged entries became personas, attached ones were copied into their
tasks' **Additional Context**, and `context/` was kept as `context.migrated/`, with a
one-time notice you can dismiss under the menu bar). A team that never ran one of
those versions has to start once on 0.36 first: see README "Upgrading from before
0.36.0".

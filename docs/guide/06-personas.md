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
  `builtin:teammate`, `builtin:triage`, `builtin:assistant`), or the name of the
  **plugin package** that ships it. The small labels on the right (**teammate**,
  **triage**, **assistant**) say which pickers list it first — a hint only; any
  persona can be picked anywhere. (The **teammate** label used to be called
  **worker**; see [Deprecated: worker](#deprecated-worker).)
- **New persona** — a title, an optional id (made from the title if you leave it), a
  one-line description (shown in pickers), tags, which pickers to suggest it in,
  optional [harness settings](#tools-skills-model-and-requirements), and the
  **instructions**: what's put into the prompt. Saving checks them: an unclosed
  code fence is refused (it would swallow the rest of the prompt); top-level headings
  and stray `---` lines are saved with a warning (headings are nested under the
  prompt's own sections automatically).
- **A persona's page** (`/config/personas/<id>`) — its instructions, and **Used by**:
  every workflow step, setting, task, and source that picks it, each linked to where
  you'd change it. A team persona has **Edit**, **Duplicate**, and **Delete** — Delete
  is off while anything uses it (re-point those first). Built-in and package personas
  are read-only: **Duplicate to edit** copies one into your library as a new persona
  you can change (it doesn't follow later updates to the original).

## Tools, skills, model and requirements

A persona can also carry a few optional **harness settings** — limits the teammate's
harness applies while it works as that persona. Set them under **Harness settings**
in the editor (comma-separated, like tags), or in the file's frontmatter:

```yaml
tools: { allow: ["read", "grep", "mcp__code-search__*"], deny: ["bash", "write"] }
skills: ["code-review"]
model: "strong"
requires: { mcp: ["code-search"] }
```

| Setting | What it means | Left blank |
|---|---|---|
| **Tools allowed** (`tools.allow`) | The tools it may use, by the names its harness gives them; `*` matches anything (`mcp__code-search__*`) | every tool |
| **Tools denied** (`tools.deny`) | Tools it may never use, even if allowed | none denied |
| **Skills** (`skills`) | The skills it may use | every skill |
| **Model** (`model`) | A model *alias* such as `strong`, which your team's config maps to a real model | the harness's default model |
| **Requires MCP servers** (`requires.mcp`) | MCP servers its work needs — checked and reported when missing, never started | nothing required |

How much of this is enforced **depends on the teammate's harness** — MPT passes the
settings along with the persona, and each harness applies what it supports — so treat
them as guardrails, not a sandbox. Other harnesses may apply none of them.

**On Pi** (teammates and the assistant), `tools` and `skills` are enforced:

- The model is offered only the tools the persona allows, minus those it denies; a
  persona narrows the tools, it never turns on one that was off. A call to any other
  tool — also one made from inside another tool, like codemode — is refused with a
  reason naming the persona.
- **MPT's own tools always stay**, whatever the persona says: a teammate can always
  attach a file, fail an item, propose work or wait (and the assistant keeps its
  story, task and thought tools). Denying one is reported and ignored.
- Only the persona's skills are listed in the system prompt, and `/skill:<name>` for
  another skill is refused. The skill files themselves aren't hidden, so this scopes
  what's offered rather than locking files away.
- When the work item ends, the full tool set comes back for the next one.
- Anything that can't be applied as written — a pattern that matches no tool, a skill
  that isn't installed — is posted once as a comment on the work item's thread when
  the teammate picks it up, e.g. `persona reviewer: tools.allow pattern 'foo*' matched
  no tools` (the assistant shows it as a warning in its window instead).
Saving checks them: a wrong shape (say, `skills: code-review` instead of a list) or a
pattern with `?`, `[]` or `{}` is refused; a deny that cancels an allowed tool, or an
empty allow list (no tools at all — only possible in the file), is saved with a
warning. A persona's page lists the settings it has under **Harness settings**.
Built-in personas set none; a package persona's are read-only like the rest of it.

### Model aliases

A persona never names a real model — those differ between harnesses and machines —
but an **alias**: `model: "strong"`. Your team maps each alias to a model, per
harness, on **Config → Teammates → Persona Models** (or in `config.json`):

```json
"modelAliases": { "pi": { "strong": "<provider>/<model>", "fast": "<provider>/<model>" } }
```

For Pi the model is written as `/model` shows it, `<provider>/<model>` (a bare model
id works when only one provider has it).

- **On Pi**, a teammate switches to the persona's model when it picks the work item
  up, and back to the model it had when the item ends. The usage page and the Team
  tab show the model each run actually used. The assistant switches when its persona
  names a model (once per persona: pick another with `/model` and that stands).
- **An alias with no mapping** for the teammate's harness sets no model: the run keeps
  the harness's default model, and the work item's thread gets one comment saying
  which `modelAliases` entry to add. Saving a persona whose alias the team doesn't
  define at all warns too, and `mpt doctor` lists the aliases personas use that have
  no mapping.
- **A model the harness can't use** (unknown to it, or no credentials for its
  provider) keeps the current model, and the thread says so.
- **Persona models off:** untick **Use persona models** (`"personaModels": false`) to
  ignore every persona's model — runs keep the harness's model and nothing is posted.

Other harnesses get the resolved model with the persona but may not apply it.

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

## How a teammate gets its persona

A Pi teammate gets the persona in its **system prompt**, as its own section, for
exactly the work item it was picked for: the work prompt itself then starts with
the story or the task, not **Your Role**. That keeps the role in force for a whole
run (a long conversation's older messages can be summarized away; the system
prompt isn't) and it never carries over to the teammate's next item. Other
teammates (`mpt agent`) still get it at the top of the work prompt, as **Your
Role** — the same words either way. When you watch a Pi teammate, its transcript
starts at the work prompt; the persona chip says which persona it's using.

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
to (`builtin:teammate`, `builtin:triage`, or `builtin:assistant`; a triage-mode source's
triage persona has no fallback, so that source stops syncing until you pick another).
Re-point them, or duplicate the personas first.

## Deprecated: worker

The **teammate** kind used to be called **worker**. The old spellings still work for
now (MPT logs a one-time warning naming the replacement), but they'll be removed in a
future version, so switch when convenient:

| Old (deprecated) | Use instead |
|---|---|
| `kinds: [worker]` in a persona file | `kinds: [teammate]` (saving the persona on Config → Personas updates it) |
| `builtin:worker` | `builtin:teammate` |
| `kind=worker` (`GET /api/personas?kind=…`) | `kind=teammate` |
| `--ppt-worker` in a customized Pi spawn template | `--ppt-teammate` |
| `"type": "agent"` on a workflow state (`workflow.json`) | `"type": "teammate"` (saving the workflow updates it; see [Deprecated: agent state type](02-stories-and-workflows.md#deprecated-agent-state-type)) |
| `agentCount` in `GET /api/workflows` | `teammateCount` |

## The Context Library was removed

*How to do the work* belongs in a persona; *what the project is* (conventions,
architecture, build commands) belongs in the project itself — its AGENTS.md or
README — where teammates already read it. Versions 0.34–0.36 moved an old team over on
its first start (tagged entries became personas, attached ones were copied into their
tasks' **Additional Context**, and `context/` was kept as `context.migrated/`, with a
one-time notice you can dismiss under the menu bar). A team that never ran one of
those versions has to start once on 0.36 first: see README "Upgrading from before
0.36.0".

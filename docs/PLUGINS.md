# Writing plugins

Developer docs for **plugin packages**: how to write a Work Source plugin that brings
work in from another system, and how to ship personas in a package. To *use* a plugin
someone else wrote, see the user guide instead: [Sources](guide/07-sources.md) and
[Personas](guide/06-personas.md#personas-from-a-package).

## Writing a Work Source plugin

A **plugin package** brings work in from somewhere else — a tracker, a folder, an
API — as an external Work Source. It shows up as its own read-only tab (see
[A source's tab](guide/07-sources.md#a-sources-tab) in the user guide), and each new revision of an item runs once. A
plugin is an ordinary npm package, git repository, or local folder; this page is
for whoever writes one. (Adding someone else's is `mpt plugins add` — see
[5. Add it, then restart](#5-add-it-then-restart), and
[Sources](guide/07-sources.md) in the user guide.)

### 1. The manifest

The package's `package.json` lists its source entries under
`"mpt"`, and declares this app as a peer dependency rather than installing it:

```json
{
  "name": "mpt-acme-tracker",
  "version": "1.0.0",
  "type": "module",
  "mpt": { "sources": ["./dist/index.js"] },
  "peerDependencies": { "my-pizza-team": "*" },
  "devDependencies": { "my-pizza-team": "*", "typescript": "^6.0.0" },
  "scripts": { "build": "tsc" }
}
```

The peer dependency is what lets you `import … from "my-pizza-team/plugin"`: the
daemon answers that import with **its own** copy (even if the plugin has none
installed), so you always see the running app's types and constants. Keep it in
`devDependencies` too if you want the types while you write. Entries must be files
inside the package; other keys under `"mpt"` are ignored.

### On/off

An external source (one with `sync`) gets a toggle for free: it's listed
on **Config → Sources** by its `label`, as `features.<id>` in
config.json, and can be switched off or disconnected (see [Switching a source off](guide/07-sources.md#switching-a-source-off)).
While it's off the daemon never calls your `sync` or `tick`, and `ctx.upsertDef` /
`ctx.enqueue` return null. To name the flag yourself, declare `toggle: { feature:
"…" }`; to make the source always on, declare `toggle: null`. A feature name must be
unique and can't be `stories`, `tasks`, or `schedules` (nor can your id be, unless
you name another feature) — the daemon refuses such a source at load and says why.

### 2. The entry

Each entry's **default export** is either a Work Source object,
or a factory `(options, { teamDir }) => source` (it may be `async`) — use the
factory when the source needs its settings up front:

```ts
import { WORK_SOURCE_API_VERSION, type ExternalDef, type PluginFactory } from "my-pizza-team/plugin";

const factory: PluginFactory = (options) => {
  const tokenEnv = String(options.tokenEnv ?? "ACME_TOKEN");
  return {
    id: "acme",                        // lowercase letters, digits, dashes
    label: "Acme",                     // the tab's name and "Open in Acme"
    apiVersion: WORK_SOURCE_API_VERSION,
    syncEveryMs: () => 5 * 60_000,     // how often to pull (default 60s)
    async sync(ctx): Promise<ExternalDef[]> {
      const token = process.env[tokenEnv];
      if (!token) throw new Error(`set ${tokenEnv}`);
      // Return every item the source has *now*; an unchanged revision is a no-op.
      return [{ externalId: "ACME-1", revision: "2024-06-01T10:00:00Z", title: "Fix login", goal: "…", url: "https://acme.example/ACME-1" }];
    },
    onComment(def, comment, ctx) { /* optional: write the comment back */ },
    onItemTerminal(def, item, ctx) { /* optional: write the outcome back */ },
  };
};
export default factory;
```

The hooks, and what the daemon does with each, are documented on the
`WorkSource` and `SourceContext` types themselves. `ctx.kv` keeps small strings
(cursors, stamps) across restarts; `ctx.log` prefixes your output.

### Triage mode

If your items are requests to *think about* rather than work to
do — a ticket queue, say — set `mode: "triage"` on the source (or `mode` on
individual `ExternalDef`s; an item's own wins). Each new revision then gets a
**triage** run, like a note's Auto Triage: a teammate reads the item (with the
source's **triage persona** — see Personas below) and proposes tasks, stories,
or schedules, which you accept or reject. Accepting creates the work without starting it;
nothing runs the item itself. In this mode the daemon sets the item's title
("Triage: …"), directory, prompt, and Run (Triage now), so your `resolveItem`,
`buildPrompt`, and `run` aren't called for those items; write-back hooks still are.
It's an optional field, so `apiVersion` stays 1.

```ts
return {
  id: "acme-tickets", label: "Acme Tickets", apiVersion: WORK_SOURCE_API_VERSION,
  mode: "triage",                    // every item from this source is triaged
  async sync() {
    return tickets.map((t) => ({
      externalId: t.key, revision: t.updatedAt, title: t.summary, goal: t.description, url: t.link,
      mode: t.type === "Task" ? "work" : undefined,   // "work" | "triage"; omitted = the source's mode
    }));
  },
};
```

The revision is the turn, so make it cover what the item *says* (an
`updatedAt`, or a hash of the title and body), not comments you write back
yourself — otherwise your own write-back re-triggers a triage. A source can flip
an item's mode without a new revision; the change applies to its next run. The
demo team's `mpt-source-demo-tracker` plugin shows both modes end to end.

In the web UI such an item is marked **Triage** on its source's Work tab, with
the same badge a note gets (proposals waiting, a question, nothing to create).
Its page opens on a **Triage** tab: the item read-only (with **Open in
<source>**) beside the latest analysis, each proposal with **Accept**, **Edit**,
or **Reject**, and earlier rounds; the header's button is **Triage now**. A
finished triage run lands in your Inbox and opens that tab. To answer a
question, change the item in its source — the next revision is triaged again.

### Personas

Say how your items should be worked by naming a persona (see
[Personas](guide/06-personas.md)) — the daemon puts
it at the top of each item's prompt, as **Your Role**, before your `buildPrompt`
sees it, so you never write that part yourself:

```ts
return {
  id: "acme", label: "Acme", apiVersion: WORK_SOURCE_API_VERSION,
  defaultPersona: "mpt-acme-tracker/acme-worker",   // work-mode items (optional)
  triagePersona: "builtin:triage",                   // triage-mode items (required for mode: "triage")
  async sync() {
    return issues.map((i) => ({ /* … */ persona: i.type === "Bug" ? "bug-fixer" : undefined }));  // per item (optional)
  },
};
```

A persona id is a team persona (`reviewer`), a built-in (`builtin:triage`,
`builtin:teammate`), or one a package ships (`<package name>/<id>`). Who wins, first
to last: a person's override on the item (`PUT /api/work-defs/<id>/persona`), the
item's own `persona`, the team's choice for your source (config.json
`sourcePersonas.<id>.persona` / `.triagePersona`, set with `PUT
/api/sources/<id>/persona` — saving it never re-runs your `init`), then your
`defaultPersona` / `triagePersona`. Nothing named means no persona for a
work-mode item. An id that doesn't exist falls back to the built-in when the item
runs (logged, and a ⚠ in `mpt plugins doctor`). Each run records the persona it
used, so the UI can show it.

**A triage-mode source must have a triage persona** — declared as
`triagePersona`, or set by the team for your source. Without one (or with one
that doesn't exist) the daemon **doesn't sync it**: the source shows the error on
**Config → Sources** ("needs a triage persona — set one on Config → Sources, or
declare triagePersona") and `mpt plugins doctor` marks it ✗. The team's
note-triage persona is deliberately not used instead. In a work-mode source, an
individual triage item without one is mirrored but not queued until one is set.
(Teams upgrading with a triage plugin already installed get the team's triage
persona filled in for it automatically, once, so nothing stops working.) These
are optional fields too, so `apiVersion` stays 1.

### The thread

To mirror an item's comments too, return them as
`comments` on its `ExternalDef` — `{ externalId, author, createdAt, body,
channel? }` each (`ExternalComment`). The daemon appends the ones the mirror's
thread hasn't seen (by `externalId`), marked as coming from your source; they
never fire `onComment`, so nothing is echoed back. Omit `comments` on an item
to leave its thread as it is (fetch threads only for items that changed, if
that's expensive); a comment missing from the list isn't deleted. Comments
aren't content: keep them out of `revision`, or every comment re-runs the item.
When `onComment` posts a comment, return (or resolve with) its new id —
`{ externalId }` — so it isn't pulled in again when your sync reports it:

```ts
async sync(ctx) {
  return issues.map((i) => ({
    externalId: i.key, revision: i.contentUpdatedAt, title: i.summary, goal: i.description,
    comments: i.comments.map((c) => ({ externalId: c.id, author: c.author, createdAt: c.created, body: c.text, channel: c.thread })),
  }));
},
async onComment(def, comment, ctx) {
  const posted = await api.addComment(def.parent!.id, `${comment.from}: ${comment.body}`);
  return { externalId: posted.id };   // recognised when it comes back
},
```

### 3. Settings and secrets

The `config` of the team's package entry —
`{ "source": "npm:mpt-acme-tracker", "config": { "tokenEnv": "ACME_TOKEN" } }`
in `config.json` `packages` — is the factory's `options` and the source's
`ctx.options()` (read-only). **Never put a secret there:** take the *name* of an
environment variable (`tokenEnv`) and read `process.env`, so `config.json` stays
safe to share and commit.

### 4. Build to JavaScript

Node won't run TypeScript from inside
`node_modules`, so an npm package must ship compiled `.js` (point `"mpt.sources"`
at `dist/`). A git repository can ship sources plus a `build` script, or commit
its built entries — see [Distributing a plugin](#distributing-a-plugin). A local
folder loads in place, so a plain `.js` entry needs no build at all.

### 5. Add it, then restart

```
mpt plugins add ./mpt-acme-tracker --config '{"tokenEnv":"ACME_TOKEN"}'   # local, loads in place
mpt plugins add npm:mpt-acme-tracker@1.0.0                                 # or git:github.com/acme/mpt-acme-tracker@v1.0.0
mpt plugins list                                                           # installed? loaded? the error if not
mpt plugins update [<spec>]                                                # re-fetch unpinned npm/git packages
mpt plugins remove <spec>
```

Plugins load when the daemon starts, so **restart it after any change** — to the
package list or to a plugin's code (`mpt stop && mpt start --daemon`, or restart
the service). A plugin that fails to load (no manifest, a throw, a wrong
`apiVersion`, an id another source already has) is skipped and the rest of the
team carries on; `mpt plugins list` and `mpt doctor` show why. A plugin runs
inside the daemon with its permissions, so only add ones you trust.

### Installed on start

`packages` in `config.json` is enough: when the daemon
starts, any npm or git package listed there that isn't installed yet (say, a
teammate's fresh checkout of the team's config) is installed first, exactly as
`mpt plugins add` would, and logged with `[plugins]`. Each package is on its own:
one whose install fails is skipped and its error shows in `mpt plugins list`,
`mpt doctor` and `mpt plugins doctor`, while the rest load. Each install command
is limited to 10 minutes (set `MPT_PLUGIN_INSTALL_TIMEOUT_MS` in the daemon's
environment to change it), a failed one isn't retried until the next restart,
and local paths are never installed or changed. config.json is never written.

## Describing your settings (configSchema) and preview

Two optional fields make a plugin easy to set up without hand-editing JSON.
`configSchema` describes your settings — a small subset of JSON Schema: an
object of `string`, `number`, `integer`, `boolean`, `enum`, and string-`array`
fields, with objects nested one level — plus hints for the form: `title`,
`description`, `placeholder`, `default`. Mark a secret reference with
`format: "env-var"`: the field holds the *name* of an environment variable,
never the secret, and anything that isn't a valid name is refused. `preview`
answers "what would you pull with these settings?" without pulling anything.

```ts
const factory: PluginFactory = () => ({
  id: "acme", label: "Acme", apiVersion: WORK_SOURCE_API_VERSION,
  configSchema: {
    type: "object",
    required: ["project"],
    properties: {
      project:  { type: "string", title: "Project key", placeholder: "ACME" },
      tokenEnv: { type: "string", title: "Token", format: "env-var", default: "ACME_TOKEN",
                  description: "The environment variable that holds your API token" },
      status:   { type: "string", enum: ["open", "all"], default: "open" },
      maxItems: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  async sync(ctx) { return fetchItems(ctx.options()); },
  // Optional: without it, Preview runs `sync` with the draft settings.
  async preview(ctx, draftOptions) {
    const items = await fetchItems(draftOptions);
    return { items: items.slice(0, 10), note: `${items.length} items match` };
  },
});
```

**Which settings the schema describes.** By default your whole package entry
`config`. If your package ships **several sources**, give each its own block
and say so with `configScope: "source"`: the schema then describes
`config["<source id>"]`, e.g. `{ "config": { "sim-t": { … }, "taskei": { … } } }`.
Either way `ctx.options()` (and a factory's `options`) is the whole `config`, as
before.

**Checked at load.** When the daemon starts it checks each source's settings
against its schema. A mismatch is logged (`[plugins] … warning: config.project:
is required`) and reported with the package's status (`GET /api/sources`,
`plugins[].warnings`) — the source still loads.

**Preview has no side effects.** Preview (and the `sync` it falls back to) gets
a restricted `ctx`: `ctx.options()` is the draft, `upsertDef`, `enqueue`, and
`enqueueRevision` do nothing (and show up as a warning), and `kv.set` /
`kv.delete` change a scratch copy that's thrown away. It's limited to your
`syncTimeoutMs` (default 30s). Don't write to the external system from it
either. If your `sync` has side effects of its own, relies on a kv cursor (a
preview would see only what changed), or reads settings your factory captured
(so the draft can't reach it), implement `preview`. Return `{ items, warnings?,
note? }`; items the mirror would refuse (no `externalId`, `revision`, or
`title`, or a repeated `externalId`) are dropped with a warning.

**Saving settings re-runs `init` — make it idempotent.** Settings saved from
the daemon (`PUT /api/sources/<id>/config`, what the Config page's Save calls)
are written to the team's `config.json` and applied without a restart: your
`ctx.options()` starts returning them, `init(ctx)` is called **again** (awaited,
limited to `syncTimeoutMs`), any sync backoff is cleared, and an enabled source
syncs straight away. So `init` must cope with running more than once: replace
clients and caches rather than adding to them. Read settings from
`ctx.options()` — a factory's `options` argument is *not* refreshed (the
factory isn't called again), and neither are `syncEveryMs` / `tickEveryMs`
(restart for those). If `init` throws, the new settings stay saved and the
source is shown as errored until a later save succeeds. Settings that look
like secrets (a `token`/`secret`/`password`/`apiKey` key holding text) are
never sent to the browser; env-var references are shown by name, with whether
the daemon's environment has them.

**Adopting it in an existing plugin.** What the bundled examples
(mpt-demo-team's demo-tracker, MPTSimWorkSources' sim-t and taskei) needed:

- Settings read once in the factory and closed over: move them into a
  variable that `init` refreshes from `ctx.options()`, and have every hook read
  that variable. A source-level `mode` that depends on a setting can be a getter.
- `preview`: run your fetch-and-map path on the draft (`draftOptions`) and skip
  your own side effects — a `dryRun` gate, logging what a sync would mirror,
  bookkeeping in kv (the ctx's kv is a scratch copy anyway). Turn problems the
  person can fix ("not configured", a bad value, an expired login) into
  `warnings` instead of throwing; a throw shows as the preview's error.
- The schema has no "string or list": declare such a setting as a list. An
  old config with a lone string still loads (with a `[plugins]` warning) and
  shows in the form as one line; Preview and Save ask for a list until it's
  edited.

## Distributing a plugin

A plugin travels as an npm package (from your npm registry) or a git repository.
MPT doesn't know about build systems — no Brazil, Bazel or the like — so a **git
plugin must meet one contract**: either

- it **installs and builds with plain npm** against the user's configured
  registry (`npm config get registry`): `npm install --omit=peer` then
  `npm run build` must succeed in a fresh clone, or
- it **ships prebuilt entries**: every `mpt.sources` file is committed, so it
  exists right after `git clone`.

What `mpt plugins add <git url>` (and the daemon's install-on-start) does after
cloning:

| The clone has… | MPT runs |
|---|---|
| every `mpt.sources` entry committed, no `dependencies` | nothing — no npm at all |
| every entry committed, some `dependencies` | `npm install --omit=peer --omit=dev` (runtime deps only, no build) |
| an entry missing | `npm install --omit=peer` (dev deps too), then `npm run build`; the entries must exist afterwards |

When an npm step fails you see the command, its exit code and the end of npm's
error output (often an `E404` for a package your registry doesn't have), plus the
contract above. A failed `add` leaves `config.json` unchanged and removes the
partial clone.

**Brazil / NpmPrettyMuch packages** usually carry internal-only devDependencies
(the template's `@amzn/brazil`, used just by a coverage `posttest`) that a public
or personal registry can't serve. Either move those to `optionalDependencies` —
npm skips an optional package it can't fetch, so `npm install` and `npm run
build` still pass (MPTSimWorkSources does this) — or commit the built entries so
no npm run is needed. Check it the way a user will:

```
git clone <your repo> /tmp/check && cd /tmp/check && npm install --omit=peer && npm run build
mpt plugins doctor ssh://git.example.com/you/your-plugin     # installs into a temp cache and checks it
```

## Testing your plugin

Before a plugin goes into a real team, check it with `mpt plugins doctor`. It
prints a ✓ / ⚠ / ✗ line per check, grouped by package and then by source, and
exits non-zero if anything failed (`--json` gives the same report as JSON).

```
mpt plugins doctor                         # every package in config.json
mpt plugins doctor ./mpt-acme-tracker      # one package: a path, a spec, or a configured identity —
                                           # it doesn't have to be configured
```

A spec that isn't configured or installed (`mpt plugins doctor
npm:mpt-acme-tracker`, or a git URL) is first installed into a temporary cache,
removed afterwards, so you can check a package straight from its registry or
repository without adding it.

On its own it is an **install check** — no network (beyond that install), no
`init`, no `sync`, and a factory is *not* called. It checks that the spec parses and the package is there,
that `package.json` has a valid `"mpt"` manifest, that each persona it ships is
usable (see [Distributing a persona package](#distributing-a-persona-package)), and that each source entry is
inside the package and **imports the way the daemon imports it**
(`my-pizza-team/plugin` resolving to this app). For an object export it also
checks `apiVersion`, the id's format, and that no other package (or built-in)
uses the id, and its personas: a `defaultPersona` or `triagePersona` that
isn't a team, built-in, or package persona is ⚠ (package personas are checked
against the configured packages' persona files), and a triage-mode source with no
triage persona — declared, or the team's `sourcePersonas` choice — is ✗, since the
daemon won't sync it. A failed import says why and, for the usual causes, what to do: a
native module built for another Node shows its `NODE_MODULE_VERSION` against this
Node's and tells you to rebuild the package with this Node (`npm rebuild`).

Add `--config` to also run the package **live**, once, on a throwaway context:

```
mpt plugins doctor ./mpt-acme-tracker --config '{"tokenEnv":"ACME_TOKEN"}'
mpt plugins doctor npm:mpt-acme-tracker --config team      # use its config from config.json
mpt plugins doctor ./mpt-acme-tracker --config '{}' --source acme --hooks
```

The factory is called with that config (frozen, as the daemon does), then each
source's `init` and `sync` run against a scratch context: a temp directory as
`teamDir`, an in-memory `kv`, `ctx.log` printed under the source, and queue calls
(`enqueue`, `enqueueRevision`, `upsertDef`) recorded but not applied — **your
team directory is never written**. Each item is listed (externalId, revision,
mode, title, url, directory) and checked: required fields, duplicate
externalIds, a mirror id the file system can hold. `sync` runs twice, and a
revision that changes when the content didn't (or the reverse) is a warning.
`--source <id>` runs just one source; `--hooks` also calls `onComment` and
`onItemTerminal` (with a fake completed item) on the first item — that is a real
write-back if your hooks do one, so point it at a test project. `--config` needs
exactly one package: name it when the team has several.

## Distributing a persona package

Personas you want to share between teams travel as a **plugin package** — the same npm package, git repository, or local folder a [Work Source plugin](#writing-a-work-source-plugin) uses, with or without any sources. Install one with `mpt plugins add` and restart the daemon; its personas appear on **Config → Personas** with the package's name as their badge, ready to pick anywhere.

### Layout

Persona files are ordinary persona markdown (frontmatter `title`, `description`, `tags`, optional `kinds`, then the instructions):

```
acme-mpt-personas/
├── package.json
└── personas/
    ├── reviewer.md
    └── implementer.md
```

### Manifest

List the files in `package.json` under `"mpt"`. Paths are relative to the package and must stay inside it; a `*` is allowed in the last part of a path only (`personas/*.md`, or name files one by one). A package can ship personas alone, or beside its `"sources"`:

```json
{
  "name": "acme-mpt-personas",
  "version": "1.2.0",
  "mpt": { "personas": ["personas/*.md"] }
}
```

### Naming

A package persona's id is `<package name>/<file name without .md>` — `acme-mpt-personas/reviewer`, or `@acme/personas/reviewer` for a scoped name. The `name` is required, and it's the package.json `name` (not how you installed it), so a workflow keeps working when you switch from a local checkout to npm or git. File names follow the team-id rules: lowercase letters, digits, and `-`. Two different packages with the same `name` can't both ship personas — the second one's are refused. A source in the same package can name its own personas (`defaultPersona: "acme-mpt-personas/implementer"`).

### Checking it

`mpt plugins doctor ./acme-mpt-personas` lists each persona with ✓, ⚠ for a lint warning (a top-level heading, a stray `---`), and ✗ for an unclosed code fence, a file outside the package or missing, a bad file name, no `name`, or a `name` another configured package already uses. `mpt plugins add` and `update` run the same checks and refuse a package with a ✗, leaving `config.json` as it was. `mpt plugins list` shows how many personas each package provides. A persona-only package needs no build: MPT never runs npm in a cloned persona-only repository.

### Versioning

Version the package like any other (semver tags for git, `version` for npm), and pin it in the spec (`npm:acme-mpt-personas@1.2.0`, `git:…@v1.2.0`) when you don't want updates; `mpt plugins update` re-fetches unpinned ones. New persona text takes effect after a daemon restart; work already running keeps the persona it started with, and each run's persona chip records what it actually got.

### Customizing and removing

Package personas are read-only for the teams that install them (they **Duplicate to
edit**), and `mpt plugins remove` lists what still uses them and what each will fall
back to — see [Personas from a package](guide/06-personas.md#personas-from-a-package).

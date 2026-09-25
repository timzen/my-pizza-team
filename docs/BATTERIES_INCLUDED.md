# Batteries Included — Plan

Make `mpt` the one thing you install. Today a working team needs a daemon *and*
a Pi extension installed, configured, and kept in lockstep by hand. This plan
folds the extension (`pi-pizza-team`) into this repo and this binary, so setup
is `mpt setup` and upgrades can't leave the two halves out of step.

Status: **proposal** — nothing here is built yet. Each phase stands on its own
and ships separately.

---

## 1. The problem

### 1.1 Setup is a scavenger hunt

Getting from nothing to a working team today:

1. Install the `mpt` binary; `mpt start` in a team dir.
2. Install Pi.
3. `pi install` pi-pizza-team (a path or a git URL).
4. `pi install npm:@gotgenes/pi-permission-system` — yolo mode quietly depends
   on it; without it, autonomous teammates stop on permission prompts.
5. Have tmux; trust the project folder; start a leader by running `pi` in the
   team dir.
6. Optionally `mpt install` (service) and a GitHub token (for `mpt upgrade` on
   shared-IP machines).

None of these steps checks the others. A missing piece shows up later as a
symptom (a teammate stuck on a prompt, a chat nobody answers), not as an error.

### 1.2 Two halves that must match, and nothing that notices when they don't

The daemon and the extension ship separately (`mpt upgrade` vs. `pi update` /
a local path), but they're one protocol. Real examples from recent work:

- The teammate watch view (docs/TEAMMATE_CHAT.md) needs the extension's
  transcript mirror; teammates started before the extension update streamed
  nothing, with no hint why.
- The usage ledger's `POST /api/agents/:id/usage` is only called by the new
  extension; an old one keeps working but silently records no chat/pairing
  usage and no cache tokens.
- A feature spanning both (teammate chat, usage) is a dozen commits across two
  repos that have to be released and installed together.

Shared protocol types are also duplicated (`shared/types.ts` here and
`pi-pizza-team/src/shared/types.ts`).

## 2. The target experience

```bash
# install mpt (one binary), then, in your project:
mpt setup     # checks + fixes prerequisites, installs the Pi extension, creates the team dir
mpt lead      # starts the leader in tmux (optional convenience)
```

`mpt upgrade` updates the daemon **and** the extension together. `mpt doctor`
re-runs the checks any time something seems off.

## 3. Phases

### Phase 1 — Version handshake + `mpt doctor`

Small, independent, and it turns silent skew into a visible message.

- **Handshake.** The extension sends its version on `POST /api/agents/register`
  (and the protocol version it speaks). The daemon stores it on the member and
  compares it to its own.
  - A mismatch shows in the UI (the Team tab row, and a banner): *"swift-ripley
    runs extension 0.16.0; the daemon is 0.17.0 — restart it."*
  - A protocol the daemon can't serve is refused with a clear error rather
    than half-working.
- **`mpt doctor`.** A checklist that prints one fix per problem:
  - Pi installed (and a supported version)
  - tmux installed
  - pi-pizza-team installed, and its version vs. the daemon's
  - `@gotgenes/pi-permission-system` installed (needed for autonomous yolo)
  - the team dir exists; the project folder is trusted by Pi
  - the daemon is running; a leader is connected; the service is installed
  - `GITHUB_TOKEN` set (only a hint — needed for `mpt upgrade` on shared IPs)

### Phase 2 — One repo, one version

Move `pi-pizza-team` into this repo (e.g. `extensions/pi/`).

- One version number (`deno.json`), one `scripts/publish.sh`, one release.
  Cross-cutting features land as one commit.
- Shared protocol types live in `shared/` and are imported by both the daemon
  and the extension (the extension's duplicate `src/shared/types.ts` goes away).
- The extension can still be published as a Pi package from this repo (its
  `package.json` with the `pi-package` keyword moves with it), so
  `pi install git:…` keeps working for people who want it standalone.
- Tests: the extension's suites run under Node's type stripping today; they can
  keep doing so from the monorepo (`deno task test:ext`), or move to Deno later.
- Git history can be preserved with `git subtree add` / a filter-repo merge.

### Phase 3 — `mpt` carries the extension; `mpt setup`

The binary already embeds `ui/dist/` (`deno compile --include`); embed the
extension's source the same way.

- **`mpt setup`** (idempotent — safe to re-run):
  1. Runs the Phase 1 checks and fixes what it can: `pi install
     npm:@gotgenes/pi-permission-system` if missing; offers to trust the folder.
  2. Writes the embedded extension to a managed, versioned directory
     (e.g. `~/.my-pizza-team/pi-extension/`) and registers that path in Pi's
     package list (`pi install <path>`), replacing any older pi-pizza-team
     entry so there's exactly one.
  3. Creates the team dir (as `mpt start` does today) and offers `mpt install`
     for the service.
  4. Prints the next step (`mpt lead`, or run `pi` in the project).
- **`mpt upgrade`** rewrites the managed extension directory after replacing the
  binary, so both halves move together; running agents pick it up on their next
  Pi restart (and the Phase 1 handshake shows which ones haven't yet).
- **`mpt setup --uninstall`** removes the managed extension and its Pi package
  entry, restoring Pi's settings as found.
- **Development** is unchanged: point Pi at the checkout
  (`pi install /path/to/my-pizza-team/extensions/pi`), and `mpt setup` detects a
  dev path and leaves it alone.

Constraint: Pi loads extensions as TypeScript files from disk (it strips types at
load), so "bundled" means *mpt writes them out* — the extension can't run inside
the mpt binary. That's fine; it just means setup must be careful and
reversible because it edits the user's Pi configuration.

### Phase 4 (optional) — `mpt lead`

Start the leader for you: ensure the tmux session exists, open a window in the
project dir, and run `pi` with the right flags (`--ppt-lead`, the daemon URL).
After this, `mpt` is the only command a user has to remember. The leader stays a
real Pi session (it's the agent you chat with, and it realizes spawns on its
host — DESIGN.md "One Agent to Talk To"); `mpt lead` only launches it.

## 4. Other harnesses

`mpt-mcp-server` (the non-Pi harness bridge) is the same shape — a separately
installed piece that must match the daemon's protocol. Once Phases 1–3 exist it
can follow the same path: live in this repo, share `shared/` types, be embedded
in the binary, and be installed or wired up by `mpt setup` for the harness the
user picks.

## 5. Open questions

- **Where does the managed extension live?** Under the user's home (one copy per
  machine, shared by every team) vs. inside the team dir (per team, committed?).
  Home is the natural fit: the extension is per-machine tooling, the team dir is
  team data.
- **Pi version compatibility.** The extension targets a Pi extension API; Phase
  1's `doctor` should check a minimum Pi version, and releases should state
  which Pi versions they were tested against.
- **The permission-system dependency.** Keep depending on
  `@gotgenes/pi-permission-system` (and install it in `mpt setup`), or make the
  extension degrade explicitly — e.g. warn loudly at teammate start that
  autonomous runs will prompt.
- **Upgrading a running team.** After `mpt upgrade`, agents keep the old
  extension until their Pi restarts. Should the daemon offer a "restart
  teammates" action (a `reset-session`-style directive per member) so an
  upgrade can roll the whole team from the UI?

## 6. Order and payoff

| Phase | Effort | Payoff |
| --- | --- | --- |
| 1. Handshake + `mpt doctor` | small | Skew and missing prerequisites become visible, with the fix |
| 2. One repo, one version | medium (mostly mechanical) | Atomic cross-cutting changes; one release; shared types |
| 3. Embedded extension + `mpt setup` | medium | Setup is one command; upgrades keep both halves in step |
| 4. `mpt lead` | small | One entry point for day-to-day use |

After Phase 3, setup is: install `mpt`, run `mpt setup` in your project, then
start the leader (`mpt lead`, or `pi`).

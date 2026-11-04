# Quick Start 🍕

Get a π pizza team running in about five minutes.

You'll need **tmux** (teammates run in tmux windows) and **Node.js 24+** (for mpt; Pi itself needs 22.19+).
Everything below runs in **your project folder** — the repository you want the team
to work on.

## 1. Install `mpt`

mpt is an npm package and needs **Node.js 24 or later**:

```bash
npm i -g my-pizza-team
```

Windows works too (daemon and web UI, no background service); teammates need tmux,
so run them under WSL. On macOS there is also an optional menu bar app (the DMG on
[GitHub Releases](https://github.com/timzen/my-pizza-team/releases/latest)); it runs
the mpt you installed with npm.

<details>
<summary>Or run it from source</summary>

```bash
git clone https://github.com/timzen/my-pizza-team.git
cd my-pizza-team
npm ci
npm run build              # web UI + compiled JS in dist/
npm i -g .                 # or: npm pack && npm i -g ./my-pizza-team-*.tgz
```

</details>

## 2. Install Pi

[Pi](https://pi.mariozechner.at/) is the coding agent your teammates run as:

```bash
npm install -g @earendil-works/pi-coding-agent
```

**Recommended:** the permission system, which lets teammates work autonomously.
Without it they stop at the first permission prompt and wait for you:

```bash
pi install npm:@gotgenes/pi-permission-system
```

## 3. Set up

```bash
cd <your project>
mpt setup --dry-run     # see what it will change (changes nothing)
mpt setup               # do it
```

`mpt setup` installs the Pi extension that ships inside `mpt` (so the two always match
versions), creates the team directory `.my-pizza-team/`, and marks the folder trusted
by Pi. It prints every change before making it, and `mpt setup --uninstall` undoes
them. The first time, it also asks which Node should run mpt (press Enter for the
one you're using) and saves it to `~/.config/mpt/runtime.json` — see
[Which Node runs mpt](README.md#which-node-runs-mpt).

A new team starts with **Tasks** only: Stories and Schedules are switched off until
you turn them on under **Config → General → Work items** (or with `"features"` in
`.my-pizza-team/config.json`; see [Feature toggles](README.md#feature-toggles)). A
team directory that already existed keeps everything on.

## 4. Start the daemon, then the assistant

```bash
mpt start --daemon
```

The daemon runs in the background and serves the web UI at
**http://localhost:7437/**. Open it: a new team's home page has a **Welcome
checklist**, and its first step is **Start the assistant** — the agent you chat
with. Click it; the daemon opens the assistant in a tmux window in your project
folder, and the step ticks off once it connects (a few seconds). If the daemon
can't start it (for example it can't reach tmux), the button is replaced by the
reason and the command that fixes it.

The checklist then walks you through the rest — a first teammate, a one-click
sample task, watching it run, reviewing it in the Inbox — and ticks each step off
as you do it. Until you're through it, `mpt start --daemon` ends by pointing you there.

<details>
<summary>Or start the assistant from a terminal</summary>

```bash
mpt assistant           # alias: mpt lead
```

It opens the same assistant (in a tmux window named `leader`) and attaches you to
it; detach with `Ctrl-b d`, and `mpt assistant` again reattaches. Already inside
tmux, it switches your client to that window instead. It never starts a second
assistant: if the web UI already started one, it just attaches. (A team that uses
[herdr](docs/guide/08-configuration.md) instead of tmux gets a `leader` tab and a
herdr client; see that page.)

</details>

## 5. Check everything

```bash
mpt doctor
```

A read-only checklist of Pi, tmux, the extension, the permission system, trust, the
daemon, and the assistant — with the command that fixes each problem. Run it whenever
something seems off.

---

## Next steps

- **Set your team size** — the people icon next to **Team** (or **Min Teammates** on
  Config › General); the daemon keeps that many teammates online.
- **Create a story** — turn Stories on (**Config → General → Work items**), then
  **New Story** on the home page (pick a workflow), and add tasks to it.
- **Run standalone work** — the **Tasks** page for one-off jobs, **Schedule** for
  cron-driven ones.
- **Configure workflows** — **Config → Workflows** customises states and picks
  each agent state's persona; write and edit personas on **Config → Personas**.
- **Try other agents (experimental)** — Kiro and Claude Code can run as teammates too:
  `mpt setup --harness kiro` (or `claude`), then turn on **Config → Teammates →
  Experimental Harnesses** and pick the harness in the **Spawn** dialog. See
  [Other harnesses](README.md#other-harnesses) in the README.
- **Give agents environment variables** — put `KEY=value` lines in one file and name
  it in **Config → General → Agent Env File** (`agentEnvFile`); every teammate and
  assistant window mpt opens gets them, with no restart after an edit. See
  [Agent environment file](docs/guide/08-configuration.md#agent-environment-file).
- **Stay current** — `mpt upgrade` updates `mpt` *and* its Pi extension together.
  Restart running agents afterwards; the Team tab flags any still on the old version
  and can restart them.
- **Read the full docs** — the [user guide](docs/guide/00-getting-started.md) (also the in-app **Help**
  page) for using the web UI, [README.md](README.md) for the CLI, configuration, and protocol.

> **Your team's data lives in `.my-pizza-team/`.** If your project is a git repository,
> mpt autosaves that directory into it periodically (only that directory — your own
> work is never included). Turn it off with `autosave.autoCommit: false` in
> `.my-pizza-team/config.json`.

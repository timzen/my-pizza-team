# Quick Start 🍕

Get a π pizza team running in about five minutes.

You'll need **tmux** (teammates run in tmux windows) and **Node.js 22.19+** (for Pi).
Everything below runs in **your project folder** — the repository you want the team
to work on.

## 1. Install `mpt`

Download the binary for your platform from
[GitHub Releases](https://github.com/timzen/my-pizza-team/releases/latest). You need
**mpt 0.18.0 or later** — earlier releases don't have `setup`, `doctor`, or `lead`.

| Platform | Asset |
|----------|-------|
| macOS (Apple Silicon) | `mpt-darwin-arm64` |
| macOS (Intel) | `mpt-darwin-x64` |
| Linux (x64) | `mpt-linux-x64` |
| Linux (ARM64) | `mpt-linux-arm64` |
| Windows (x64) | `mpt-windows-x64.exe` — daemon and web UI; teammates need tmux, so run them under WSL |

```bash
# Example: macOS Apple Silicon
curl -L -o mpt https://github.com/timzen/my-pizza-team/releases/latest/download/mpt-darwin-arm64
chmod +x mpt
sudo mv mpt /usr/local/bin/
```

<details>
<summary>Or build it from source</summary>

Needs [Deno](https://deno.com) 2 and Node.js (the web UI is built with npm).

```bash
git clone https://github.com/timzen/my-pizza-team.git
cd my-pizza-team
(cd ui && npm ci)
deno task compile          # produces ./mpt, with the web UI and Pi extension inside
sudo mv mpt /usr/local/bin/
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
them.

## 4. Start the daemon

```bash
mpt start --daemon
```

The daemon runs in the background and serves the web UI at
**http://localhost:7437/**.

## 5. Start the leader

```bash
mpt lead
```

This opens the leader in a tmux window and attaches you to it. The leader is the agent
you chat with — in that window or in the web UI, which is one conversation. Detach
with `Ctrl-b d`; `mpt lead` again reattaches.

## 6. Check everything

```bash
mpt doctor
```

A read-only checklist of Pi, tmux, the extension, the permission system, trust, the
daemon, and the leader — with the command that fixes each problem. Run it whenever
something seems off.

---

## Next steps

- **Set your team size** — click the people icon next to **Team** in the teammate
  column (or **Min Teammates** on Config › General). The daemon keeps that many
  teammates online, starting them in tmux windows you can watch with
  `tmux attach -t my-pizza-team`. The person-plus icon adds a one-off teammate in a specific
  directory — teammates prefer work in their own directory.
- **Create a story** — **New Story** on the home page (pick a workflow), then add
  tasks to it.
- **Run standalone work** — the **Tasks** page for one-off jobs, **Schedule** for
  cron-driven ones.
- **Review results** — completed work lands in the **Inbox** on the home page.
- **Configure workflows** — the Workflows tab (under Board) customises states and
  their personas.
- **Stay current** — `mpt upgrade` updates `mpt` *and* its Pi extension together.
  Restart running agents afterwards; the Team tab flags any still on the old version
  and can restart them.
- **Read the full docs** — [README.md](README.md) for configuration and internals, or
  the in-app **Help** for the user guide.

> **Your team's data lives in `.my-pizza-team/`.** If your project is a git repository,
> mpt autosaves that directory into it periodically (only that directory — your own
> work is never included). Turn it off with `autosave.autoCommit: false` in
> `.my-pizza-team/config.json`.

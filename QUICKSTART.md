# Quick Start 🍕

Get a π pizza team running in under 5 minutes.

## 1. Get the `mpt` executable

Download the prebuilt binary for your platform from [GitHub Releases](https://github.com/timzen/my-pizza-team/releases/latest):

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `mpt-darwin-arm64` |
| macOS (Intel) | `mpt-darwin-x64` |
| Linux (x64) | `mpt-linux-x64` |

```bash
# Example: macOS Apple Silicon
curl -L -o mpt https://github.com/timzen/my-pizza-team/releases/latest/download/mpt-darwin-arm64
chmod +x mpt
sudo mv mpt /usr/local/bin/
```

Or run from source with Deno:

```bash
git clone https://github.com/timzen/my-pizza-team.git
cd my-pizza-team
deno task start
```

## 2. Get Pi

Install [Pi](https://pi.mariozechner.at/), the coding agent harness:

```bash
npm install -g @earendil-works/pi-coding-agent
```

## 3. Install the pi-pizza-team extension

```bash
pi install git:github.com/timzen/pi-pizza-team
```

This adds the leader/teammate integration that connects Pi to the daemon.

## 4. Create a team directory

```bash
mkdir my-team && cd my-team
git init
```

The daemon stores stories, tasks, workflows, and knowledge in a `.pi-pizza-team/` directory, auto-created on first run.

## 5. Start the daemon

```bash
mpt start --daemon
```

This starts the daemon in the background. It will:
- Create `.pi-pizza-team/` with default config and workflows
- Serve the API and web UI on `http://localhost:7437`

## 6. Run Pi

```bash
pi
```

Pi auto-detects the `.pi-pizza-team/` directory and activates leader mode. Create stories, spawn teammates, and manage your board.

## 7. Open the UI

Visit **http://localhost:7437/** to see the board, manage stories, configure workflows, and monitor your team.

---

## Next steps

- **Create a story** — via the UI board page (requires selecting a workflow)
- **Spawn teammates** — use the Spawn button in the UI or `/ppt-spawn` in Pi
- **Configure workflows** — visit the Workflows page to customize states and transitions
- **Read the full docs** — see [README.md](README.md) for configuration, workflows, and harness guides

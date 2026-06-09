# Quick Start Guide 🍕

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
sudo mv mpt /usr/local/bin/   # or anywhere on your PATH
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

## 4. Create a git repository for your team

```bash
git clone ssh://git.service.com/username/my-team
cd my-team
```

This is where the daemon will store stories, tasks, workflows, and knowledge. The `.my-pizza-team/` directory is auto-created on first run and committed alongside your project.

## 5. Start the daemon

```bash
mpt start --daemon
```

This starts the daemon in the background. It will:
- Create `.my-pizza-team/` with default config, workflows, and database
- Serve the API and web UI on `http://localhost:7437`

## 6. Run Pi

```bash
pi
```

Pi auto-detects the `.my-pizza-team/` directory and activates leader mode. You can now create stories, spawn teammates, and manage your board from the Pi session.

## 7. Open the UI

Visit **[http://localhost:7437/](http://localhost:7437/)** in your browser to see the board, manage stories, configure workflows, and monitor your team.

---

## What's next?

- **Create a story** — via the UI or from Pi: `/ppt-spawn` to hire teammates
- **Configure workflows** — visit the Workflows page to customize states and transitions
- **Add teammates** — `/ppt-spawn` in Pi or use the Agents page in the UI
- **Read the docs** — [Configuration](configuration.md) | [Workflows](workflows.md) | [Architecture](ARCHITECTURE.md)

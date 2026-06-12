# my-pizza-team 🍕

> Because the industry has "two pizza teams" and "one pizza teams", but we're a **π pizza team** (3.14 pizzas, the perfect size).

A daemon for multi-agent team coordination. Manages stories, tasks, workflows, and agent lifecycle. Connects to coding agent harnesses (Pi, Claude Code, Codex) to orchestrate autonomous teammates.

## Quick Start

```bash
# 1. Install Deno (if you don't have it)
curl -fsSL https://deno.land/install.sh | sh

# 2. Clone and start
git clone https://github.com/timzen/my-pizza-team.git
cd my-pizza-team
deno task start

# 3. Open the UI
open http://localhost:7437
```

Or use the prebuilt binary (no Deno required):

```bash
# Download for your platform (from GitHub Releases)
curl -L -o mpt https://github.com/timzen/my-pizza-team/releases/latest/download/mpt-darwin-arm64
chmod +x mpt
./mpt
```

### macOS Menu Bar App

A native menu bar app with start/stop controls and team directory picker:

```bash
./scripts/build.sh darwin-arm64
./scripts/package-macos-menubar.sh
open "dist/My Pizza Team.app"
```

## What It Does

```
┌─────────────────────────────────────────────────────────────────┐
│                        mpt daemon                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │  Stories  │  │  Tasks   │  │ Workflow  │  │  Knowledge   │   │
│  │  & Board  │  │ & Claims │  │  Engine   │  │    Base      │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                         HTTP API                                 │
└─────────────────┬───────────────┬───────────────┬───────────────┘
                  │               │               │
         ┌────────┘        ┌──────┘        ┌──────┘
         ▼                 ▼               ▼
   ┌──────────┐      ┌──────────┐   ┌──────────┐
   │  Pi Lead │      │ Claude   │   │  Codex   │
   │  + Team  │      │  Code    │   │ Wrapper  │
   └──────────┘      └──────────┘   └──────────┘
```

- **You** create stories and tasks via the web UI or API
- **Agent harnesses** poll for work, claim tasks, transition through workflow states
- **The daemon** enforces workflow rules, manages assignments, tracks progress

## CLI Reference

```
mpt <command> [options]

Commands:
  start [--daemon|-d]   Start the daemon (foreground, or background with -d)
  stop                  Stop the running daemon
  status                Check if daemon is running + show summary
  upgrade               Migrate legacy team dir to current format
  rotate-token          Generate a new API token
  install               Install as system service (auto-start on login)
  uninstall             Remove system service

Environment:
  TEAM_DIR    Team directory or its parent (default: ./.pi-pizza-team)
  PORT        Daemon port (default: 7437)
  HOST        Bind address (default: 127.0.0.1)
```

## Configuration

The daemon reads `.pi-pizza-team/config.json`. Minimal:

```json
{
  "port": 7437,
  "defaultWorkflow": "default"
}
```

Workflows are defined in the `workflows/` directory with per-state transition instructions:

```
.pi-pizza-team/
├── config.json
└── workflows/
    └── default/
        ├── workflow.json       # States + transitions
        ├── in_progress.md     # Instructions for agents entering this state
        └── leader_review.md   # Instructions for entering review
```

📖 **Full details:** [docs/configuration.md](docs/configuration.md) | [docs/workflows.md](docs/workflows.md)

## API Overview

| Group | Endpoints | Purpose |
|-------|-----------|---------|
| Health | `GET /health` | Uptime, agents, queue depth, memory |
| Stories | `/api/stories/*` | CRUD for stories |
| Tasks | `/api/tasks/*` | CRUD + status transitions + attachments |
| Agents | `/api/agents/*` | Register, heartbeat, claim, transition, release |
| Team | `/api/team/*` | Join, heartbeat, list members |
| Assistant | `/api/assistant/*` | Queue + knowledge base |
| Control | `/api/control/*` | Pause/resume task distribution |

### Agent Protocol

```
1. POST /api/agents/register       → { agentId }
2. GET  /api/agents/next-work      → { task, availableTransitions }
3. POST /api/agents/claim/:id      → assigns + transitions to working state
4. (agent does the work)
5. POST /api/agents/release/:id    → advances state, stores result, releases
6. POST /api/agents/heartbeat      → keep-alive (dismissed:true = shut down)
```

📖 **Full API:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#api-routes)

## Documentation

| Doc | Description |
|-----|-------------|
| [Configuration](docs/configuration.md) | Full config.json reference, env vars, directory layout |
| [Workflows](docs/workflows.md) | Workflow definitions, transitions, instructions |
| [Architecture](docs/ARCHITECTURE.md) | Module map, API routes, data flow, design decisions |
| [Design](docs/DESIGN.md) | Philosophy, principles, change log |

### Harness Setup Guides

| Guide | Description |
|-------|-------------|
| [Pi Adapter](docs/guides/pi-adapter.md) | Native Pi extension (leader + teammates) |
| [Claude Code + MCP](docs/guides/claude-code-mcp.md) | MCP server bridge for Claude Code |
| [Codex Wrapper](docs/guides/codex-wrapper.md) | Shell-based Codex CLI runner |

## Project Structure

```
my-pizza-team/
├── daemon/            # HTTP server (Hono on Deno.serve)
├── cli/               # CLI (start/stop/status/install/upgrade/rotate-token)
├── ui/                # Frontend (React + Vite + shadcn/ui)
├── shared/            # Shared types, utilities, protocol contracts
├── desktop/           # Native platform tray/menu bar apps
│   ├── macos/         # SwiftUI menu bar app
│   └── windows/       # PowerShell system tray app
├── scripts/           # Build, cross-compile, and packaging scripts
├── .github/workflows/ # CI + release automation
├── tests/             # Integration and unit tests
└── docs/              # Documentation
```

## Development

```bash
deno task dev          # Auto-reload daemon
deno task ui:dev       # Vite dev server for UI
deno task test         # Run tests
deno task check        # Type-check
```

## Building & Releases

```bash
deno task compile              # Single binary (current platform)
deno task compile:all          # All platforms → dist/
./scripts/package-macos-menubar.sh  # macOS .app with menu bar
```

Tag a version to trigger a GitHub Release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## License

MIT

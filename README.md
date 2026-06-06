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
mpt v0.1.0 — my-pizza-team CLI

Usage:
  mpt <command> [options]

Commands:
  start [--daemon|-d]   Start the daemon (foreground, or background with -d)
  stop                  Stop the running daemon (sends SIGTERM)
  status                Check if daemon is running and show summary
  install               Install as system service (auto-start on login)
  uninstall             Remove system service and disable auto-start

Environment:
  TEAM_DIR              Team directory (default: ./.pi-pizza-team)
  PORT                  Daemon port (default: 7437)
```

### Examples

```bash
mpt start              # Foreground (Ctrl+C to stop)
mpt start --daemon     # Background
mpt status             # Is it running? Show stats.
mpt stop               # Graceful shutdown

mpt install            # Auto-start on login (launchd/systemd)
mpt uninstall          # Remove auto-start

# Custom port and team directory
PORT=8080 TEAM_DIR=~/my-project/.team mpt start
```

## Configuration

The daemon reads `config.json` from the team directory (default: `.pi-pizza-team/config.json`).

```jsonc
{
  // Server settings
  "port": 7437,
  "leaderUrl": "http://localhost:7437",

  // Team settings
  "tmuxSession": "pi-pizza-team",
  "maxTeammates": 4,

  // Workflow
  "defaultWorkflow": "default",
  "workflows": {
    "default": {
      "states": ["todo", "in_progress", "needs_input", "review", "done"],
      "transitions": {
        "todo": { "in_progress": "any" },
        "in_progress": { "needs_input": "teammate", "review": "teammate" },
        "needs_input": { "in_progress": "lead" },
        "review": { "done": "lead", "in_progress": "lead" }
      }
    }
  },

  // Autosave (git checkpoint)
  "autosave": {
    "flushIntervalMinutes": 30,
    "commitIntervalHours": 24,
    "commitMessage": "pi-pizza-team: checkpoint {timestamp}",
    "autoCommit": true
  },

  // Knowledge base categories
  "categories": ["coding", "research", "doc-writing"],

  // Agent heartbeat timeout (seconds)
  "agentTimeoutSeconds": 90,

  // Teammate name generation
  "teammates": {
    "nouns": ["ripley", "deckard", "sarah", "neo"],
    "favoriteDirectories": ["/Users/you/projects/frontend", "/Users/you/projects/api"]
  },

  // Multi-machine host configs
  "hosts": {
    "macbook": {
      "favoriteDirectories": ["/Users/you/work"],
      "tmuxSession": "pizza-mac"
    },
    "server": {
      "favoriteDirectories": ["/home/you/work"],
      "tmuxSession": "pizza-server"
    }
  }
}
```

### Workflow Permissions

Transitions are gated by permission:
- `"any"` — both lead and teammate can transition
- `"teammate"` — only agents can transition (autonomous work)
- `"lead"` — only the human lead can transition (review gates)

## API Overview

The full API is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#api-routes). Key endpoint groups:

| Group | Endpoints | Purpose |
|-------|-----------|---------|
| Health | `GET /health` | Uptime, agents, queue depth, memory, last commit |
| Stories | `GET/POST/PUT/DELETE /api/stories` | CRUD for stories |
| Tasks | `GET/POST/PUT/DELETE /api/tasks` | CRUD + status transitions |
| Agents | `/api/agents/*` | Register, heartbeat, claim, transition, release |
| Team | `/api/team/*` | Join, heartbeat, list members |
| Assistant | `/api/assistant/*` | Queue + knowledge base |
| Control | `/api/control/*` | Pause/resume task distribution |

### Agent Protocol (for harness implementors)

```
1. POST /api/agents/register     → { agentId }
2. GET  /api/agents/next-work    → { task, availableTransitions }
3. POST /api/agents/claim/:id    → assigns ownership
4. POST /api/agents/transition/:id → advances state
5. POST /api/agents/release/:id  → hands back when blocked
6. POST /api/agents/heartbeat    → keep-alive (every 30s)
```

See [Agent Lifecycle](docs/ARCHITECTURE.md#agent-lifecycle) for details.

## Harness Setup Guides

- **[Pi Adapter](docs/guides/pi-adapter.md)** — The native Pi extension for team lead + autonomous teammates
- **[Claude Code + MCP](docs/guides/claude-code-mcp.md)** — Using Claude Code with MCP server bridge
- **[Codex Wrapper](docs/guides/codex-wrapper.md)** — OpenAI Codex CLI integration

## Project Structure

```
my-pizza-team/
├── deno.json          # Project config, tasks, import map
├── daemon/            # HTTP server (Hono on Deno.serve)
│   ├── main.ts        # Entry point — starts the server
│   ├── app.ts         # Hono app and route registration
│   ├── server.ts      # All API route handlers
│   └── store.ts       # SQLite data layer (jsr:@db/sqlite)
├── cli/               # Command-line interface
│   ├── main.ts        # CLI entry point (start/stop/status/install)
│   └── service.ts     # Platform service installer (launchd/systemd)
├── ui/                # Frontend (React + Vite + shadcn/ui)
├── shared/            # Shared types, utilities, protocol contracts
├── scripts/           # Build and automation scripts
│   └── build.sh       # Cross-compilation build script
├── .github/workflows/ # CI/CD pipelines
│   ├── ci.yml         # Type check + tests on PR/push
│   └── release.yml    # Cross-compile + GitHub Release on tags
├── tests/             # Integration and unit tests
└── docs/              # Architecture, design, guides
```

## Development

```bash
# Dev mode (auto-reload on changes)
deno task dev

# Run tests
deno task test

# Type-check
deno task check

# UI development (separate terminal)
deno task ui:dev
```

## Building & Releases

```bash
# Single binary for current platform
deno task compile

# Cross-compile all platforms → dist/
deno task compile:all

# Or specific targets
deno task compile:darwin-arm64
deno task compile:linux-x64
```

Tag a version to trigger a GitHub Release with all binaries:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## License

MIT

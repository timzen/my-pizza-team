# Configuration Reference

The daemon reads `config.json` from the team directory (`.pi-pizza-team/config.json`).

## Minimal Config

```json
{
  "port": 7437,
  "defaultWorkflow": "default"
}
```

Everything else has sensible defaults.

## Full Reference

```jsonc
{
  // ─── Server ────────────────────────────────────────────────────
  "port": 7437,                          // HTTP port
  "leaderUrl": "http://localhost:7437",   // URL agents use to reach the daemon

  // ─── Authentication ────────────────────────────────────────────
  "apiToken": "your-secret-token",       // Optional; required if binding 0.0.0.0
                                          // Override with MPT_API_TOKEN env

  // ─── Workflow ──────────────────────────────────────────────────
  "defaultWorkflow": "default",           // Which workflow new stories use
  // Inline workflows (legacy — prefer workflows/ directory instead)
  // See docs/workflows.md for the directory-based approach
  "workflows": { ... },

  // ─── Team ──────────────────────────────────────────────────────
  "tmuxSession": "pi-pizza-team",         // tmux session name for spawning agents
  "maxTeammates": 4,                      // Max concurrent agents (advisory)
  "agentTimeoutSeconds": 90,              // Heartbeat timeout before marking offline

  // ─── Autosave ─────────────────────────────────────────────────
  "autosave": {
    "flushIntervalMinutes": 30,           // How often to write dirty tasks to disk
    "commitIntervalHours": 24,            // How often to git commit
    "commitMessage": "pi-pizza-team: checkpoint {timestamp}",
    "autoCommit": true                    // Enable/disable git auto-commit
  },

  // ─── Knowledge Base ────────────────────────────────────────────
  "categories": ["coding", "research", "doc-writing"],

  // ─── Teammates ─────────────────────────────────────────────────
  "teammates": {
    "nouns": ["ripley", "deckard", "neo"],        // Name generation pool
    "favoriteDirectories": ["/path/to/project"]   // Quick-spawn directories
  },

  // ─── Multi-Machine Hosts ──────────────────────────────────────
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAM_DIR` | `./.pi-pizza-team` | Path to team dir (or its parent) |
| `PORT` | `7437` | Daemon HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` requires apiToken) |
| `MPT_API_TOKEN` | — | Overrides config.apiToken |
| `UI_DIST` | — | Override UI static files path |

`TEAM_DIR` accepts either the `.pi-pizza-team` directory itself or its parent (auto-detects).

## Team Directory Layout

```
.pi-pizza-team/
├── config.json          # This file
├── daemon.pid           # PID of running daemon
├── store.db             # SQLite database (runtime index)
├── workflows/           # Workflow definitions
│   └── default/
│       ├── workflow.json
│       └── *.md         # Transition instructions
├── stories/             # Active stories + tasks (JSON on disk)
│   └── my-story/
│       ├── story.json
│       └── tasks/
│           └── 01-task-slug/
│               ├── task.json
│               ├── comments.jsonl
│               └── attachments/
├── archived/            # Completed stories
└── notes/               # Knowledge base markdown files
```

## Security

- **Localhost only by default** — binds `127.0.0.1`, not `0.0.0.0`
- **Token required for network** — refuses to bind `0.0.0.0` without `apiToken`
- **Auth methods** — Bearer token, Basic auth (web UI), `?token=` query param
- **`/health` always public** — for monitoring without credentials
- **Generate a token** — `mpt rotate-token`

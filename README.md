# my-pizza-team

A team coordination tool built with Deno and Hono.

## Prerequisites

- [Deno](https://deno.land/) v2+

## Project Structure

```
my-pizza-team/
├── deno.json          # Project config, tasks, import map
├── daemon/            # HTTP server (Hono on Deno.serve)
│   ├── main.ts        # Entry point — starts the server
│   ├── app.ts         # Hono app and route registration
│   └── store.ts       # SQLite data layer (jsr:@db/sqlite)
├── cli/               # Command-line interface
│   └── main.ts        # CLI entry point
├── ui/                # Frontend (React + Vite + shadcn/ui)
│   ├── src/           # React source (App, pages, components)
│   ├── vite.config.ts # Vite config with API proxy
│   └── package.json   # UI dependencies
├── shared/            # Types and utilities shared across modules
│   ├── types.ts       # Common type definitions, workflow helpers
│   └── frontmatter.ts # Frontmatter parsing for memory notes
├── tests/             # Test files
│   ├── health.test.ts # Health endpoint test
│   └── store.test.ts  # Store CRUD and workflow tests
└── docs/              # Documentation
    ├── ARCHITECTURE.md
    └── DESIGN.md
```

## Usage

```bash
# Start the daemon (dev mode with watch)
deno task dev

# Start the daemon (production)
deno task start

# Start the UI (dev mode with Vite)
deno task ui:dev

# Build the UI for production
deno task ui:build

# Compile single binary (builds UI + compiles daemon with embedded assets)
deno task compile

# Run the compiled binary
./mpt

# Run tests
deno task test

# Type-check
deno task check
```

## Service Installation (Auto-Start)

`mpt install` registers the daemon as a system service that starts automatically on login:

```bash
# Install as auto-start service
mpt install

# Remove the service
mpt uninstall
```

**macOS (launchd):**
- Generates a user-level plist at `~/Library/LaunchAgents/com.my-pizza-team.daemon.plist`
- Logs to `~/.local/share/my-pizza-team/logs/`
- Restarts on crash (KeepAlive on non-zero exit)
- Manage with `launchctl start/stop com.my-pizza-team.daemon`

**Linux (systemd):**
- Generates a user unit at `~/.config/systemd/user/my-pizza-team.service`
- Restarts on failure with 5s delay
- Enables lingering for start without active login session
- Manage with `systemctl --user start/stop/status my-pizza-team.service`

Both respect `TEAM_DIR` and `PORT` environment variables at install time.

## Building

The project can be compiled into a single self-contained binary:

```bash
deno task compile
```

This produces a `./mpt` binary (~70MB on macOS arm64) that:
- Embeds the React UI (served at `/`)
- Runs the Hono HTTP API
- Manages SQLite via native FFI
- Requires no runtime dependencies (no Deno, no Node.js)

## API Endpoints

| Method | Path      | Description          |
|--------|-----------|----------------------|
| GET    | `/health` | Health check (uptime, agents, queue depth, memory, last commit) |

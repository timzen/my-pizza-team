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
│   └── app.ts         # Hono app and route registration
├── cli/               # Command-line interface
│   └── main.ts        # CLI entry point
├── ui/                # Frontend (TBD)
├── shared/            # Types and utilities shared across modules
│   └── types.ts       # Common type definitions
├── tests/             # Test files
│   └── health.test.ts # Health endpoint test
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

# Run tests
deno task test

# Type-check
deno task check
```

## API Endpoints

| Method | Path      | Description          |
|--------|-----------|----------------------|
| GET    | `/health` | Health check (returns `{ status: "ok" }`) |

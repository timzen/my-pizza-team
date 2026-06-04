# AGENTS.md

Instructions for AI coding agents working on this project.

## Before Starting Work

1. **Read the docs first.** Before making any changes, read these files to understand the current state:
   - `README.md` — user-facing overview, features, directory structure, usage
   - `docs/ARCHITECTURE.md` — internal structure, module map, data flow, API routes, design decisions
   - `docs/DESIGN.md` — design philosophy, principles, rationale

2. **Understand the context.** Check relevant source files and tests before modifying code. Use the module map in ARCHITECTURE.md to find what you need.

## While Working

### Code Documentation

- **Every file** must have a top-level comment explaining its purpose (see existing files for the pattern)
- **Every public method** must have a clear purpose evident from its name, or a JSDoc/comment if the name isn't sufficient
- **Complex logic** must have inline comments explaining *why*, not just *what*
- **Non-obvious design decisions** should reference the relevant section in DESIGN.md or ARCHITECTURE.md

### Code Style

- Follow existing patterns in the codebase (naming, structure, error handling)
- Keep functions focused — one clear responsibility each
- Use TypeScript types fully (no `any` unless interfacing with untyped libraries)
- Export only what's needed; keep implementation details private

## After Making Changes

1. **Update the docs.** Every change that affects the project's behavior, structure, or API must be reflected in:
   - `README.md` — if it changes user-facing behavior, commands, UI, directory structure, or setup
   - `docs/ARCHITECTURE.md` — if it changes modules, API routes, data flow, schema, or internal design decisions
   - `docs/DESIGN.md` — if it introduces new design principles or changes existing rationale

2. **Don't skip this step.** Documentation rot is worse than no documentation. If you add a feature, add its docs in the same commit.

3. **Write or update tests.** New functionality should have tests in `tests/`. Follow the existing pattern (see `tests/archive.test.mjs` for a good example).

## Project Structure Reference

```
mpt-mcp-server/
├── README.md                 # User-facing docs (keep updated!)
├── docs/
│   ├── ARCHITECTURE.md       # Internal technical docs (keep updated!)
│   └── DESIGN.md             # Design philosophy (keep updated!)
├── src/
└── tests/                    # Tests (node tests/*.test.mjs)
```

## Reference

Original code can be found at

- git: https://github.com/timzen/pi-pizza-team.git
- local: /Users/timvance/Workspace/pi-pizza-team

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
- **Every public method** must have a clear purpose evident from its name and a JSDoc/comment explaining what it does and why to use it
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
   - `QUICKSTART.md` — if it changes the getting-started flow
   - `GUIDE.md` — if it changes what a user sees or does in the web UI
   - `docs/ARCHITECTURE.md` — if it changes modules, API routes, data flow, schema, or internal design decisions
   - `docs/DESIGN.md` — if it introduces new design principles or changes existing rationale

2. **Don't skip this step.** Documentation rot is worse than no documentation. If you add a feature, add its docs in the same commit.

3. **Write or update tests.** New functionality should have tests in `tests/`. Follow the existing pattern (see `tests/templates.test.ts` for a good example; slow tests that need real git/tmux go in `tests/e2e/`).

## Project Structure Reference

```
my-pizza-team/
├── README.md                 # User-facing docs (keep updated!)
├── QUICKSTART.md             # Getting started guide (keep updated!)
├── GUIDE.md                  # User guide, rendered as the in-app Help page (keep updated!)
├── TODO.md                   # Known code issues and deferred work
├── docs/
│   ├── ARCHITECTURE.md       # Internal technical docs (keep updated!)
│   └── DESIGN.md             # Design philosophy (keep updated!)
├── daemon/
│   ├── server.ts             # Route orchestrator
│   ├── store.ts              # SQLite data layer
│   └── routes/               # Route modules
├── ui/                       # React frontend
├── shared/                   # Types, protocol, utilities
├── harnesses/
│   └── pi/                   # The Pi extension (its own package.json; npm test)
├── scripts/                  # publish, macOS app packaging, sync-version
└── tests/                    # Fast tests (npm test, node:test); tests/e2e/ is the slow suite
                              #   (npm run test:e2e) — real git, tmux, and shell
```

## Development Workflow

The whole repo runs on Node.js (>=24) with npm; there is no other toolchain. In a
checkout Node runs the `.ts` sources directly (type stripping), so keep to
erasable TypeScript (no enums, namespaces or parameter properties —
`tsconfig.json` enforces it) and import local files with their `.ts` extension.

```bash
npm install              # once, at the root
npm run dev              # auto-reloading daemon from source
npm run mpt -- <cmd>     # the CLI from source
npm run ui:dev           # Vite dev server for the UI
```

Gates — run before you consider a change done:

```bash
npm run check            # typecheck + generated files (version, shared constants) in step
npm test                 # fast suite (node:test)
npm run test:e2e         # slow suite: real git, tmux, shell
npm run typecheck:ext    # the Pi extension
npm run test:ext         # the Pi extension's suites
(cd ui && npx tsc -b)    # the web UI
npm pack                 # when touching packaging: builds dist/ and the tarball
```

The extension under `harnesses/pi/` is its own npm package, with its own
`tsconfig.json`, `package.json`, and suites (run from the root as above). The root
`package.json` owns the version; the extension's version and the lockfile's are
generated from it — never edit them by hand (`npm run sync-version`). Its shared
constants are generated from `shared/types.ts` (`npm run sync-shared`).

## Reference

The extension used to live in its own repo. It was merged into `harnesses/pi/`
(task P1a-1); that repo is archived at the tag `archive/pi-pizza-team`. Its
pre-merge history is in this repo too — `git subtree add` records no rename, so
browse it from the merge-point tag using the original paths:

```bash
git log premerge/pi-pizza-team -- src/client.ts
git show premerge/pi-pizza-team:src/leader.ts
```

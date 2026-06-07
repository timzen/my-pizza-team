# Workflows

Workflows define the states tasks move through and who can trigger each transition.

## Directory Structure

Workflows live in `.pi-pizza-team/workflows/<name>/`:

```
.pi-pizza-team/
├── config.json              # References defaultWorkflow
└── workflows/
    └── default/
        ├── workflow.json    # States + transitions
        ├── todo.md          # Instructions shown when entering "todo"
        ├── in_progress.md   # Instructions shown when entering "in_progress"
        ├── leader_review.md # Instructions shown when entering "leader_review"
        └── done.md          # Instructions shown when entering "done"
```

## workflow.json

```json
{
  "states": ["todo", "in_progress", "leader_review", "done"],
  "transitions": {
    "todo": { "in_progress": "any" },
    "in_progress": { "leader_review": "teammate" },
    "leader_review": { "done": "lead", "in_progress": "lead" }
  }
}
```

### States

An ordered list of state names. The first state is the initial state for new tasks, and the last is the terminal "done" state (override with `initialState`/`doneState` fields).

### Transitions

A map of `fromState → { toState: permission }`:

| Permission | Who can trigger | Use case |
|-----------|----------------|----------|
| `"any"` | Lead or teammate | Starting work (anyone can pick it up) |
| `"teammate"` | Only agents | Autonomous work (coding, testing) |
| `"lead"` | Only the human | Review gates, approvals |

## Transition Instructions

Markdown files in the workflow directory are shown to agents when they enter or exit a state. The filename matches the state name:

- `in_progress.md` — shown when a task transitions **into** `in_progress`
- `leader_review.md` — shown when entering `leader_review`

These guide agents on what to do in each phase. For example, `leader_review.md` might say:

```markdown
## On Enter

- Create a diff of your changes: `git diff HEAD~1 --output=/tmp/<TASKID>.diff`
- Upload the diff using upload_attachment with filePath
- Post a summary of what you accomplished

## Exit Criteria

- All review comments addressed
- Lead approves or has no comments
```

## Inline Config (Legacy)

Workflows can also be defined inline in `config.json`:

```json
{
  "defaultWorkflow": "default",
  "workflows": {
    "default": {
      "states": ["todo", "in_progress", "review", "done"],
      "transitions": { ... }
    }
  }
}
```

This is supported for backward compatibility. Running `mpt upgrade` migrates inline workflows to the directory structure.

## Multiple Workflows

You can define multiple workflows for different types of work:

```
workflows/
├── default/         # Standard dev workflow
│   └── workflow.json
├── bugfix/          # Simplified: todo → fixing → done
│   └── workflow.json
└── research/        # No review gate: todo → researching → done
    └── workflow.json
```

Assign a workflow to a story when creating it:

```json
POST /api/stories
{ "id": "fix-123", "title": "Fix login bug", "workflow": "bugfix", ... }
```

## Agent Behavior

Agents don't hardcode state names — they're driven entirely by `availableTransitions` from the daemon:

1. Agent polls for work → gets task with `availableTransitions`
2. If a transition has `"teammate"` permission, agent can advance
3. When no teammate transitions remain, agent releases the task
4. Lead acts (review, send back with comments)
5. Agent picks up again if new teammate transitions appear

This means any workflow shape works without agent code changes.

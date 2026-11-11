---
title: Audit project dependencies
directory: __DEMO_PROJECT__
persona: mpt-personas-demo/careful-reviewer
---
## Goal

Review the todo API's dependencies for anything outdated, unused, or risky.
Produce a short written summary of what you found and any recommended changes.

## Acceptance Criteria

- Every entry in package.json MUST be accounted for (used / unused / update available).
- A concise summary MUST be posted as a completion comment on this work.
- No code changes should be made unless something is trivially safe to remove.

## Additional Context

This is standalone one-shot work (Solitary) — it has no parent, so it doesn't
belong to any board story. Run it on demand from the Tasks page whenever you
want a fresh dependency check.

---
title: Wait for the release sign-off
parentKind: story
parentId: release-signoff
---
## Goal

Finish once the release is signed off: the sign-off is the file `approved.txt`
in the project directory. Until it exists, wait for the next check.

## Acceptance Criteria

- The task MUST finish done only once `approved.txt` exists.
- Each check MUST change nothing in the project.

## Additional Context

Create the signal by hand to finish it: `touch approved.txt` in the project directory.

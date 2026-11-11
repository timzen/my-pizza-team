---
title: Add auth middleware and protect todo endpoints
parentKind: story
parentId: add-user-auth
---
## Goal

Create an auth middleware that checks for a Bearer token in the Authorization
header, verifies it using the auth module, and attaches userId to the request.
Apply it to all /todos routes. Unauthenticated requests should get 401. Add
tests in tests/middleware.test.ts.

## Acceptance Criteria

- Every /todos route MUST return 401 when the Authorization header is missing or invalid.
- An authenticated request MUST have req.userId available to handlers.
- tests/middleware.test.ts MUST cover both the allow and deny paths.

## Additional Context

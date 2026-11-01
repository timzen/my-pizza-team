---
title: Add register and login endpoints
parentKind: story
parentId: add-user-auth
---
## Goal

Add POST /register (accepts {username, password}, stores user, returns 201) and
POST /login (accepts {username, password}, returns {token} on success, 401 on
failure). Store users in an in-memory Map for now. Wire up the auth module from
task add-user-auth-1. Add tests in tests/endpoints.test.ts.

## Acceptance Criteria

- POST /register MUST reject a duplicate username with a 4xx status.
- POST /login MUST return 401 (not 500) for a bad password.
- A successful login MUST return a token that verifyToken accepts.

## Additional Context

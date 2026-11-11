---
title: Create auth module with password hashing and token generation
parentKind: story
parentId: add-user-auth
---
## Goal

Create src/auth.ts with functions: hashPassword(plain) -> hashed,
verifyPassword(plain, hashed) -> boolean, generateToken(userId) -> jwt string,
verifyToken(token) -> payload | null. Use simple implementations (crypto
built-ins, no external deps). Add tests in tests/auth.test.ts.

## Acceptance Criteria

- Passwords MUST NOT be stored or logged in plaintext.
- verifyToken MUST return null for a tampered or expired token.
- tests/auth.test.ts MUST cover hash round-trip and token verify/reject.

## Additional Context

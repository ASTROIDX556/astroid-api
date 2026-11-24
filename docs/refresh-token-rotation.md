# Refresh token rotation and reuse detection

`POST /auth/refresh` rotates the refresh token: the presented token is consumed
and a new access and refresh token pair is issued. A refresh token that is
presented again after it was rotated is treated as stolen, and the whole login
it belongs to is signed out.

## Data model

Every `Session` row belongs to a **token family**:

| Column | Meaning |
| --- | --- |
| `familyId` | Shared by every session minted from one login. A login starts a new family; each rotation inherits the family of the session it replaces. |
| `consumedAt` | Set atomically when the session's refresh token is rotated. |
| `replacedByTokenId` | On the rotated session, the id of the session that replaced it. |

## What happens on refresh

| Situation | Result |
| --- | --- |
| Valid, unconsumed token | The token is consumed, the old session is revoked, a new session in the same family is created, and a new pair is returned. |
| Token consumed within `REFRESH_REUSE_GRACE_MS` (5 minutes) | `401`. Treated as a duplicate submission or a race. Nothing is revoked, and the newest token keeps working. |
| Token consumed longer ago than the grace window | **Reuse.** Every unrevoked session of the family is revoked, a `session.family_revoked` event is emitted, and the response is `401`. The newest token of the family stops working too. |
| Two simultaneous refreshes of the same token | Exactly one succeeds (a conditional update on `consumedAt IS NULL`). The other gets `401` and is not counted as reuse. |
| Revoked or expired session, hash mismatch, blacklisted session, or a token that is not a valid JWT | `401`. |

Other logins of the same user are separate families and are not affected when
one family is revoked.

## Event payload

`session.family_revoked` carries only `familyId`, `sessionId` and `userId`.
Tokens and token hashes are never included.

## Tests

- `src/modules/auth/tests/auth.service.refresh.spec.ts` covers the service with
  a mocked repository.
- `src/modules/auth/tests/auth-refresh-rotation.http.spec.ts` covers the same
  behaviour through the HTTP endpoint with the real service and repository,
  including the grace window, family scoping and overlapping requests.

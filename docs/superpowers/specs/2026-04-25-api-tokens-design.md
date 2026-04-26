# API tokens for integrations — design

**Status**: approved (in implementation)
**Date**: 2026-04-25
**Spec for**: P1 task "API tokens для интеграций (создание, ревокация, scopes)"

## Goal

Allow each panel user to mint long-lived bearer tokens for programmatic access (CI scripts, monitoring, Discord bots that hit the panel REST API). Each token has a fixed subset of the user's permissions and is independent of the user's web session.

## Non-goals

- Per-token IP allowlist, expiry, refresh tokens.
- Admin-managed tokens for other users (each user mints their own).
- A new permission family `api_token:*`. We reuse existing `PERMISSION_KEYS`.
- Per-token rate limiting beyond the global `@fastify/rate-limit` already in `server.ts`.
- Token rotation flow.

## Surface

### Token format

Plaintext (returned exactly once at creation):

```
sqp_<uuidv7>_<24-byte base64url>
```

- `sqp_` prefix lets gitleaks / GitHub secret scanning recognize the token.
- The uuid is also stored in the DB row (`player_api_tokens.id`); it is the value that lands in `audit_log.actor_token_id`.
- The 24-byte random suffix supplies entropy. The full string's `sha256` is what the DB stores in `token_hash`. (Same approach as `mintSessionToken` in `apps/api/src/lib/sessions.ts`.)

### REST routes (cookie-only — Bearer cannot manage tokens)

| Method | Path | Returns | Permissions |
|---|---|---|---|
| `GET` | `/api/v1/me/tokens` | array of `{id, name, scopes, last_used_at, created_at, revoked_at}` (no plaintext, no hash) | authenticated |
| `POST` | `/api/v1/me/tokens` | `{id, plaintext, name, scopes, ...}` — plaintext appears **once** | authenticated; body `scopes ⊆ caller.permissions` |
| `DELETE` | `/api/v1/me/tokens/:id` | `{ok: true}` | authenticated; only own token |

`audit.action`: `user.api_token.create` / `user.api_token.revoke`. `resource: 'api_token'`.

### Bearer auth path

Added in `apps/api/src/plugins/auth.ts`:

1. Cookie `__Host-sid` present → existing flow, unchanged.
2. Else `Authorization: Bearer sqp_…` header present → look up by `sha256(token)`:
   - row absent or `revoked_at IS NOT NULL` → `req.user` stays unset (downstream RBAC returns 401).
   - row present → load player + role permissions, set
     ```
     req.user.permissions = rolePerms ∩ token.scopes
     req.tokenId = token.id
     ```
   - throttled `UPDATE last_used_at = now()` (Redis NX key `api-token-touch:{id}` 60 s, mirroring `touchSession`).
3. Routes that explicitly forbid Bearer (the `/me/tokens` ones) gate themselves on `req.session != null`.

### Audit actor

`audit_log.actor_token_id` is filled when `req.tokenId` is set. `apps/api/src/plugins/audit.ts` reads it and forwards as `actor.tokenId` on the steam-actor variant.

## Data model

Existing `player_api_tokens` table (no schema change — already shipped in migration `0008_steam_only_auth.sql`). Recap:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `uuidv7()` minted by API; equals `audit_log.actor_token_id`. |
| `steam_id64` | bigint, FK `players.steam_id64` ON DELETE CASCADE | owner. |
| `name` | text | user-supplied label, 1..100 chars, NFC normalized. |
| `token_hash` | text, unique-ish (no DB unique yet — application enforces) | `sha256(plaintext)`. |
| `scopes` | text[] | subset of `PERMISSION_KEYS`. |
| `last_used_at` | timestamptz nullable | throttled. |
| `created_at` | timestamptz default now | |
| `revoked_at` | timestamptz nullable | revocation is soft so audit FK remains valid. |

## Scope semantics

- **At create time**: `scopes ⊆ caller.permissions`. Owner can mint any subset; Viewer can mint only what Viewer has.
- **At use time**: `effective = currentRolePerms ∩ token.scopes`. So if the user is later demoted, the token immediately loses the lost permissions on the next request — nothing to revoke manually.
- Empty `scopes` is allowed (read-only `/me`-style introspection); endpoints with non-empty `permissions` requirement will simply 403.

## UI

`/settings/tokens` (sibling of `/settings/account`):

- List: name, scopes (chips), created, last used, status badge (active / revoked), revoke button.
- New-token form: text input `name`, multi-checkbox of `caller.permissions` only.
- On submit: modal "Save this token now — it won't be shown again", copy-to-clipboard button.
- RU copy, neutral palette, same conventions as `account/page.tsx` (no toast lib, inline `msg` pill).

Add a tiny nav link in the dashboard sidebar to `/settings/tokens` next to the existing settings entry.

## Tests

| File | Tier | Covers |
|---|---|---|
| `apps/api/test/api-tokens.test.ts` | unit | `mintApiToken` format, `hashApiToken` is sha256, `validateScopesSubset`. |
| `apps/api/test/me-tokens.test.ts` | integration (real PG, real Redis) | list/create/revoke happy path; create with non-subset → 422; revoke other user's → 404; list never returns hash or plaintext. |
| `apps/api/test/auth-bearer.test.ts` | integration | Bearer with valid token authenticates; revoked → 401; scopes intersected correctly; `last_used_at` updated; cookie precedence over Bearer when both present. |
| `apps/api/test/audit-coverage.test.ts` | (existing, extended) | new route module registered so guard sees POST/DELETE. |

E2E (lifecycle test) is not required — Bearer auth is independent of the install/RCON path. The new integration tests run on the same harness as `auth-sessions.test.ts`.

## Risks / gotchas

- **Cookie + Bearer collision**: when both present, the existing cookie path wins (it runs first). This avoids surprise scope-narrowing if a browser session also sends a Bearer header.
- **`token_hash` collision**: 24 bytes of entropy makes it essentially impossible. We don't add a DB unique index because revoked rows might collide in pathological future scenarios; the lookup `WHERE token_hash = $1 AND revoked_at IS NULL` is enough.
- **Permission cache TTL**: `loadUserPermissions` caches 30 s. Revoking a role doesn't immediately shrink scopes. Acceptable — same behavior as cookie sessions today.
- **Audit actor token id**: `audit_log.actor_token_id` becomes non-null for the first time. `verify-audit-chain` already canonicalizes whatever fields are present, so no chain break — but worth a smoke run after deploy.

## Out of scope (deferred — not P1)

- TTL / `expires_at` on tokens (would require schema change).
- Separate `actor_token_id` filter in `/audit` UI.
- Admin "see all org tokens" view.
- Token introspection endpoint (`POST /tokens/introspect`).

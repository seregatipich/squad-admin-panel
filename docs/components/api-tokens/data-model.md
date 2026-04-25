# `api-tokens` — data model

## `player_api_tokens`

Defined in [`packages/db/src/schema/player-api-tokens.ts`](../../../packages/db/src/schema/player-api-tokens.ts). Migration: [`packages/db/drizzle/0008_steam_only_auth.sql`](../../../packages/db/drizzle/0008_steam_only_auth.sql).

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY | Minted by API as `uuidv7()`. Embedded into the plaintext token and copied to `audit_log.actor_token_id`. |
| `steam_id64` | `bigint` | NOT NULL, FK → `players.steam_id64` ON DELETE CASCADE | Owner. Indexed (`player_api_tokens_steam_id64_idx`). |
| `name` | `text` | NOT NULL | User-supplied label, 1..100 chars after trim. Not unique. |
| `token_hash` | `text` | NOT NULL | `sha256(plaintext)` base64url. Looked up on every Bearer auth. |
| `scopes` | `text[]` | NOT NULL DEFAULT `{}` | Subset of `PERMISSION_KEYS`. Application-validated; no DB CHECK. |
| `last_used_at` | `timestamptz` | nullable | Throttled to once per 60 s. NULL until first use. |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `revoked_at` | `timestamptz` | nullable | Soft revoke. Audit FK from `audit_log.actor_token_id` requires the row to outlive its usage. |

## Relationships

```
players(steam_id64) ──< player_api_tokens(steam_id64)
                                    │
                                    └── id ────< audit_log(actor_token_id)
```

## Validation rules

- `scopes ⊆ caller.permissions` at create time (route `POST /api/v1/me/tokens`).
- `scopes` may contain only values that pass `isPermissionKey()`; unknown strings are rejected with HTTP 422.
- At runtime the effective permission set is `currentRolePermissions ∩ token.scopes` — recomputed on every request, so demotions immediately shrink the token's reach.
- Revocation is soft (`UPDATE … SET revoked_at = now()`). The row is never deleted while it has audit references; deletion would only happen via `players` CASCADE if the player itself is removed.

## Limits

- 25 active (non-revoked) tokens per user. Enforced at create time (HTTP 409 `too_many_active_tokens`). Revoked rows do not count.

## Example row

```sql
SELECT id, steam_id64, name, scopes, last_used_at, created_at, revoked_at
FROM player_api_tokens
WHERE steam_id64 = 76561198000000123;

                  id                  |    steam_id64    |  name   |       scopes        |     last_used_at      |     created_at      | revoked_at
--------------------------------------+------------------+---------+---------------------+-----------------------+---------------------+------------
 0193b6c3-1f70-7a91-9bee-... | 76561198000000123 | CI bot  | {server:view}       | 2026-04-25 10:11:12+00 | 2026-04-25 09:00:00+00 |
```

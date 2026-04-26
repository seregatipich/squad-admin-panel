# `api-tokens` — troubleshooting

## Symptom: "401 unauthenticated" with a Bearer token that should work

**Likely causes**

1. Cookie `__Host-sid` is also being sent. The cookie path wins; if the cookie is expired you'll see no auth at all even though the Bearer is fine. Drop the cookie or use a fresh client.
2. Token revoked. Check `SELECT revoked_at FROM player_api_tokens WHERE id = '<id>'`.
3. Header malformed. Must be `Authorization: Bearer sqp_<uuid>_<random>` — case-insensitive scheme, single space.
4. Header doesn't match the `looksLikeApiToken` shape (e.g. typo in the prefix). The plugin short-circuits before the DB lookup.

**Quick diagnostics**

```bash
# inside the api container
psql "$DATABASE_URL" -c "
  SELECT id, name, scopes, last_used_at, revoked_at
  FROM player_api_tokens
  WHERE token_hash = encode(digest('sqp_<the-token-you-have>', 'sha256'), 'base64')
"
```

(Use base64url, not standard base64; or compare in Node: `crypto.createHash('sha256').update(token).digest('base64url')`.)

## Symptom: "403 forbidden" right after using the token

The token's scopes intersect with the user's *current* role permissions. If the user was demoted, scopes the token used to have are dropped on the very next request.

```sql
SELECT pa.scopes AS token_scopes, array_agg(rp.permission_key) AS user_perms
FROM player_api_tokens pa
JOIN player_role_assignments pra ON pra.steam_id64 = pa.steam_id64
JOIN role_permissions rp ON rp.role_id = pra.role_id
WHERE pa.id = '<id>'
GROUP BY pa.scopes;
```

If `token_scopes` contains keys not in `user_perms`, the user has lost the role that granted them. Mint a new token after the user gets the role back, or revoke + remint.

## Symptom: 422 `invalid_scopes` when creating a token

The `unknown` array lists scope strings that are not in `PERMISSION_KEYS`. The `not_granted` array lists scope strings that the caller does not currently have. The UI's permission checkboxes only show `caller.permissions`, so typing a scope by hand (curl) is the typical cause.

## Symptom: "409 too_many_active_tokens"

The user already has 25 non-revoked tokens. Revoke unused ones at `/settings/tokens` (the count is by `revoked_at IS NULL`).

## Symptom: `last_used_at` not updating

It is throttled to once per 60 s per token via Redis SETNX. If you fire 50 requests in a row, only the first updates the timestamp; the rest skip the UPDATE intentionally to avoid a write storm. Wait 60 s and re-test if you need to verify.

## Useful logs

`apps/api` logs at `info` level on a successful auth and `warn` on bridge errors, but it does **not** log the token plaintext or hash. The `audit_log` row is the canonical record:

```sql
SELECT created_at, action_type, target_id, actor_steam_id64, actor_token_id, status_code
FROM audit_log
WHERE actor_token_id = '<id>'
ORDER BY created_at DESC
LIMIT 20;
```

## Useful commands

```bash
# verify chain integrity (the new actor_token_id column changes the canonical
# JSON used in the hash chain — first run after deployment is a good smoke)
pnpm verify:audit-chain
```

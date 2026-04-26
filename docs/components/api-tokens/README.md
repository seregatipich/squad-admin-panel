# `api-tokens` — programmatic access via Bearer

Long-lived per-user API tokens for scripts, CI, monitoring, and Discord integrations that need to call the panel's REST API without a browser session.

## Responsibilities

- Mint, list, and revoke per-user tokens (`/api/v1/me/tokens*`).
- Authenticate inbound requests via `Authorization: Bearer sqp_…` and intersect the token's `scopes` with the user's current role permissions.
- Wire the token id into the audit-log actor field (`audit_log.actor_token_id`).

## Non-responsibilities

- Admins do **not** manage other users' tokens. Each user mints their own.
- No TTL / `expires_at` — explicit revoke only.
- No per-token IP allowlist, refresh tokens, or scope groups.
- Token-managing routes (`/me/tokens*`) reject Bearer auth (cookie session only) so a stolen token cannot rotate itself.

## Code locations

| Concern | File |
|---|---|
| Format, hash, scope helpers | [`apps/api/src/lib/api-tokens.ts`](../../../apps/api/src/lib/api-tokens.ts) |
| Bearer authentication | [`apps/api/src/plugins/auth.ts`](../../../apps/api/src/plugins/auth.ts) |
| CRUD routes | [`apps/api/src/routes/me-tokens.ts`](../../../apps/api/src/routes/me-tokens.ts) |
| Audit actor wiring | [`apps/api/src/plugins/audit.ts`](../../../apps/api/src/plugins/audit.ts) |
| Database table | [`packages/db/src/schema/player-api-tokens.ts`](../../../packages/db/src/schema/player-api-tokens.ts) |
| Web UI | [`apps/web/src/app/(dashboard)/settings/tokens/page.tsx`](../../../apps/web/src/app/(dashboard)/settings/tokens/page.tsx) |
| Tests | [`apps/api/test/{api-tokens,me-tokens,auth-bearer}.test.ts`](../../../apps/api/test/) |

## Token format

```
sqp_<uuidv7>_<24 random bytes, base64url>
```

- `sqp_` prefix lets gitleaks / GitHub secret scanning recognise the token.
- The uuid is also stored in the DB row's `id` column and ends up as `audit_log.actor_token_id`.
- The DB stores **only** `sha256(plaintext)` (column `token_hash`) — same approach as session tokens. Plaintext is shown to the user once, at creation.

## Dependencies

- `players.steam_id64` — the FK owner.
- `@squad/shared-config#PERMISSION_KEYS` — the closed set of scope values.
- `loadUserPermissions()` from [`apps/api/src/lib/rbac.ts`](../../../apps/api/src/lib/rbac.ts) — invoked on every Bearer request.

## Components depending on it

- All RBAC-gated routes — Bearer is just another way to populate `req.user`.
- `audit_log.actor_token_id` — first becomes non-null with this feature.

## Related docs

- [`api/api.md`](../api/api.md) — Bearer mention in the Conventions section, route table entries.
- [`db/README.md`](../db/README.md) — `player_api_tokens` schema overview.
- [`docs/architecture/decisions.md`](../../architecture/decisions.md) — the original schema-only deferral.

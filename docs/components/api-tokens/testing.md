# `api-tokens` — testing

## Files

| File | Tier | What it covers |
|---|---|---|
| [`apps/api/test/api-tokens.test.ts`](../../../apps/api/test/api-tokens.test.ts) | unit | `mintApiToken` shape + uniqueness, `hashApiToken` determinism, `looksLikeApiToken` accept/reject, `validateScopesSubset` ok/unknown/not-granted paths, `intersectScopes`, `extractBearerToken`. |
| [`apps/api/test/me-tokens.test.ts`](../../../apps/api/test/me-tokens.test.ts) | integration (real Postgres + Redis) | `GET/POST/DELETE /api/v1/me/tokens` happy + error paths, audit row written, list response carries no hash/plaintext. |
| [`apps/api/test/auth-bearer.test.ts`](../../../apps/api/test/auth-bearer.test.ts) | integration | Bearer auth populates `req.user` with intersected scopes; cookie wins over Bearer; revoked tokens fall through to 401; `last_used_at` advances; `/me/tokens` rejects Bearer. |
| [`apps/api/test/audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) | integration (existing) | Includes `meTokensRoutes` so the CI guard sees the new POST/DELETE routes have `config.audit`. |

## Run

```bash
# unit-only (fast, no infra)
pnpm --filter @squad/api exec vitest run test/api-tokens.test.ts

# integration (needs Docker compose running with Postgres + Redis)
pnpm --filter @squad/api exec vitest run test/me-tokens.test.ts test/auth-bearer.test.ts

# whole suite
pnpm --filter @squad/api test
```

Integration tests use `buildIntegrationApp` from [`apps/api/test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts), which provisions a fresh schema, runs all migrations, seeds an Owner player, and registers the live Fastify app (cookie + auth plugin + audit plugin + all routes). Each test file owns its own schema and tears it down in `afterEach`.

## What is not covered

- E2E (`apps/api/test/e2e/`) does **not** include API-token lifecycle. Bearer auth is independent of the install/RCON path so it is left out of the slow lifecycle suite by design.
- Cross-user enumeration (DELETE returning 404 for someone else's token) is covered indirectly — the route filters by `steam_id64 = req.user.steamId64`, so an attacker sees `404 token_not_found` whether the id is unknown or belongs to someone else.

## Edge cases worth knowing

- **Permission cache TTL**: `loadUserPermissions` caches for 30 s. After demoting a user, Bearer requests may still see the old scope intersection for up to 30 s. This matches the cookie-session behaviour and is acceptable.
- **Cookie + Bearer collision**: cookie wins. Tested in `auth-bearer.test.ts` ("cookie wins when both cookie and Bearer are present").
- **`looksLikeApiToken` short-circuit**: avoids a DB hit for obviously bad headers. Garbage Bearer headers ⇒ 401 without ever touching Postgres.

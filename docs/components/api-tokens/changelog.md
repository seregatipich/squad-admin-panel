# Changelog

## 2026-09-27

### Fixed (#7)

- `apps/api/src/plugins/auth.ts` — a token whose owner lost `panel_access` (demotion, expiry, removal) no longer authenticates; it answers 401 instead of reaching the routes that authorise on `req.user` alone.
- `apps/api/src/lib/rbac.ts` — new `narrowToTokenScopes`: role flags, live-Squad permissions and `panel_access` are narrowed to the token's scopes, not copied from the role. Previously a `server:view` (or `scopes: []`) token could still manage VIP tiers, seasons, ban sources, media, banned-name rules, map/rotation and broadcasts through flag-gated routes.
- `apps/api/src/routes/banned-names.ts`, `apps/api/src/routes/issues.ts` — require `panel_access`, so neither a narrowed token nor a panel session that outlived its role's panel access reaches them.
- `apps/api/src/routes/report-actions.ts` — `POST /api/v1/reports/:id/actions` requires the live-Squad `ban` (ban) or `kick` (warn/kick) permission, as `moderation-actions.ts` does.

### Behaviour change

- An integration that used a token on a route gated by a role flag or Squad permission with no catalogue key now receives 403; use a cookie session for those operations.

## 2026-04-25

### Added

- Component activated: `player_api_tokens` table is now used by application code (was schema-only since migration `0008_steam_only_auth.sql`).
- `apps/api/src/lib/api-tokens.ts` — `mintApiToken`, `hashApiToken`, `looksLikeApiToken`, `extractBearerToken`, `validateScopesSubset`, `intersectScopes`. Token format `sqp_<uuidv7>_<24-byte base64url>`.
- `apps/api/src/routes/me-tokens.ts` — `GET/POST/DELETE /api/v1/me/tokens` (cookie-only). Hard cap of 25 active tokens per user. Soft revoke via `revoked_at`.
- `apps/api/src/plugins/auth.ts` — Bearer authentication path. Permissions are intersected with the token's scopes on every request; demotions immediately shrink reach.
- `apps/api/src/plugins/audit.ts` — wires `req.apiTokenId` into `audit_log.actor_token_id`. The column was previously always NULL.
- `apps/web/src/app/(dashboard)/settings/tokens/page.tsx` — list / create (with scope checkboxes) / one-time plaintext modal / revoke. Sidebar entry "API-токены" (API tokens).
- Tests: `apps/api/test/api-tokens.test.ts`, `apps/api/test/me-tokens.test.ts`, `apps/api/test/auth-bearer.test.ts`. `audit-coverage` extended with the new route module.

### Migration notes

- No DB migration. The `player_api_tokens` table already exists from `0008_steam_only_auth.sql`.
- `verify-audit-chain` continues to work — the canonical-JSON serializer already includes `actor_token_id`. The first audit row after deploy that carries a non-null value will produce a different `row_hash` for that row only; the chain is unaffected.

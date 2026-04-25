# Changelog

## 2026-04-25

### Added

- Component activated: `player_api_tokens` table is now used by application code (was schema-only since migration `0008_steam_only_auth.sql`).
- `apps/api/src/lib/api-tokens.ts` — `mintApiToken`, `hashApiToken`, `looksLikeApiToken`, `extractBearerToken`, `validateScopesSubset`, `intersectScopes`. Token format `sqp_<uuidv7>_<24-byte base64url>`.
- `apps/api/src/routes/me-tokens.ts` — `GET/POST/DELETE /api/v1/me/tokens` (cookie-only). Hard cap of 25 active tokens per user. Soft revoke via `revoked_at`.
- `apps/api/src/plugins/auth.ts` — Bearer authentication path. Permissions are intersected with the token's scopes on every request; demotions immediately shrink reach.
- `apps/api/src/plugins/audit.ts` — wires `req.apiTokenId` into `audit_log.actor_token_id`. The column was previously always NULL.
- `apps/web/src/app/(dashboard)/settings/tokens/page.tsx` — list / create (with scope checkboxes) / one-time plaintext modal / revoke. Sidebar entry "API-токены".
- Tests: `apps/api/test/api-tokens.test.ts`, `apps/api/test/me-tokens.test.ts`, `apps/api/test/auth-bearer.test.ts`. `audit-coverage` extended with the new route module.

### Migration notes

- No DB migration. The `player_api_tokens` table already exists from `0008_steam_only_auth.sql`.
- `verify-audit-chain` continues to work — the canonical-JSON serializer already includes `actor_token_id`. The first audit row after deploy that carries a non-null value will produce a different `row_hash` for that row only; the chain is unaffected.

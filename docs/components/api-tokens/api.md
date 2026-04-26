# `api-tokens` — public API

All token-managing routes are **cookie-only** (the session middleware rejects Bearer-authenticated requests with 401). This avoids token-rotates-itself attacks if a token leaks.

## Routes

### `GET /api/v1/me/tokens`

List the caller's API tokens. No plaintext, no hash.

**Response 200**

```json
[
  {
    "id": "01939a8b-...-...",
    "name": "CI bot",
    "scopes": ["server:view", "audit:view"],
    "last_used_at": "2026-04-25T10:11:12.345Z",
    "created_at": "2026-04-25T09:00:00.000Z",
    "revoked_at": null
  }
]
```

**Errors**: `401 unauthenticated` if no session cookie.

---

### `POST /api/v1/me/tokens`

Mint a new token. Plaintext is returned once and never again.

**Request body**

| Field | Type | Constraint |
|---|---|---|
| `name` | string | trimmed, 1..100 chars |
| `scopes` | string[] | each must be a `PermissionKey`, and the set must be `⊆ caller.permissions`. Empty array is allowed. |

**Response 201**

```json
{
  "id": "01939a8b-...-...",
  "name": "CI bot",
  "scopes": ["server:view"],
  "created_at": "2026-04-25T09:00:00.000Z",
  "plaintext": "sqp_01939a8b-...-..._aGVsbG8gd29ybGQK..."
}
```

**Errors**

| Status | Body | When |
|---|---|---|
| 400 | Zod validation error | Name empty/oversized, scopes not an array, etc. |
| 401 | `{error: "unauthenticated"}` | No session. |
| 409 | `{error: "too_many_active_tokens", limit: 25}` | User already has 25 non-revoked tokens. |
| 422 | `{error: "invalid_scopes", unknown: [...], not_granted: [...]}` | Scope set contains unknown keys or keys the caller does not currently have. |

**Audit**: `user.api_token.create` / `api_token`. The new token's `id` ends up in `audit_log.target_id` via the request route param, and (on subsequent requests using the token) in `audit_log.actor_token_id`.

---

### `DELETE /api/v1/me/tokens/:id`

Soft-revoke. Sets `revoked_at = now()` but keeps the row so historical `audit_log.actor_token_id` references remain valid.

**Response 200**

- First call: `{ "ok": true }`
- Second call: `{ "ok": true, "already_revoked": true }`

**Errors**: `401 unauthenticated`; `404 token_not_found` (also returned for tokens belonging to another user — prevents enumeration).

---

## Bearer authentication

Any non-`/me/tokens*` route may be called with `Authorization: Bearer sqp_…` instead of the session cookie. The plugin in `apps/api/src/plugins/auth.ts`:

1. If `__Host-sid` cookie is present → cookie path runs and the Bearer header is ignored.
2. Else if the header matches `/^Bearer\s+(\S+)$/` and `looksLikeApiToken(token)` returns true:
   - Look up `player_api_tokens` by `token_hash = sha256(token)` and `revoked_at IS NULL`.
   - Load the player and their role permissions.
   - Set `req.user.permissions = rolePerms ∩ token.scopes`. Permissions the user lost since the token was minted are dropped automatically.
   - Set `req.apiTokenId` (later forwarded to `audit_log.actor_token_id`).
   - Throttle `UPDATE last_used_at` to once per 60 s per token using a Redis NX lock.
3. RBAC gate (`config.permissions`) runs on `req.user.permissions` as usual.

A revoked or unknown token leaves `req.user` unset, so RBAC-gated routes return `401`.

## Internal helpers (`apps/api/src/lib/api-tokens.ts`)

| Export | Purpose |
|---|---|
| `mintApiToken(): { id, plaintext, tokenHash }` | New uuidv7 + 24 random bytes + sha256 hash. |
| `hashApiToken(plaintext): string` | sha256 → base64url. |
| `looksLikeApiToken(value): boolean` | Quick shape check — `sqp_<uuid-shape>_<random ≥ 16 chars>`. Used to skip DB lookup for garbage headers. |
| `extractBearerToken(headerValue): string \| null` | Parse `Authorization` header (case-insensitive, accepts arrays). |
| `validateScopesSubset(requested, granted): { ok, unknown, notGranted }` | Used by POST /me/tokens. |
| `intersectScopes(scopes, granted): Set<PermissionKey>` | Used by Bearer auth on every request. |
| `API_TOKEN_PREFIX = 'sqp_'` | Constant. |
| `API_TOKEN_TOUCH_THROTTLE_SECONDS = 60` | Constant. |

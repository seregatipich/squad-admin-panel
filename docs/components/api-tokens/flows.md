# `api-tokens` — flows

## Mint a token

```
[user @ /settings/tokens]
       │
       │ POST /api/v1/me/tokens   { name, scopes }
       ▼
auth plugin (cookie path) ──► req.user populated from session
       │
       ▼
me-tokens route handler
       │
       ├── validateScopesSubset(scopes, req.user.permissions)
       │     │
       │     └── ok=false ──► 422 invalid_scopes
       │
       ├── count active tokens for steam_id64
       │     │
       │     └── ≥25 ──► 409 too_many_active_tokens
       │
       ├── mintApiToken() ──► { id, plaintext, tokenHash }
       │
       ├── INSERT INTO player_api_tokens (id, steam_id64, name, token_hash, scopes)
       │
       └── 201 { id, name, scopes, created_at, plaintext }
              │
              ▼
       audit plugin onResponse hook
              │
              └── INSERT INTO audit_log (action='user.api_token.create',
                                          target_type='api_token',
                                          target_id=<route param 'id' is absent → null>,
                                          actor_steam_id64=<owner>,
                                          actor_token_id=null)
```

The UI renders `plaintext` in a one-time amber panel with a copy button. After dismissing the panel the value is unrecoverable.

## Authenticate with Bearer

```
GET /api/v1/servers
Authorization: Bearer sqp_<uuid>_<random>

       │
       ▼
auth plugin onRequest hook
       │
       ├── cookie present? ──yes──► cookie path runs, Bearer ignored
       │
       └── no cookie
              │
              ├── extractBearerToken() ──► "sqp_<uuid>_<random>"
              ├── looksLikeApiToken()    ──► true
              ├── hashApiToken(plaintext) ──► h
              ├── SELECT id, steam_id64, scopes
              │   FROM player_api_tokens
              │   WHERE token_hash = h AND revoked_at IS NULL
              │
              ├── row absent ──► req.user unset ──► RBAC gate returns 401
              │
              └── row present
                     │
                     ├── load player canonical_name
                     ├── loadUserPermissions(steam_id64) ──► rolePerms (cached 30 s)
                     ├── effective = intersectScopes(token.scopes, rolePerms)
                     ├── req.user = { steamId64, canonicalName, permissions: { permissions: effective, clearance, roleIds } }
                     ├── req.apiTokenId = token.id
                     ├── touchApiTokenLastUsed()
                     │      │
                     │      └── Redis SETNX api-token-touch:{id} EX 60
                     │             │
                     │             └── lock acquired ──► UPDATE last_used_at = now()
                     │
                     └── continue to RBAC gate using req.user.permissions
```

## Revoke a token

```
DELETE /api/v1/me/tokens/<id>

       │
       ▼
auth plugin (cookie required — Bearer would 401 here)
       │
       ▼
me-tokens DELETE handler
       │
       ├── SELECT revoked_at FROM player_api_tokens
       │   WHERE id = :id AND steam_id64 = req.user.steamId64
       │
       ├── row absent ──► 404 token_not_found
       ├── revoked_at != null ──► 200 { ok: true, already_revoked: true }
       │
       └── UPDATE player_api_tokens SET revoked_at = now() WHERE id = :id
              │
              ▼
              200 { ok: true }
              │
              ▼
       audit hook ──► action='user.api_token.revoke'
                       target_id = :id
```

## Permission downgrade

```
t0:  user has Owner role
     mint token with scopes=['server:start','server:stop']

t1:  user is demoted to Viewer
     loadUserPermissions cache expires after 30 s
     next Bearer request:
       rolePerms = { 'server:view', ... }   (Viewer set)
       effective = intersect(['server:start','server:stop'], rolePerms) = {}
       any RBAC-gated route returns 403
```

No explicit revoke is required for a demotion to take effect.

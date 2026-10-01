# Steam-only login — design

**Status:** approved (brainstorming complete) — pending implementation plan
**Date:** 2026-04-25
**Owner:** Squad Panel Dev
**Source TZ:** §1.1–§1.6 (Steam OpenID, first-login Owner trick, setup wizard, sliding sessions, session management UI, linked identities)

---

## 1. Goals & non-goals

### Goals

- Steam OpenID 2.0 is the only way to log in to the panel.
- The first Steam login after a fresh install automatically becomes Owner exactly once; the trick cannot be repeated even after a DB drop-and-restore (double anchor: DB flag + sentinel file via the bridge).
- The first-run wizard creates an **organization**; the Owner user is created via the first Steam login, not via the wizard.
- Sliding session TTL of 6 hours, refreshed at most once per 60 seconds per session.
- Session management UI: a list of active sessions, log out one/all.
- Steam_id64 is the user's passport everywhere: audit-log actor, role-assignments, server-credentials author, config_versions author.

### Non-goals

- Email/password login — **removed entirely**.
- TOTP / backup codes — **removed entirely**.
- Discord login — **not doing it**. Discord remains as a linked identity for notifications/the Discord bot (P1+, separate spec).
- API tokens — the schema is created (for the FK on token-id in audit-log), CRUD endpoints are marked P1+ and are not implemented in this iteration.
- Steam Web API key — optional; without it the panel works, persona/avatar are not enriched.
- Migration-from-existing-data — the panel has no prod data (pre-launch); the migration is destructive and forward-only.

---

## 2. Mental model

A "panel user" as a separate entity does not exist. The identity anchor is `players.steam_id64 bigint PK`. This table already exists and is populated automatically:

- `worker-rcon` upserts the player on every `ListPlayers` polling tick (see `apps/workers/rcon/src/persist.ts`),
- `worker-log-ingest` parses `player.connected` / `player.disconnected` events from `SquadGame.log`.

A "panel user" = a `player` with a role assigned in the new `player_role_assignments` table. The Owner manages access from the player card (`/players/<steam_id64>`), not from a separate "pending users" UI. Pending = "a player without roles", which is already the default state of all server players.

Steam OpenID callback:

1. Validates the OpenID 2.0 response (see §6).
2. Finds/creates the `players` row by `steam_id64` (a stub if the player has never been on the server).
3. Optionally enriches `canonical_name` via `GetPlayerSummaries` (if `STEAM_WEB_API_KEY` is set and `canonical_name` is the default stub).
4. If this is the first Steam callback on a fresh panel (see §5) — grants the Owner role atomically.
5. Otherwise checks for a role assignment. If there are no roles — 403 without a session (no cookie is set, redirect to `/login?error=not_authorized`).
6. If there are roles — creates a `sessions` row, sets the `__Host-sid` cookie, redirects to `/`.

---

## 3. Architecture and code layers

### 3.1 New/changed files

| Path | Purpose |
|---|---|
| `apps/api/src/lib/steam-openid.ts` | Pure functions: `buildLoginRedirectUrl(returnTo, nonce)`, `parseCallbackParams(query)`, `verifyWithSteam(params): Promise<{steamId64, responseNonce}>`. No I/O state — the caller does the Redis nonce ops. ~120 lines. |
| `apps/api/src/lib/steam-profile.ts` | Wrapper over `GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/`. Returns `{persona, avatarUrl} \| null`. Cached in Redis under `steam-profile:{steamid}` with a 1h TTL. Silently returns `null` if the ENV `STEAM_WEB_API_KEY` is empty. |
| `apps/api/src/lib/first-owner.ts` | `claimFirstOwner(steamId64): Promise<'claimed' \| 'already_claimed' \| 'no_owner_role'>`. See §5 for the algorithm. |
| `apps/api/src/routes/auth-steam.ts` | `GET /api/v1/auth/steam/login` (redirect to Steam), `GET /api/v1/auth/steam/callback` (validation → first-owner OR role-check → session). Replaces the existing 501 stub. |
| `apps/api/src/routes/auth.ts` | Removed: `POST /login`, `POST /me/totp/*`. Kept: `POST /logout`, `GET /me`. Added: `GET /me/sessions`, `DELETE /me/sessions/:id`, `DELETE /me/sessions` (logout all). |
| `apps/api/src/routes/setup.ts` | Reduced to two endpoints: `GET /setup/check-env`, `POST /setup/init`. Removed: `/setup/org`, `/setup/owner`, `/setup/finalize`. |
| `apps/api/src/lib/sessions.ts` | Extended: `last_activity_at`, sliding TTL touch with a Redis SETNX throttle (see §7). |
| `apps/api/src/plugins/auth.ts` | The middleware gains `touchSession()` after resolve. `req.user` is now `{steamId64, canonicalName, avatarUrl, permissions, clearance}` without `email`/`displayName`. |
| `packages/db/src/schema/*` | Removed: `users.ts`, `user-identities.ts`, `user-role-assignments.ts`, `user-api-tokens.ts`. Added: `player-role-assignments.ts`, `player-api-tokens.ts`. Changed: `sessions.ts`, `organization-members.ts`, `audit-log.ts`, `config-versions.ts`. |
| `packages/db/drizzle/0008_steam_only_auth.sql` | A single transaction, see §4. |
| `packages/shared-config/src/bridge-methods.ts` | `/var/lib/squad-panel/.first-owner-claimed` is added to `pathAllowlist` for `file_atomic_write`/`file_read`. |
| `apps/web/src/app/login/page.tsx` | Replaced with a single «Войти через Steam» (Sign in with Steam) button → `window.location.href = '/api/v1/auth/steam/login'`. The email/password form is removed. |
| `apps/web/src/app/setup/page.tsx` | Two-step wizard: env-check → form «Название организации, slug» (Organization name, slug) → `POST /api/v1/setup/init` → redirect to `/login`. |
| `apps/web/src/app/(dashboard)/settings/account/page.tsx` | The TOTP section is removed. An «Активные сессии» (Active sessions) section is added, with a listing and logout buttons. |
| `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` | Adds a «Доступ к панели» (Panel access) section (visible with the `user:manage_roles` permission): the player's role list, a «Назначить роль» (Assign role) dropdown, a «Удалить роль» (Remove role) button. |
| `apps/web/src/app/no-access/page.tsx` | A new static page: «Steam ID `7656...` не имеет доступа. Обратитесь к администратору.» (Steam ID `7656...` has no access. Contact the administrator.) Used as the landing page for cookie-less errors. |

### 3.2 ENV vars

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `PANEL_PUBLIC_URL` | yes | — | api | `https://<host>` for building `openid.return_to`. The wizard env-check verifies that a GET to `<PANEL_PUBLIC_URL>/api/v1/health` reaches this same panel. | no |
| `STEAM_WEB_API_KEY` | no | empty | api | If set — `players.canonical_name` is enriched with the persona. Obtained at https://steamcommunity.com/dev/apikey. | yes |
| `SESSION_TTL_SECONDS` | no | `21600` (6h) | api | Sliding session TTL. Change only in tests. | no |
| `SESSION_TOUCH_THROTTLE_SECONDS` | no | `60` | api | Minimum interval between `last_activity_at` updates per session. | no |

---

## 4. Schema migration `0008_steam_only_auth.sql`

A single file, single transaction, destructive forward-only. Rollback — git revert + `psql -c 'DROP DATABASE admin; CREATE DATABASE admin'` + `pnpm db:migrate`. Documented in `docs/operations/migrations.md`.

### 4.1 Dropped

```sql
DROP TABLE sessions, user_api_tokens, user_identities,
           user_role_assignments, organization_members,
           audit_log, config_versions, users CASCADE;
```

### 4.2 Created

```sql
CREATE TABLE sessions (
  id                text         PRIMARY KEY,
  steam_id64        bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  expires_at        timestamptz  NOT NULL,
  last_activity_at  timestamptz  NOT NULL DEFAULT now(),
  ip                inet,
  user_agent        text,
  created_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX sessions_steam_id64_idx     ON sessions(steam_id64);
CREATE INDEX sessions_expires_at_idx     ON sessions(expires_at);
CREATE INDEX sessions_last_activity_idx  ON sessions(last_activity_at);

CREATE TABLE player_role_assignments (
  steam_id64  bigint      NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  role_id     uuid        NOT NULL REFERENCES roles(id)            ON DELETE CASCADE,
  assigned_by bigint                  REFERENCES players(steam_id64) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, role_id)
);
CREATE INDEX player_role_assignments_role_idx ON player_role_assignments(role_id);

CREATE TABLE organization_members (
  steam_id64       bigint      NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  org_id           uuid        NOT NULL REFERENCES organizations(id)   ON DELETE CASCADE,
  primary_role_id  uuid                    REFERENCES roles(id),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, org_id)
);

CREATE TABLE player_api_tokens (
  id            uuid        PRIMARY KEY,
  steam_id64    bigint      NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  name          text        NOT NULL,
  token_hash    text        NOT NULL,
  scopes        text[]      NOT NULL DEFAULT '{}',
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX player_api_tokens_steam_id64_idx ON player_api_tokens(steam_id64);

CREATE TABLE audit_log (
  id                 bigserial    PRIMARY KEY,
  actor_kind         text         NOT NULL CHECK (actor_kind IN ('steam','system')),
  actor_steam_id64   bigint                REFERENCES players(steam_id64)        ON DELETE SET NULL,
  actor_token_id     uuid                  REFERENCES player_api_tokens(id)      ON DELETE SET NULL,
  actor_system_label text,
  action             text         NOT NULL,
  resource           text         NOT NULL,
  resource_id        text,
  status_code        integer,
  ip                 inet,
  user_agent         text,
  request_payload    jsonb,
  response_payload   jsonb,
  occurred_at        timestamptz  NOT NULL DEFAULT now(),
  prev_hash          bytea,
  row_hash           bytea        NOT NULL,
  CHECK (
    (actor_kind = 'steam'  AND actor_steam_id64 IS NOT NULL AND actor_system_label IS NULL) OR
    (actor_kind = 'system' AND actor_steam_id64 IS NULL     AND actor_system_label IS NOT NULL)
  )
);
CREATE INDEX audit_log_actor_steam_idx ON audit_log(actor_steam_id64) WHERE actor_steam_id64 IS NOT NULL;
CREATE INDEX audit_log_occurred_idx    ON audit_log(occurred_at DESC);
-- BEFORE UPDATE/DELETE trigger + hash-chain logic are recreated 1:1 from the existing code

CREATE TABLE config_versions (
  -- existing columns: id uuid PK, server_id uuid, file_path text, content text,
  --                   sha256 bytea, commit_message text, created_at timestamptz
  -- replace author_user_id uuid → author_steam_id64 bigint NULL + author_label text NULL:
  author_steam_id64  bigint      REFERENCES players(steam_id64) ON DELETE SET NULL,
  author_label       text,
  CHECK ((author_steam_id64 IS NOT NULL) OR (author_label IS NOT NULL))
);
```

### 4.3 Changed

- `organizations.settings` — the key `first_owner_claimed: boolean` is added (stored in `jsonb`, not as a separate column).
- `players` — unchanged; `display_name`, `avatar_url` are not added. The Steam persona goes directly into `players.canonical_name` (the RCON worker writes there too). If a separate "display name visible in the panel" is wanted — a separate migration later.

### 4.4 Drizzle codegen

`pnpm db:generate` after editing the schema files → check that the diff is equivalent to the hand-written `0008_*.sql` → commit both files in one commit.

---

## 5. First-login Owner trick

### 5.1 Double anchor

- **DB:** `organizations.settings.first_owner_claimed = true`.
- **Filesystem:** `/var/lib/squad-panel/.first-owner-claimed` (contains JSON `{"steam_id64": "...", "claimed_at": "ISO8601"}`).

The trick is active ⟺ neither anchor is set. If at least one is set, subsequent logins go through the regular role-check path.

### 5.2 Algorithm `claimFirstOwner(steamId64)`

```ts
async function claimFirstOwner(steamId64: bigint): Promise<'claimed' | 'already_claimed' | 'no_owner_role'> {
  // 1. Cheap check: sentinel file via bridge.
  const sentinelExists = await bridgeClient.fileRead('/var/lib/squad-panel/.first-owner-claimed').catch(() => null);
  if (sentinelExists !== null) return 'already_claimed';

  // 2. Transactional claim with advisory lock to serialise concurrent callbacks.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('first_owner'))`);

    const orgs = await tx.select().from(organizations).limit(1);
    const org = orgs[0];
    if (!org) throw new Error('no_organization_yet'); // setup wizard not yet completed
    const claimed = (org.settings as { first_owner_claimed?: boolean })?.first_owner_claimed === true;
    if (claimed) return 'already_claimed';

    const ownerRole = await tx.query.roles.findFirst({
      where: (r, { and, eq }) => and(eq(r.orgId, org.id), eq(r.name, 'Owner')),
    });
    if (!ownerRole) return 'no_owner_role';

    // 3. Ensure player row exists (caller already created stub if needed, but defensive upsert OK).
    const stubName = `Player ${String(steamId64).slice(-4)}`;
    await tx.insert(players).values({
      steamId64,
      canonicalName: stubName,
      canonicalNameNormalized: stubName.toLowerCase(),
    }).onConflictDoNothing();

    await tx.insert(playerRoleAssignments).values({ steamId64, roleId: ownerRole.id, assignedBy: null });
    await tx.insert(organizationMembers).values({ steamId64, orgId: org.id, primaryRoleId: ownerRole.id });
    await tx.update(organizations)
      .set({ settings: { ...org.settings, first_owner_claimed: true } })
      .where(eq(organizations.id, org.id));

    // 4. Sentinel — written last; if the bridge fails, ROLLBACK rolls back the DB and the trick remains available.
    await bridgeClient.fileAtomicWrite(
      '/var/lib/squad-panel/.first-owner-claimed',
      JSON.stringify({ steam_id64: String(steamId64), claimed_at: new Date().toISOString() }),
    );

    return 'claimed';
  });
}
```

Concurrency: `pg_advisory_xact_lock(hashtext('first_owner'))` serialises concurrent callbacks. FOR UPDATE on the organization row is not enough because the row may not exist yet in an edge case (setup not yet completed).

### 5.3 Order in the callback handler

```
parse + verify Steam OpenID
  ↓
upsert players (stub if not exists)
  ↓
optional: enrich canonical_name from GetPlayerSummaries
  ↓
claimFirstOwner(steamId64)
  ├── 'claimed'         → create session, redirect /
  ├── 'already_claimed' → role check:
  │                         have roles → create session, redirect /
  │                         no roles   → redirect /login?error=not_authorized (no cookie is set)
  └── 'no_owner_role'   → 500, audit-log system error
```

---

## 6. Steam OpenID 2.0 flow

### 6.1 `/api/v1/auth/steam/login`

1. Generate `nonce = randomBytes(16).toString('base64url')`.
2. Redis: `SET steam-nonce:{nonce} '{ts, ip, returnPath}' EX 300`.
3. Set cookie: `__Host-steam-nonce = nonce; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`.
4. Build redirect URL:
   ```
   https://steamcommunity.com/openid/login?
     openid.ns=http://specs.openid.net/auth/2.0&
     openid.mode=checkid_setup&
     openid.return_to=<PANEL_PUBLIC_URL>/api/v1/auth/steam/callback?n=<nonce>&
     openid.realm=<PANEL_PUBLIC_URL>/&
     openid.identity=http://specs.openid.net/auth/2.0/identifier_select&
     openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select
   ```
5. `302 Found Location: <above>`.

### 6.2 `/api/v1/auth/steam/callback`

Rate-limit: 10 req/min/IP.

Validation pipeline (any failing step → 400 + redirect `/login?error=auth_failed`, audit record):

1. **Nonce match.** `n` query param = `__Host-steam-nonce` cookie.
2. **Nonce single-use.** `GETDEL steam-nonce:{nonce}` → if `nil`, reject. Clear the cookie.
3. **Return-to host-binding.** The `openid.return_to` parameter in the callback URL must start with `<PANEL_PUBLIC_URL>/api/v1/auth/steam/callback`.
4. **Claimed-id format.** `openid.claimed_id` starts with `https://steamcommunity.com/openid/id/` and ends with a 17-digit numeric `steam_id64`. We parse it.
5. **`check_authentication` to Steam.**
   ```
   POST https://steamcommunity.com/openid/login
   Content-Type: application/x-www-form-urlencoded
   <all openid.* params from the callback>&openid.mode=check_authentication
   ```
   The response must contain `is_valid:true`. Otherwise reject.
6. **Response-nonce single-use.** `SET steam-response-nonce:{openid.response_nonce} 1 NX EX 3600` → if NOT set (the value already existed), reject as replay.

After validation — the owner-trick path or the role-check path (see §5.3).

### 6.3 Pure function `verifyWithSteam`

In `apps/api/src/lib/steam-openid.ts`:

```ts
interface CallbackParams {
  // openid.* params
}

export interface SteamVerifyResult {
  steamId64: bigint;
  responseNonce: string;
}

export async function verifyWithSteam(params: CallbackParams): Promise<SteamVerifyResult>;
```

Tested with unit tests with a mocked `fetch` — checking the correctness of form serialisation and parsing of Steam's response.

---

## 7. Sliding sessions

### 7.1 Touch with a Redis SETNX throttle

In `apps/api/src/plugins/auth.ts`, after resolving the session:

```ts
const touchKey = `session-touch:${session.id}`;
const setOk = await app.redis.set(touchKey, '1', 'EX', SESSION_TOUCH_THROTTLE_SECONDS, 'NX');
if (setOk === 'OK') {
  const newExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await app.db.update(sessions)
    .set({ lastActivityAt: new Date(), expiresAt: newExpiresAt })
    .where(eq(sessions.id, session.id));
  await app.redis.set(`session:${session.id}`, JSON.stringify({...session, expiresAt: newExpiresAt}), 'EX', 600);
  // Set-Cookie header only when the DB was updated — otherwise the client gets a Set-Cookie on every request.
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_SECONDS,
  });
}
```

If Redis is unavailable — fall back to touching without throttling (correctness preserved, slightly more DB UPDATEs).

### 7.2 Session management endpoints

| Method | Path | Permission | Audit | Description |
|---|---|---|---|---|
| GET | `/api/v1/me/sessions` | self | no | List of the current user's active sessions: `{id, ip, userAgent, lastActivityAt, expiresAt, current: bool}`. Sort by `lastActivityAt DESC`. |
| DELETE | `/api/v1/me/sessions/:id` | self (id belongs to req.user) | `user.session.revoke` | Log out one session. Cleans the DB row + Redis cache. |
| DELETE | `/api/v1/me/sessions` | self | `user.session.revoke_all` | Log out from all devices. After the response the client itself does `clearCookie` + redirect to /login. |

The UI in `/settings/account` — a table + buttons. The current session is marked with a badge.

---

## 8. Pending players UI (no-role flow)

A «Доступ к панели» (Panel access) section is added to `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx`. It is shown only if the current user has the `user:manage_roles` permission. The wireframe below shows English glosses of the Russian UI copy.

```
┌──────────────────────────────────────────────────────┐
│ Panel access («Доступ к панели»)                     │
│                                                      │
│ Current roles:                                       │
│   • Moderator           [×]                          │
│   • Server Admin (Squad Server #2)  [×]              │
│                                                      │
│ Add a role:                                          │
│   ┌──────────────────────┐  ┌──────────┐             │
│   │ Select a role  ▼     │  │ Assign   │             │
│   └──────────────────────┘  └──────────┘             │
└──────────────────────────────────────────────────────┘
```

API endpoints:

| Method | Path | Permission | Audit |
|---|---|---|---|
| POST | `/api/v1/players/:steam_id64/roles` body `{role_id}` | `user:manage_roles` | `player.role.assign` |
| DELETE | `/api/v1/players/:steam_id64/roles/:role_id` | `user:manage_roles` | `player.role.revoke` |

The Owner role cannot be removed through this UI (server-side check + visual hint). The last remaining Owner also cannot be removed (lockout protection); explicit error `cannot_remove_last_owner`.

The "no-access" landing page for cookie-less errors: `/no-access?error=...&steam_id64=...`. Text: «Steam ID `7656...` не имеет доступа к панели. Обратитесь к администратору. Если вы Owner — проверьте журнал `/var/lib/squad-panel/.first-owner-claimed`.» (Steam ID `7656...` has no access to the panel. Contact the administrator. If you are the Owner — check the log `/var/lib/squad-panel/.first-owner-claimed`.)

---

## 9. Audit-log actor

Every authenticated request → an audit record with:

```
actor_kind = 'steam'
actor_steam_id64 = req.user.steamId64
actor_token_id = req.token?.id ?? null
actor_system_label = null
```

Background workers (status-reconciler, audit-archiver, event-partition):

```
actor_kind = 'system'
actor_steam_id64 = null
actor_token_id = null
actor_system_label = 'status-reconciler' (or another name)
```

Hash chain: the pre-existing logic in `apps/api/src/lib/audit.ts` is recomputed from scratch (new chain start, prev_hash = `\x00...`). It is documented in `docs/operations/migrations.md` that after `0008` the audit chain is validated only from the migration cutoff.

---

## 10. Setup wizard

### 10.1 Endpoints

| Method | Path | Audit | Description |
|---|---|---|---|
| GET | `/api/v1/setup/check-env` | no | Returns `{ok, checks}`. Checks: bridge ping, host OS, `PANEL_PUBLIC_URL` self-reachable, `STEAM_WEB_API_KEY` (optional, a separate info line), depot volume mounted. |
| POST | `/api/v1/setup/init` body `{name, slug?}` | `setup.init` | Atomically: insert organization + seed system roles + set `setup_complete=true`. If `setup_complete` is already true — 410 Gone. |

The old routes `/setup/org`, `/setup/owner`, `/setup/finalize` are removed.

### 10.2 UI `/setup/page.tsx`

```
Step 1: Environment check («Проверка окружения»)
  [green check] Bridge: connected (Ubuntu 24.04)
  [green check] Public URL: https://squad-panel.lan is reachable from this panel
  [gray info]   Steam Web API key: not set (optional)
  [green check] Depot volume: mounted

Step 2: Organization creation («Создание организации»)
  Name:      [Squad Community ABC___]
  Slug (auto): [squad-community-abc]
  [Create («Создать»)]

  → POST /setup/init → redirect /login

  /login — the «Войти через Steam» (Sign in with Steam) button → whoever logs in first becomes Owner.
```

---

## 11. Removed routes / code

| Code | Action |
|---|---|
| `POST /api/v1/auth/login` | DELETE |
| `POST /api/v1/me/totp/provision`, `/enable`, `/disable` | DELETE |
| `POST /api/v1/setup/org`, `/owner`, `/finalize` | DELETE |
| `apps/api/src/lib/argon.ts`, `lib/totp.ts`, `lib/crypto.ts` (if used only for TOTP) | DELETE — check that crypto is not used by anything else (audit-log encryption etc.); if it is — keep it and delete only the TOTP paths |
| `users.password_hash`, `totp_*` columns | DROP (via `DROP TABLE users CASCADE`) |
| `user_identities` | DROP (steam_id64 is now the native PK; Discord linking — a separate spec, a separate table later) |
| `apps/web/src/app/login/page.tsx` form | REWRITE — a single button instead of a form |
| `apps/web/src/app/(dashboard)/settings/account/page.tsx` TOTP secties | DELETE |
| `apps/api/src/routes/auth-discord.ts` | DELETE (Discord login is not needed; Discord linking — a separate spec) |

---

## 12. Testing strategy

### Tier 1 — unit

| File | Coverage |
|---|---|
| `apps/api/test/lib/steam-openid.test.ts` | `buildLoginRedirectUrl` — correct query params, URL-encoding. `parseCallbackParams` — happy path + missing fields. `verifyWithSteam` with a mocked `fetch` — `is_valid:true`/`false`, `claimed_id` parsing, response_nonce extraction. |
| `apps/api/test/lib/steam-profile.test.ts` | Mock fetch, check cache hit/miss, `null` when ENV is empty. |
| `apps/api/test/lib/first-owner.test.ts` | With an ephemeral test Postgres (existing test-db helper): `claimFirstOwner` happy path, the second call returns `'already_claimed'`, concurrent calls (10 in parallel) — exactly one `'claimed'`, the rest `'already_claimed'`, sentinel writes via a mocked bridge. |
| `apps/api/test/lib/sessions.test.ts` | Touch throttle: 100 parallel touches — exactly one UPDATE (mock Redis SETNX). Sliding TTL: `expiresAt` = `now() + 6h` after touch. |

### Tier 2 — integration (Fastify `inject()`)

| File | Coverage |
|---|---|
| `apps/api/test/auth-steam.test.ts` | `/auth/steam/login` sets the cookie + Redis nonce, the redirect URL is correct. `/auth/steam/callback` happy path → creates a session row. Negative paths: nonce mismatch → 400. nonce missing in Redis → 400. response_nonce replay → 400. claimed_id wrong format → 400. `check_authentication` returns `is_valid:false` → 400. |
| `apps/api/test/auth-steam-first-owner.test.ts` | Fresh DB → the first callback assigns the Owner role + sentinel created (mocked bridge). Second callback (different steamid) → no owner role, redirect to no-access. After `DELETE FROM organizations` (DB reset) + sentinel still present → the trick stays blocked. |
| `apps/api/test/setup-routes.test.ts` | `/setup/init` happy path. After init a second call → 410. `setup_complete=true` blocks all setup routes. |
| `apps/api/test/sessions-management.test.ts` | `GET /me/sessions` shows only req.user's sessions, `current: true` for the current one. `DELETE /me/sessions/:id` — cannot delete someone else's (404). Logout-all revokes all. |
| `apps/api/test/audit-coverage.test.ts` | The existing test is adapted — the `actor_user_id` check is replaced with a discriminated union. |

### Tier 3 — e2e

`apps/api/test/e2e/install-lifecycle.e2e.test.ts` — updated: instead of calling `/setup/owner` the test reads env `PANEL_TEST_OWNER_STEAM_ID64` + `PANEL_TEST_COOKIE` (a real cookie from an already logged-in Owner). If empty — the test prints instructions to the user and `test.skip`.

New test `apps/api/test/e2e/steam-login.e2e.test.ts`:

> This test **cannot be fully automated** — Steam OpenID requires a real Steam account.
>
> The test prints the instruction: "Log in via Steam at `https://<host>/login`, then set `PANEL_TEST_COOKIE` and press Enter". Next the test checks: `GET /me` returns permissions with Owner, `GET /me/sessions` shows the current session with the correct IP/UA, `DELETE /me/sessions/<id>` invalidates the cookie, after logging in again the sentinel is still set (checked via the bridge `file_read`).

If testing is required without interaction — an alternative: the helper `apps/api/test/helpers/steam-fake-callback.ts` creates a session directly via a DB insert (BYPASSING Steam OpenID validation) **only when `NODE_ENV=test`**. This helper is **not used** in the e2e test — it is only for tier-2 integration tests that validate post-validation behaviour (sessions, RBAC), not the validation itself.

---

## 13. Constraints and known risks

- **Steam OpenID 2.0** — a deprecated protocol, supported by Steam de facto only for backward compatibility. There is no replacement (Steam did not implement OAuth2/OIDC). If Steam turns off OpenID — the panel loses login. Mitigation: we document in `docs/components/auth/troubleshooting.md` that migrating to Steam OAuth (if it appears) is a priority TODO.
- **`STEAM_WEB_API_KEY` is optional** — without it `players.canonical_name` for non-server users will be a stub. The UI shows the stub without special handling.
- **The sentinel file is removed only manually** — the operator must know about `/var/lib/squad-panel/.first-owner-claimed` in order to re-initialise the panel. Documented in `docs/operations/setup.md` and `docs/operations/troubleshooting.md`.
- **Hash-chain audit** restarts with the migration. `pnpm verify:audit-chain` checks only post-migration rows. Documented in `docs/operations/migrations.md`.
- **Steam first-owner trick on a clean panel**: if an attacker intercepts the first Steam callback (XSS/CSRF on a fresh panel before the first login), they can become Owner. Mitigation — the `__Host-steam-nonce` cookie + Redis nonce + `return_to` host-binding (see §6). The Owner must initiate the first login right after `setup/init`.
- **Concurrent first-owner**: if two Steam callbacks arrive simultaneously (theoretically impossible for a single operator, but the protection is needed) — `pg_advisory_xact_lock` serialises them, exactly one claims.
- **Bridge unavailable during the first-owner claim**: the sentinel write fails → ROLLBACK of the whole transaction → the DB flag is not set → the trick remains available. This is correct behaviour, but the Owner gets an error and must retry the login.

---

## 14. Documentation impact

The following are updated during implementation:

- `docs/components/api/api.md` — new routes, removed routes.
- `docs/components/api/data-model.md` — new tables, FK changes.
- `docs/components/api/flows.md` — Steam login flow, first-owner trick, sliding sessions.
- `docs/components/api/configuration.md` — new ENV vars.
- `docs/components/api/testing.md` — new tests, e2e disclaimer about the Steam account.
- `docs/components/web/flows.md` — wizard, /login, /no-access, /settings/account changes.
- `docs/components/bridge/api.md` — the new allowlisted path (`/var/lib/squad-panel/.first-owner-claimed`).
- `docs/architecture/data-flow.md` — auth flow rewrite.
- `docs/architecture/decisions.md` — adds the ADR "Steam-only login + first-owner trick + steam_id64 PK".
- `docs/architecture/rbac.md` — players instead of users.
- `docs/operations/setup.md` — wizard flow, sentinel file.
- `docs/operations/migrations.md` — `0008` migration steps + rollback.
- `docs/operations/environment-variables.md` — `PANEL_PUBLIC_URL`, `STEAM_WEB_API_KEY`.
- `docs/operations/troubleshooting.md` — "how to reset first-owner to re-initialise", "how to reassign Owner if the last one lost Steam access".

---

## 15. Implementation order (for the plan stage)

1. Migration `0008` + Drizzle schema files + `pnpm db:generate` + sanity test.
2. `apps/api/src/lib/steam-openid.ts` + unit tests.
3. `apps/api/src/lib/steam-profile.ts` + unit tests.
4. `apps/api/src/lib/first-owner.ts` + unit tests + concurrent test.
5. Bridge allowlist update in `packages/shared-config/src/bridge-methods.ts` + Go handler config (already permits prefix-based allow if path matches `/var/lib/squad-panel/`, to be verified).
6. `sessions.ts` extension (touch throttle + last_activity_at).
7. `auth-steam.ts` route with the full validation pipeline.
8. `auth.ts` route — removal of password/TOTP, addition of session-management endpoints.
9. `setup.ts` route — simplified to `/init` + `/check-env`.
10. `auth.ts` plugin — middleware changes (touch + req.user shape).
11. `apps/web/src/app/login/page.tsx` — simplify.
12. `apps/web/src/app/setup/page.tsx` — two-step wizard.
13. `apps/web/src/app/(dashboard)/settings/account/page.tsx` — sessions UI.
14. `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` — role-assign section + endpoints.
15. `apps/web/src/app/no-access/page.tsx` — static page.
16. E2E test rewrite + new `steam-login.e2e.test.ts`.
17. Documentation updates (see §14).

---

## 16. Acceptance criteria

- [ ] A fresh `pnpm db:migrate` creates the schema without errors.
- [ ] `/login` shows only the «Войти через Steam» (Sign in with Steam) button.
- [ ] The setup wizard works: `/setup/check-env` → `/setup/init` → redirect to `/login`.
- [ ] The first Steam login after `/setup/init` creates a `players` row + Owner role + sentinel file.
- [ ] The second Steam login (a different steamid) without an assigned role → redirect to `/no-access`, no cookie is set.
- [ ] The Owner assigns a role to the second player via `/players/<steam_id64>` — a repeated Steam login grants a session.
- [ ] Sliding TTL: after 5 minutes of activity `expires_at` is refreshed, after 7 hours of inactivity the session is invalidated.
- [ ] `/settings/account` shows active sessions, logging out one/all works.
- [ ] `pnpm turbo run typecheck && pnpm turbo run test` are green.
- [ ] `pnpm --filter @squad/api test:e2e` is green (with a user-supplied `PANEL_TEST_COOKIE`).
- [ ] `pnpm verify:audit-chain` is green after the migration.
- [ ] `systemd-analyze security panel-host-bridge.service` < 3.0 (no regression).

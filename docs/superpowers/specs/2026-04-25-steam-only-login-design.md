# Steam-only login — design

**Status:** approved (brainstorming complete) — pending implementation plan
**Date:** 2026-04-25
**Owner:** Squad Panel Dev
**Source TZ:** §1.1–§1.6 (Steam OpenID, first-login Owner trick, setup wizard, sliding sessions, session management UI, linked identities)

---

## 1. Goals & non-goals

### Goals

- Steam OpenID 2.0 — единственный способ входа в панель.
- Первый Steam-логин после fresh-install автоматически становится Owner ровно один раз; повторный trick невозможен даже после drop-and-restore БД (двойной якорь: DB-flag + sentinel-file через bridge).
- Wizard первой инициализации создаёт **organization**; пользователь Owner создаётся через первый Steam-логин, не через wizard.
- Sliding session TTL 6 часов с обновлением не чаще раза в 60 секунд per session.
- Session management UI: список активных сессий, logout одной/всех.
- Steam_id64 — паспорт пользователя везде: audit-log актор, role-assignments, server-credentials author, config_versions author.

### Non-goals

- Email/password login — **полностью удаляется**.
- TOTP / backup codes — **полностью удаляются**.
- Discord login — **не делаем**. Discord остаётся как linked identity для notifications/Discord-бота (P1+, отдельный spec).
- API tokens — schema создаётся (для FK на token-id в audit-log), CRUD endpoints помечены P1+ и не реализуются в этой итерации.
- Steam Web API key — опционален; без него panel работает, persona/avatar не обогащаются.
- Migration-from-existing-data — у панели нет prod-data (pre-launch); миграция destructive forward-only.

---

## 2. Mental model

«Пользователь панели» как отдельная сущность не существует. Identity-якорь — `players.steam_id64 bigint PK`. Эта таблица уже есть и наполняется автоматически:

- `worker-rcon` upsert'ит player'а на каждом `ListPlayers` polling tick (см. `apps/workers/rcon/src/persist.ts`),
- `worker-log-ingest` парсит `player.connected` / `player.disconnected` события из `SquadGame.log`.

«Пользователь панели» = `player` с назначенной ролью в новой таблице `player_role_assignments`. Owner управляет доступом из карточки игрока (`/players/<steam_id64>`), а не из отдельного «pending users» UI. Pending = «player без ролей», что и так дефолтное состояние всех игроков сервера.

Steam OpenID callback:

1. Валидирует OpenID 2.0 response (см. §6).
2. Находит/создаёт `players` row по `steam_id64` (stub если игрок ни разу не был на сервере).
3. Опционально обогащает `canonical_name` через `GetPlayerSummaries` (если `STEAM_WEB_API_KEY` задан и `canonical_name` дефолтный stub).
4. Если это первый Steam-callback на свежей панели (см. §5) — выдаёт Owner role атомарно.
5. Иначе проверяет наличие role-assignment. Если ролей нет — 403 без сессии (cookie не ставится, redirect на `/login?error=not_authorized`).
6. Если роли есть — создаёт `sessions` row, ставит `__Host-sid` cookie, redirect на `/`.

---

## 3. Архитектура и слои кода

### 3.1 Новые/изменённые файлы

| Path | Назначение |
|---|---|
| `apps/api/src/lib/steam-openid.ts` | Pure-функции: `buildLoginRedirectUrl(returnTo, nonce)`, `parseCallbackParams(query)`, `verifyWithSteam(params): Promise<{steamId64, responseNonce}>`. Без I/O state — caller делает Redis nonce ops. ~120 строк. |
| `apps/api/src/lib/steam-profile.ts` | Wrapper над `GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/`. Возвращает `{persona, avatarUrl} \| null`. Кеш в Redis `steam-profile:{steamid}` TTL 1h. Молча возвращает `null` если ENV `STEAM_WEB_API_KEY` пустой. |
| `apps/api/src/lib/first-owner.ts` | `claimFirstOwner(steamId64): Promise<'claimed' \| 'already_claimed' \| 'no_owner_role'>`. См. §5 для алгоритма. |
| `apps/api/src/routes/auth-steam.ts` | `GET /api/v1/auth/steam/login` (redirect на Steam), `GET /api/v1/auth/steam/callback` (validation → first-owner OR role-check → session). Заменяет существующий 501-stub. |
| `apps/api/src/routes/auth.ts` | Удаляются: `POST /login`, `POST /me/totp/*`. Остаются: `POST /logout`, `GET /me`. Добавляется: `GET /me/sessions`, `DELETE /me/sessions/:id`, `DELETE /me/sessions` (logout all). |
| `apps/api/src/routes/setup.ts` | Сжимается до двух endpoints: `GET /setup/check-env`, `POST /setup/init`. Удаляются: `/setup/org`, `/setup/owner`, `/setup/finalize`. |
| `apps/api/src/lib/sessions.ts` | Расширяется: `last_activity_at`, sliding TTL touch с Redis SETNX throttle (см. §7). |
| `apps/api/src/plugins/auth.ts` | Middleware дополняется `touchSession()` после resolve. `req.user` теперь `{steamId64, canonicalName, avatarUrl, permissions, clearance}` без `email`/`displayName`. |
| `packages/db/src/schema/*` | Удаляются: `users.ts`, `user-identities.ts`, `user-role-assignments.ts`, `user-api-tokens.ts`. Добавляются: `player-role-assignments.ts`, `player-api-tokens.ts`. Изменяются: `sessions.ts`, `organization-members.ts`, `audit-log.ts`, `config-versions.ts`. |
| `packages/db/drizzle/0008_steam_only_auth.sql` | Один transaction, см. §4. |
| `packages/shared-config/src/bridge-methods.ts` | В `pathAllowlist` для `file_atomic_write`/`file_read` добавляется `/var/lib/squad-panel/.first-owner-claimed`. |
| `apps/web/src/app/login/page.tsx` | Заменяется на одну кнопку «Войти через Steam» → `window.location.href = '/api/v1/auth/steam/login'`. Email/password форма удаляется. |
| `apps/web/src/app/setup/page.tsx` | Двухшаговый wizard: env-check → форма «Название организации, slug» → `POST /api/v1/setup/init` → redirect на `/login`. |
| `apps/web/src/app/(dashboard)/settings/account/page.tsx` | Удаляется TOTP-секция. Добавляется секция «Активные сессии» с listing'ом и кнопками logout. |
| `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` | Добавляется секция «Доступ к панели» (видна с permission `user:manage_roles`): list ролей игрока, dropdown «Назначить роль», кнопка «Удалить роль». |
| `apps/web/src/app/no-access/page.tsx` | Новая статичная страница: «Steam ID `7656...` не имеет доступа. Обратитесь к администратору.» Используется как landing для cookie-less ошибок. |

### 3.2 ENV vars

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `PANEL_PUBLIC_URL` | да | — | api | `https://<host>` для построения `openid.return_to`. Wizard env-check проверяет, что GET на `<PANEL_PUBLIC_URL>/api/v1/health` возвращает к этой же панели. | нет |
| `STEAM_WEB_API_KEY` | нет | пусто | api | Если задан — обогащаем `players.canonical_name` персоной. Получается на https://steamcommunity.com/dev/apikey. | да |
| `SESSION_TTL_SECONDS` | нет | `21600` (6h) | api | TTL sliding session. Менять только в тестах. | нет |
| `SESSION_TOUCH_THROTTLE_SECONDS` | нет | `60` | api | Минимум между обновлениями `last_activity_at` per session. | нет |

---

## 4. Schema migration `0008_steam_only_auth.sql`

Один файл, single transaction, destructive forward-only. Откат — git revert + `psql -c 'DROP DATABASE admin; CREATE DATABASE admin'` + `pnpm db:migrate`. Документируется в `docs/operations/migrations.md`.

### 4.1 Дропается

```sql
DROP TABLE sessions, user_api_tokens, user_identities,
           user_role_assignments, organization_members,
           audit_log, config_versions, users CASCADE;
```

### 4.2 Создаётся

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
-- BEFORE UPDATE/DELETE trigger + hash-chain logic пересоздаются 1:1 по существующему коду

CREATE TABLE config_versions (
  -- existing columns: id uuid PK, server_id uuid, file_path text, content text,
  --                   sha256 bytea, commit_message text, created_at timestamptz
  -- замена author_user_id uuid → author_steam_id64 bigint NULL + author_label text NULL:
  author_steam_id64  bigint      REFERENCES players(steam_id64) ON DELETE SET NULL,
  author_label       text,
  CHECK ((author_steam_id64 IS NOT NULL) OR (author_label IS NOT NULL))
);
```

### 4.3 Изменяется

- `organizations.settings` — добавляется ключ `first_owner_claimed: boolean` (хранится в `jsonb`, не отдельной колонкой).
- `players` — без изменений; не добавляются `display_name`, `avatar_url`. Steam-persona переходит в `players.canonical_name` напрямую (RCON-воркер тоже пишет туда). Если хочется отдельный «display name видимый в панели» — отдельная миграция позже.

### 4.4 Drizzle codegen

`pnpm db:generate` после правки schema files → проверить что diff equivalent ручному `0008_*.sql` → коммитим оба файла одним коммитом.

---

## 5. First-login Owner trick

### 5.1 Двойной якорь

- **DB:** `organizations.settings.first_owner_claimed = true`.
- **Filesystem:** `/var/lib/squad-panel/.first-owner-claimed` (содержит JSON `{"steam_id64": "...", "claimed_at": "ISO8601"}`).

Trick активен ⟺ оба якоря не взведены. Если хотя бы один взведён — последующие logins проходят по обычному role-check пути.

### 5.2 Алгоритм `claimFirstOwner(steamId64)`

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
    if (!org) throw new Error('no_organization_yet'); // setup wizard ещё не пройден
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

    // 4. Sentinel — последним; если bridge упадёт, ROLLBACK откатит DB и trick остаётся доступен.
    await bridgeClient.fileAtomicWrite(
      '/var/lib/squad-panel/.first-owner-claimed',
      JSON.stringify({ steam_id64: String(steamId64), claimed_at: new Date().toISOString() }),
    );

    return 'claimed';
  });
}
```

Concurrency: `pg_advisory_xact_lock(hashtext('first_owner'))` сериализует параллельные callback'и. FOR UPDATE на organization row не достаточно потому что row может ещё не существовать в edge case (setup ещё не пройден).

### 5.3 Order в callback handler

```
parse + verify Steam OpenID
  ↓
upsert players (stub if not exists)
  ↓
optional: enrich canonical_name from GetPlayerSummaries
  ↓
claimFirstOwner(steamId64)
  ├── 'claimed'         → создать сессию, redirect /
  ├── 'already_claimed' → role check:
  │                         have roles → создать сессию, redirect /
  │                         no roles   → redirect /login?error=not_authorized (cookie не ставим)
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

Validation pipeline (любой шаг fail → 400 + redirect `/login?error=auth_failed`, audit запись):

1. **Nonce match.** `n` query param = `__Host-steam-nonce` cookie.
2. **Nonce single-use.** `GETDEL steam-nonce:{nonce}` → если `nil`, reject. Cookie очищаем.
3. **Return-to host-binding.** `openid.return_to` параметр в callback URL должен начинаться с `<PANEL_PUBLIC_URL>/api/v1/auth/steam/callback`.
4. **Claimed-id format.** `openid.claimed_id` начинается с `https://steamcommunity.com/openid/id/` и содержит 17-digit numeric `steam_id64` в конце. Парсим.
5. **`check_authentication` к Steam.**
   ```
   POST https://steamcommunity.com/openid/login
   Content-Type: application/x-www-form-urlencoded
   <все openid.* params из callback>&openid.mode=check_authentication
   ```
   Response должен содержать `is_valid:true`. Иначе reject.
6. **Response-nonce single-use.** `SET steam-response-nonce:{openid.response_nonce} 1 NX EX 3600` → если NOT set (значение существовало), reject as replay.

После validation — owner-trick path или role-check path (см. §5.3).

### 6.3 Pure-функция `verifyWithSteam`

В `apps/api/src/lib/steam-openid.ts`:

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

Тестируется юнит-тестами с mock'ом `fetch` — счёт правильности serialisation формы и парс ответа Steam'а.

---

## 7. Sliding sessions

### 7.1 Touch с Redis SETNX throttle

В `apps/api/src/plugins/auth.ts` после resolve session:

```ts
const touchKey = `session-touch:${session.id}`;
const setOk = await app.redis.set(touchKey, '1', 'EX', SESSION_TOUCH_THROTTLE_SECONDS, 'NX');
if (setOk === 'OK') {
  const newExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await app.db.update(sessions)
    .set({ lastActivityAt: new Date(), expiresAt: newExpiresAt })
    .where(eq(sessions.id, session.id));
  await app.redis.set(`session:${session.id}`, JSON.stringify({...session, expiresAt: newExpiresAt}), 'EX', 600);
  // Set-Cookie header только когда DB обновили — иначе клиент получает Set-Cookie на каждом request'е.
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_SECONDS,
  });
}
```

Если Redis недоступен — fallback к touch без throttling (correctness preserved, чуть больше DB UPDATE'ов).

### 7.2 Session management endpoints

| Method | Path | Permission | Audit | Описание |
|---|---|---|---|---|
| GET | `/api/v1/me/sessions` | self | нет | Список активных сессий текущего пользователя: `{id, ip, userAgent, lastActivityAt, expiresAt, current: bool}`. Sort by `lastActivityAt DESC`. |
| DELETE | `/api/v1/me/sessions/:id` | self (id принадлежит req.user) | `user.session.revoke` | Logout одной сессии. Чистит DB row + Redis cache. |
| DELETE | `/api/v1/me/sessions` | self | `user.session.revoke_all` | Logout из всех устройств. Клиент после ответа сам делает `clearCookie` + redirect /login. |

UI в `/settings/account` — таблица + кнопки. Текущая сессия помечена бейджем.

---

## 8. Pending players UI (no-role flow)

В `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` добавляется секция «Доступ к панели». Показывается только если у текущего пользователя есть permission `user:manage_roles`.

```
┌──────────────────────────────────────────────────────┐
│ Доступ к панели                                      │
│                                                      │
│ Текущие роли:                                        │
│   • Moderator           [×]                          │
│   • Server Admin (Squad Server #2)  [×]              │
│                                                      │
│ Добавить роль:                                       │
│   ┌──────────────────────┐  ┌──────────┐             │
│   │ Выберите роль  ▼     │  │ Назначить│             │
│   └──────────────────────┘  └──────────┘             │
└──────────────────────────────────────────────────────┘
```

API endpoints:

| Method | Path | Permission | Audit |
|---|---|---|---|
| POST | `/api/v1/players/:steam_id64/roles` body `{role_id}` | `user:manage_roles` | `player.role.assign` |
| DELETE | `/api/v1/players/:steam_id64/roles/:role_id` | `user:manage_roles` | `player.role.revoke` |

Owner role нельзя удалить через этот UI (server-side check + visual hint). Самый последний Owner — также нельзя удалить (защита от lockout); явная ошибка `cannot_remove_last_owner`.

«No-access» landing для cookie-less ошибок: `/no-access?error=...&steam_id64=...`. Текст: «Steam ID `7656...` не имеет доступа к панели. Обратитесь к администратору. Если вы Owner — проверьте журнал `/var/lib/squad-panel/.first-owner-claimed`.»

---

## 9. Audit-log актор

Каждый authenticated request → audit запись с:

```
actor_kind = 'steam'
actor_steam_id64 = req.user.steamId64
actor_token_id = req.token?.id ?? null
actor_system_label = null
```

Background воркеры (status-reconciler, audit-archiver, event-partition):

```
actor_kind = 'system'
actor_steam_id64 = null
actor_token_id = null
actor_system_label = 'status-reconciler' (или другое имя)
```

Hash chain: pre-existing logic в `apps/api/src/lib/audit.ts` пересчитывается с нуля (новый chain start, prev_hash = `\x00...`). Документируется в `docs/operations/migrations.md` что после `0008` audit-chain валидируется только от migration cutoff.

---

## 10. Setup wizard

### 10.1 Endpoints

| Method | Path | Audit | Описание |
|---|---|---|---|
| GET | `/api/v1/setup/check-env` | нет | Возвращает `{ok, checks}`. Checks: bridge ping, host OS, `PANEL_PUBLIC_URL` self-reachable, `STEAM_WEB_API_KEY` (опциональный, отдельная info-строка), depot volume mounted. |
| POST | `/api/v1/setup/init` body `{name, slug?}` | `setup.init` | Атомарно: insert organization + seed system roles + set `setup_complete=true`. Если `setup_complete` уже true — 410 Gone. |

Старые routes `/setup/org`, `/setup/owner`, `/setup/finalize` — удаляются.

### 10.2 UI `/setup/page.tsx`

```
Шаг 1: Проверка окружения
  [zelёная галка] Bridge: подключен (Ubuntu 24.04)
  [zelёная галка] Public URL: https://squad-panel.lan доступен с этой панели
  [серая инфо]   Steam Web API key: не задан (опционально)
  [zelёная галка] Depot volume: смонтирован

Шаг 2: Создание организации
  Название:  [Squad Community ABC___]
  Slug (auto): [squad-community-abc]
  [Создать]

  → POST /setup/init → redirect /login

  /login — кнопка «Войти через Steam» → первый, кто залогинится, станет Owner.
```

---

## 11. Removed routes / code

| Code | Action |
|---|---|
| `POST /api/v1/auth/login` | DELETE |
| `POST /api/v1/me/totp/provision`, `/enable`, `/disable` | DELETE |
| `POST /api/v1/setup/org`, `/owner`, `/finalize` | DELETE |
| `apps/api/src/lib/argon.ts`, `lib/totp.ts`, `lib/crypto.ts` (если используется только для TOTP) | DELETE — проверить, что crypto не используется чем-то ещё (audit-log encryption и т.п.); если используется — оставить, удалить только TOTP-paths |
| `users.password_hash`, `totp_*` columns | DROP (через `DROP TABLE users CASCADE`) |
| `user_identities` | DROP (steam_id64 теперь нативный PK; Discord-linking — отдельный спек, отдельная таблица позже) |
| `apps/web/src/app/login/page.tsx` form | REWRITE — одна кнопка вместо form |
| `apps/web/src/app/(dashboard)/settings/account/page.tsx` TOTP secties | DELETE |
| `apps/api/src/routes/auth-discord.ts` | DELETE (Discord login не нужен; Discord linking — отдельный спек) |

---

## 12. Testing strategy

### Tier 1 — unit

| File | Coverage |
|---|---|
| `apps/api/test/lib/steam-openid.test.ts` | `buildLoginRedirectUrl` — правильные query params, URL-encoding. `parseCallbackParams` — happy path + missing fields. `verifyWithSteam` с mock'нутым `fetch` — `is_valid:true`/`false`, `claimed_id` парс, response_nonce extract. |
| `apps/api/test/lib/steam-profile.test.ts` | Mock fetch, проверяем cache hit/miss, `null` когда ENV пустой. |
| `apps/api/test/lib/first-owner.test.ts` | С эфемерной тестовой Postgres (existing test-db helper): `claimFirstOwner` happy path, second call returns `'already_claimed'`, concurrent calls (10 параллельных) — ровно один `'claimed'`, остальные `'already_claimed'`, sentinel writes via mocked bridge. |
| `apps/api/test/lib/sessions.test.ts` | Touch throttle: 100 параллельных touch — ровно один UPDATE (mock Redis SETNX). Sliding TTL: `expiresAt` = `now() + 6h` после touch. |

### Tier 2 — integration (Fastify `inject()`)

| File | Coverage |
|---|---|
| `apps/api/test/auth-steam.test.ts` | `/auth/steam/login` ставит cookie + Redis nonce, redirect URL правильный. `/auth/steam/callback` happy path → создаёт session row. Negative paths: nonce mismatch → 400. nonce missing in Redis → 400. response_nonce replay → 400. claimed_id wrong format → 400. `check_authentication` returns `is_valid:false` → 400. |
| `apps/api/test/auth-steam-first-owner.test.ts` | Fresh DB → first callback assigns Owner role + sentinel created (mocked bridge). Second callback (different steamid) → no owner role, redirect no-access. После `DELETE FROM organizations` (DB reset) + sentinel still present → trick остаётся блокированным. |
| `apps/api/test/setup-routes.test.ts` | `/setup/init` happy path. После init второй call → 410. `setup_complete=true` блокирует все setup routes. |
| `apps/api/test/sessions-management.test.ts` | `GET /me/sessions` показывает только сессии req.user, `current: true` для текущей. `DELETE /me/sessions/:id` — нельзя удалить чужую (404). Logout-all отзывает все. |
| `apps/api/test/audit-coverage.test.ts` | Существующий тест адаптируется — заменяется проверка `actor_user_id` на дискриминированный union. |

### Tier 3 — e2e

`apps/api/test/e2e/install-lifecycle.e2e.test.ts` — обновляется: вместо вызова `/setup/owner` тест читает env `PANEL_TEST_OWNER_STEAM_ID64` + `PANEL_TEST_COOKIE` (real cookie от уже залогиненного Owner). Если пуст — тест выводит инструкцию пользователю и `test.skip`.

Новый тест `apps/api/test/e2e/steam-login.e2e.test.ts`:

> Этот тест **не может быть полностью автоматизирован** — Steam OpenID требует реального Steam-аккаунта.
>
> Тест выводит инструкцию: «Залогинься через Steam на `https://<host>/login`, затем установи `PANEL_TEST_COOKIE` и нажми Enter». Дальше тест проверяет: `GET /me` возвращает permissions с Owner, `GET /me/sessions` показывает текущую сессию с правильным IP/UA, `DELETE /me/sessions/<id>` инвалидирует cookie, после повторного логина sentinel всё ещё взведён (проверяется через bridge `file_read`).

Если testing требуется без интерактива — alternative: helper `apps/api/test/helpers/steam-fake-callback.ts` создаёт сессию напрямую через DB insert (BYPASS Steam OpenID validation) **только когда `NODE_ENV=test`**. Этот helper **не используется** в e2e тесте — он только для tier-2 интеграционных тестов где валидируется поведение после-валидации (sessions, RBAC), не сама валидация.

---

## 13. Ограничения и известные риски

- **Steam OpenID 2.0** — deprecated протокол, поддерживается Steam'ом de-facto только для backward compat. Замены нет (Steam не реализовал OAuth2/OIDC). Если Steam отключит OpenID — панель потеряет login. Mitigation: документируем в `docs/components/auth/troubleshooting.md` что миграция на Steam OAuth (если появится) — приоритетный TODO.
- **`STEAM_WEB_API_KEY` опционален** — без него `players.canonical_name` для не-серверных пользователей будет stub'ом. UI показывает stub без специальной обработки.
- **Sentinel-файл удаляется только вручную** — оператор должен знать про `/var/lib/squad-panel/.first-owner-claimed` чтобы переинициализировать панель. Документируется в `docs/operations/setup.md` и `docs/operations/troubleshooting.md`.
- **Hash-chain audit** рестартует с миграцией. `pnpm verify:audit-chain` проверяет только пост-миграционные строки. Документируется в `docs/operations/migrations.md`.
- **Steam-first-owner-trick на чистой панели**: если злоумышленник перехватит первый Steam-callback (XSS/CSRF на свежей панели до первого логина), он может стать Owner. Mitigation — `__Host-steam-nonce` cookie + Redis nonce + `return_to` host-binding (см. §6). Owner должен инициировать первый login сразу после `setup/init`.
- **Concurrent first-owner**: если два Steam-callback'а пришли одновременно (теоретически невозможно у одного оператора, но защита нужна) — `pg_advisory_xact_lock` сериализует, ровно один claim'ит.
- **Bridge unavailable во время first-owner claim**: sentinel write упадёт → ROLLBACK всей транзакции → DB-flag не взводится → trick остаётся доступен. Корректное поведение, но Owner получит ошибку и должен повторить login.

---

## 14. Documentation impact

При реализации обновляются:

- `docs/components/api/api.md` — новые routes, удалённые routes.
- `docs/components/api/data-model.md` — новые таблицы, изменения FK.
- `docs/components/api/flows.md` — Steam login flow, first-owner trick, sliding sessions.
- `docs/components/api/configuration.md` — новые ENV vars.
- `docs/components/api/testing.md` — новые тесты, e2e disclaimer про Steam-account.
- `docs/components/web/flows.md` — wizard, /login, /no-access, /settings/account changes.
- `docs/components/bridge/api.md` — новый allowlisted path (`/var/lib/squad-panel/.first-owner-claimed`).
- `docs/architecture/data-flow.md` — auth flow rewrite.
- `docs/architecture/decisions.md` — добавляется ADR «Steam-only login + first-owner trick + steam_id64 PK».
- `docs/architecture/rbac.md` — players вместо users.
- `docs/operations/setup.md` — wizard flow, sentinel-файл.
- `docs/operations/migrations.md` — `0008` migration steps + откат.
- `docs/operations/environment-variables.md` — `PANEL_PUBLIC_URL`, `STEAM_WEB_API_KEY`.
- `docs/operations/troubleshooting.md` — «как сбросить first-owner для переинициализации», «как переназначить Owner если последний потерял Steam access».

---

## 15. Implementation order (для plan stage)

1. Migration `0008` + Drizzle schema files + `pnpm db:generate` + sanity test.
2. `apps/api/src/lib/steam-openid.ts` + unit tests.
3. `apps/api/src/lib/steam-profile.ts` + unit tests.
4. `apps/api/src/lib/first-owner.ts` + unit tests + concurrent test.
5. Bridge allowlist update в `packages/shared-config/src/bridge-methods.ts` + Go handler config (already permits prefix-based allow if path matches `/var/lib/squad-panel/`, проверить).
6. `sessions.ts` extension (touch throttle + last_activity_at).
7. `auth-steam.ts` route с full validation pipeline.
8. `auth.ts` route — удаление password/TOTP, добавление session-management endpoints.
9. `setup.ts` route — упрощение до `/init` + `/check-env`.
10. `auth.ts` plugin — middleware изменения (touch + req.user shape).
11. `apps/web/src/app/login/page.tsx` — simplify.
12. `apps/web/src/app/setup/page.tsx` — двухшаговый wizard.
13. `apps/web/src/app/(dashboard)/settings/account/page.tsx` — sessions UI.
14. `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` — role-assign секция + endpoints.
15. `apps/web/src/app/no-access/page.tsx` — статичная страница.
16. E2E test rewrite + new `steam-login.e2e.test.ts`.
17. Documentation updates (см. §14).

---

## 16. Acceptance criteria

- [ ] Свежая `pnpm db:migrate` создаёт схему без ошибок.
- [ ] `/login` показывает только кнопку «Войти через Steam».
- [ ] Setup wizard работает: `/setup/check-env` → `/setup/init` → redirect на `/login`.
- [ ] Первый Steam-логин после `/setup/init` создаёт `players` row + Owner role + sentinel-файл.
- [ ] Второй Steam-логин (другой steamid) без назначенной роли → redirect `/no-access`, cookie не ставится.
- [ ] Owner назначает роль второму player'у через `/players/<steam_id64>` — повторный Steam-логин выдаёт сессию.
- [ ] Sliding TTL: после 5 минут активности `expires_at` обновлён, после 7 часов inactivity сессия инвалидируется.
- [ ] `/settings/account` показывает активные сессии, logout одной/всех работает.
- [ ] `pnpm turbo run typecheck && pnpm turbo run test` зелёные.
- [ ] `pnpm --filter @squad/api test:e2e` зелёные (с user-supplied `PANEL_TEST_COOKIE`).
- [ ] `pnpm verify:audit-chain` зелёный после migration.
- [ ] `systemd-analyze security panel-host-bridge.service` < 3.0 (без regression).

# Panel RBAC — Design

**Status**: design approved 2026-04-25, implementation pending
**Scope**: Эпик 2 — права на доступ к самой web-панели
**Out of scope**: Squad in-game admin groups (Эпик 3 — отдельный, эта работа лишь добавляет stub-permissions для него)

---

## 1. Цель и инварианты

Панель использует permission-key модель. Роль = имя + цвет + флаг `is_system_role` + набор permission-keys. Один пользователь имеет одну роль либо ни одной. Роль глобальна. Никакой иерархии и clearance — кто может больше, у того просто больше галочек.

**Архитектурный инвариант**: `players.role_id IS NULL` ⇔ "нет доступа в панель". Это единственное место правды; никаких параллельных state в session-claims, JWT или Redis.

**Owner**: единственная защищённая роль. Не редактируется, не удаляется, не переименовывается. Защищена двумя инвариантами:
1. На API: PUT/DELETE для роли с `is_system_role = true AND name = 'Owner'` возвращают 400.
2. На API: при PUT `/players/:id/role` с переходом "Owner → не-Owner" — если бы это оставило систему без Owner, ответ 409 `cannot_remove_last_owner`.

---

## 2. Решения и trade-offs

| # | Решение | Альтернативы | Почему так |
|---|---|---|---|
| 1 | Single-role: новая колонка `players.role_id uuid NULL`, дроп M:N таблицы `player_role_assignments` | Оставить M:N с UNIQUE-индексом по steam\_id64 | Pre-launch стадия. M:N "симулирующая 1:1" — техдолг с первого дня. Спека написана от единственной роли как от инварианта. |
| 2 | Без `clearance_level`. `user:manage_roles` даёт право назначить любую роль | Отдельный `role:assign_owner` для эскалации | Спека буквально: "никаких clearance, ранжирования или иерархии". Эскалация — ответственность оператора (давать `user:manage_roles` только доверенным). |
| 3 | Дропаем `role_server_scopes` целиком | Оставить как dormant schema | Никогда не enforced. Pre-launch — миграция вернёт легко если понадобится. |
| 4 | Дропаем `organizations` + `organization_members`. Появляется singleton `panel_meta` | Оставить org-scaffolding | Multi-tenancy не используется и не планируется в обозримом. Пользователь явно разрешил снос. |
| 5 | Permission registry — массив объектов `{key, category, label, dangerous?, unimplemented?}` | Плоский массив + side-map с метаданными; БД-таблица permissions | Один источник правды, типы выводятся, добавление permission остаётся one-line append без миграции. |
| 6 | Полный permission registry сразу — включая P2 `unimplemented`-стабы | Только ключи под существующий код | Спека описывает зрелое состояние. UI редактора с самого начала выглядит правильно; новые routes — `config: { permissions: [...] }` без правки registry. |
| 7 | 5 системных ролей. `is_system_role = true` только у Owner | Все 5 системные / без флага вообще | Owner — единственная неприкосновенная. Senior Admin / Admin / Moderator / Viewer — preset, оператор свободно правит и удаляет. |
| 8 | Две точки управления ролью: `/users` (новая) + упрощённый PanelAccessSection на `/players/:id` | Только одна из двух | Спека требует `/users` со списком имеющих роль; in-place workflow на `/players/:id` уже есть и удобен ("смотрю на проблемного игрока — выдаю роль"). |
| 9 | Setup wizard уходит. First-login Owner trick на Steam-callback | Сохранить env-check page | Wizard теряет работу после дропа orgs; first-login trick ровно как в спеке. |
| 10 | Полные before/after snapshots в audit | Только diff; без snapshots | Совпадает с подходом для config\_versions; reconstruct состояния прост. |
| 11 | Точечная инвалидация in-memory кэша + TTL 30s | Redis pub/sub; снести кэш | Multi-instance API сейчас не нужен. Точечная инвалидация даёт мгновенный эффект; TTL — safety-net. |
| 12 | TRUNCATE `player_api_tokens` в миграции | Map permission renames в scopes; ничего не делать | Pre-launch, никаких реальных токенов. |
| 13 | Палитра 16 фиксированных цветов (slug-имена под Tailwind), цвет = маркер-точка | Свободный hex; pill с названием | UX — pill с названием везде шумит; точка достаточна для "разница в цветах". 16 цветов гарантированно читаемы на тёмной теме без runtime-проверки контраста. |

---

## 3. Data model

### Новая таблица `panel_meta`

Singleton — одна строка, защищённая CHECK.

```sql
CREATE TABLE panel_meta (
  id                    smallint     PRIMARY KEY DEFAULT 1,
  first_owner_claimed   boolean      NOT NULL DEFAULT false,
  roles_seeded          boolean      NOT NULL DEFAULT false,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT panel_meta_singleton CHECK (id = 1)
);
INSERT INTO panel_meta (id) VALUES (1);
```

`first_owner_claimed` ставится в `true` в той же транзакции, что и `players.role_id = <Owner>` при первом успешном Steam-логине.
`roles_seeded` ставится в `true` той же миграцией, после INSERT'ов системных ролей. Никакого повторного сидера в API.

### Изменения `players`

```sql
ALTER TABLE players
  ADD COLUMN role_id uuid REFERENCES roles(id) ON DELETE SET NULL;
CREATE INDEX players_role_id_idx ON players(role_id) WHERE role_id IS NOT NULL;
```

NULL — нет доступа в панель → редирект на `/no-access`. `ON DELETE SET NULL` — при удалении роли все носители теряют доступ, но `players` запись и история сохраняются.

### Изменения `roles`

```sql
ALTER TABLE roles DROP COLUMN org_id;
ALTER TABLE roles DROP COLUMN clearance_level;
ALTER TABLE roles DROP CONSTRAINT roles_clearance_range;
ALTER TABLE roles ADD COLUMN color text NOT NULL DEFAULT 'neutral';
ALTER TABLE roles ADD CONSTRAINT roles_color_palette CHECK (
  color IN ('red','rose','pink','fuchsia','purple','violet','indigo','blue',
            'sky','cyan','teal','emerald','green','lime','amber','neutral')
);
DROP INDEX IF EXISTS roles_org_name_key;
CREATE UNIQUE INDEX roles_name_key ON roles(name);
```

`name` теперь UNIQUE глобально (раньше — `(org_id, name)`).

### Удаляемые таблицы

```sql
DROP TABLE IF EXISTS player_role_assignments CASCADE;
DROP TABLE IF EXISTS role_server_scopes      CASCADE;
DROP TABLE IF EXISTS organization_members    CASCADE;
DROP TABLE IF EXISTS organizations           CASCADE;
ALTER TABLE audit_log DROP COLUMN org_id;
TRUNCATE player_api_tokens;
DELETE FROM role_permissions;  -- сидер перезальёт
```

### Сидер 5 ролей в SQL миграции

`Owner` (red, system) / `Senior Admin` (amber) / `Admin` (sky) / `Moderator` (emerald) / `Viewer` (neutral). Точные permission-set'ы — секция 4. После INSERT'ов и заливки `role_permissions` — `UPDATE panel_meta SET roles_seeded = true`.

### Drizzle schema files

- **Удалить**: `organizations.ts`, `organization-members.ts`, `role-server-scopes.ts`, `player-role-assignments.ts`.
- **Изменить**: `roles.ts` (без `orgId`/`clearanceLevel`, +`color`), `players.ts` (+`roleId`), `audit-log.ts` (без `orgId`).
- **Создать**: `panel-meta.ts`.

---

## 4. Permission registry

### Shape

`packages/shared-config/src/permissions.ts` — registry-объекты:

```ts
export const PERMISSION_CATEGORIES = [
  'servers', 'configs', 'players', 'moderation',
  'admin_groups', 'whitelist', 'host', 'audit',
  'events', 'users', 'roles', 'backup',
  'api_tokens', 'discord', 'triggers', 'scheduler',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDef {
  key: string;
  category: PermissionCategory;
  label: string;
  dangerous?: true;
  unimplemented?: true;
}

export const PERMISSIONS: readonly PermissionDef[] = [ /* see below */ ];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
```

### Полный registry

| Category | Key | Label (ru) | Flags |
|---|---|---|---|
| servers | `server:view` | Видеть серверы и их статус | |
| servers | `server:install` | Устанавливать серверы | dangerous |
| servers | `server:start` | Start сервера | |
| servers | `server:stop` | Stop (graceful) | |
| servers | `server:force_stop` | Force-stop (kill) | dangerous |
| servers | `server:restart` | Restart | |
| servers | `server:delete` | Удалить сервер с очисткой | dangerous |
| servers | `server:edit_settings` | Resource limits, ports, max\_players | |
| servers | `server:update` | app\_update через SteamCMD | |
| configs | `config:view` | Читать .cfg файлы | |
| configs | `config:edit` | Редактировать через Monaco | |
| configs | `config:rollback` | Откат к предыдущей версии | |
| players | `player:view` | Список игроков, ник, SteamID | |
| players | `player:view_ips` | История IP | |
| players | `player:view_notes` | Заметки про игрока | unimplemented |
| players | `player:edit_notes` | Редактировать заметки | unimplemented |
| players | `player:set_flags` | Custom теги (toxic, helpful) | unimplemented |
| moderation | `mod:kick` | Kick через UI | dangerous, unimplemented |
| moderation | `mod:warn` | Warn | unimplemented |
| moderation | `mod:ban_temp` | Temp ban | dangerous, unimplemented |
| moderation | `mod:ban_perm` | Permanent ban | dangerous, unimplemented |
| moderation | `mod:unban` | Unban | unimplemented |
| admin\_groups | `admin_group:view` | Видеть Admins.cfg | unimplemented |
| admin\_groups | `admin_group:edit` | Редактировать Admins.cfg | unimplemented |
| whitelist | `whitelist:view` | Видеть whitelist | unimplemented |
| whitelist | `whitelist:edit` | Управлять whitelist | unimplemented |
| host | `host:view` | Dashboard host info | |
| host | `host:metrics` | Метрики (CPU/RAM/Disk/Net + история) | |
| audit | `audit:view` | Читать audit log | |
| audit | `audit:export` | Export audit в CSV | unimplemented |
| events | `events:view` | Game events log | |
| users | `user:view` | Список пользователей панели | |
| users | `user:manage_roles` | Назначать роли | dangerous |
| roles | `role:view` | Видеть роли | |
| roles | `role:create` | Создавать роли | |
| roles | `role:edit` | Редактировать роли | |
| roles | `role:delete` | Удалять роли | dangerous |
| backup | `backup:view` | Список backups | unimplemented |
| backup | `backup:trigger` | Запустить backup | unimplemented |
| backup | `backup:restore` | Restore из snapshot | dangerous, unimplemented |
| api\_tokens | `api_token:create` | Создавать API tokens | |
| api\_tokens | `api_token:revoke` | Ревокать tokens | |
| discord | `discord:link` | Привязать Discord | unimplemented |
| triggers | `trigger:view` | Видеть авто-правила | unimplemented |
| triggers | `trigger:edit` | Редактировать авто-правила | unimplemented |
| scheduler | `scheduler:view` | Видеть запланированные задачи | unimplemented |
| scheduler | `scheduler:edit` | Редактировать расписание | unimplemented |

### Renames из существующего кода

| Было | Стало |
|---|---|
| `server:create` | дропается (поглощён `server:install`) |
| `server:edit` | `server:edit_settings` |
| `server:config:write` | `config:edit` |
| `server:config:history` | `config:rollback` (плюс новый `config:view`) |
| `player:view_eos_id` | дропается (часть `player:view`) |
| `player:view_steam_id` | дропается (часть `player:view`) |
| `user:create` / `user:edit` / `user:delete` | дропаются (нет такого workflow) |
| `role:manage` | разбивается на `role:view` / `role:create` / `role:edit` / `role:delete` |
| `permission:manage` | дропается (registry — статика в коде) |
| `host:bridge_control` | дропается (нет UI) |
| `org:view` / `org:edit` | дропаются (orgs убраны) |

Все `config: { permissions: [...] }` в существующих routes обновляются в той же серии коммитов. `audit-coverage.test.ts` ловит пропуски.

### Дефолтные permission sets для системных ролей

| Роль | Permissions |
|---|---|
| **Owner** | все ключи из `PERMISSIONS` (включая unimplemented) |
| **Senior Admin** | всё кроме `server:delete`, `role:delete`, `backup:restore` |
| **Admin** | `server:view/start/stop/restart/edit_settings`, `config:view/edit/rollback`, `player:view/view_ips`, `mod:kick/warn/ban_temp/unban`, `admin_group:view`, `whitelist:view/edit`, `host:view/metrics`, `audit:view`, `events:view`, `api_token:create/revoke` |
| **Moderator** | `server:view`, `player:view`, `mod:kick/warn/ban_temp/unban`, `events:view` |
| **Viewer** | `server:view`, `config:view`, `player:view`, `audit:view`, `host:view`, `events:view`, `role:view`, `user:view`, `admin_group:view`, `whitelist:view`, `backup:view`, `trigger:view`, `scheduler:view` |

### Палитра цветов

`packages/shared-config/src/role-colors.ts`:

```ts
export const ROLE_COLORS = [
  'red', 'rose', 'pink', 'fuchsia', 'purple', 'violet', 'indigo', 'blue',
  'sky', 'cyan', 'teal', 'emerald', 'green', 'lime', 'amber', 'neutral',
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
```

Slug-имена соответствуют Tailwind-классам (`bg-red-500`, `text-red-400` и т.д.) — никаких ad-hoc маппингов в UI. CHECK в SQL дублирует список — синхронизация enforced unit-тестом.

---

## 5. API surface

### Новые / изменённые endpoints

| Метод | Path | Permission | Audit action | Body / response |
|---|---|---|---|---|
| GET | `/api/v1/permissions` | `role:view` | — | `[{key, category, label, dangerous?, unimplemented?}, ...]` |
| GET | `/api/v1/roles` | `role:view` | — | `[{id, name, color, is_system_role, description, permissions: [...], assigned_users_count}, ...]` |
| POST | `/api/v1/roles` | `role:create` | `role.create` | body: `{ name, color, description?, permissions: PermissionKey[] }` |
| GET | `/api/v1/roles/:id` | `role:view` | — | full role object |
| PUT | `/api/v1/roles/:id` | `role:edit` | `role.update` | body: `{ name?, color?, description?, permissions? }`. 400 для Owner |
| DELETE | `/api/v1/roles/:id` | `role:delete` | `role.delete` | 400 для Owner. Каскад `players.role_id = NULL` |
| GET | `/api/v1/users` | `user:view` | — | `[{steam_id64, canonical_name, role: {...}, assigned_at, assigned_by, last_seen_at}, ...]` |
| GET | `/api/v1/players/:steamId/role` | `user:view` | — | `{role: {...} \| null}` |
| PUT | `/api/v1/players/:steamId/role` | `user:manage_roles` | `player.role.assign` | body: `{ role_id: uuid \| null }`. 409 при попытке снять последнего Owner |

### Удаляемые endpoints

- `GET /api/v1/players/:steamId/roles` (M:N list)
- `POST /api/v1/players/:steamId/roles` (M:N add)
- `DELETE /api/v1/players/:steamId/roles/:roleId` (M:N remove)
- `GET /api/v1/setup/check-env`
- `POST /api/v1/setup/init`

### First-login Owner trick

В `apps/api/src/routes/auth-steam.ts` после успешного Steam OpenID, **внутри одной транзакции** с advisory-lock'ом (паттерн из `d854971`):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('panel_meta_first_owner', 0));
SELECT first_owner_claimed FROM panel_meta WHERE id = 1;
-- if NOT first_owner_claimed AND NOT EXISTS (SELECT 1 FROM players p
--   JOIN roles r ON r.id = p.role_id WHERE r.name = 'Owner'):
UPDATE players SET role_id = (SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true)
  WHERE steam_id64 = $1;
UPDATE panel_meta SET first_owner_claimed = true WHERE id = 1;
COMMIT;
```

Если флаг уже `true` или Owner существует — обычный flow: cookie ставится, дальше middleware решает (роль есть → панель, нет → `/no-access`).

### Cache invalidation

В `apps/api/src/lib/rbac.ts`:

```ts
export function invalidatePermissionCache(steamId64: bigint): void;
export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void>;
```

Вызывается:
- `PUT /players/:id/role` → `invalidatePermissionCache(steamId64)`.
- `PUT /roles/:id` (изменили permissions) → `invalidatePermissionCacheForRole(roleId)`.
- `DELETE /roles/:id` → `invalidatePermissionCacheForRole(roleId)` (носители всё равно потеряют роль через `ON DELETE SET NULL`, но кэш чистим явно).

TTL 30s остаётся как safety-net.

### Удаляемые из rbac.ts

- `hasServerPermission` — нет per-server scoping.
- Логика `clearance` в `loadUserPermissions` (была `MAX` по нескольким ролям, теперь не нужна).

---

## 6. UI

### Новые страницы

**`/roles`** (permission `role:view`)
Список ролей. Колонки: цветной маркер-точка слева от имени, имя, описание, "пользователей: N", `is_system_role` бэдж "Системная" для Owner, кнопки "Редактировать" / "Удалить" (последняя disabled для Owner). Кнопка "Создать роль" наверху (только если permission `role:create`).

**`/roles/new`** и **`/roles/:id`** (permissions `role:create` / `role:edit`)
Редактор роли. Блоки:
1. Имя (`<input>`) + color-picker (16 swatch'ей grid).
2. Описание (`<textarea>` опционально).
3. Permissions: search-bar (filter realtime по `label.toLowerCase().includes(q) || key.includes(q)`), под ним 16 категорий в трёхколоночном responsive grid. В каждой категории — чекбоксы с label, ⚠️-бейдж справа для `dangerous`, "затенённый" стиль (opacity-50 + подпись "в разработке") для `unimplemented`.
4. Owner — read-only mode: вместо кнопки "Сохранить" — alert "Системная роль. Permissions нельзя редактировать.", все чекбоксы disabled.
5. Кнопка "Скопировать права из…" (P1, dropdown с другими ролями) в форме создания. При выборе чекбоксы пред-заполняются permissions выбранной роли.
6. Кнопки "Сохранить" / "Отмена".

**`/users`** (permission `user:view`)
Таблица. Колонки: ник + цветная точка-роли, SteamID64 (моноширинный, ссылка на Steam profile), название роли, кто/когда назначил, last\_seen. Кнопка "Назначить роль игроку" → modal: typeahead-поиск по `players` (debounced GET к `/api/v1/players?q=`), при выборе — dropdown ролей (пустых option = "снять роль" нет, для назначения отсутствие роли не имеет смысла), кнопка "Назначить" (требует `user:manage_roles`).

При выборе **Owner** в любом dropdown'е (на `/users` или на `/players/:id`) — confirm-dialog: "Это даст пользователю **полный доступ** к панели. Подтвердить?" Без подтверждения PUT не отправляется. Снижает риск эскалации (см. Section 10).

### Изменяемые страницы

**`/players/:steam_id64`** — секция `PanelAccessSection`
Сейчас (после `825d94c`) рисует список из нескольких ролей с кнопками "Удалить". После изменений: одно поле "Роль" — read-only текст с цветной точкой если роль есть, "—" если нет. Кнопки рядом: "Изменить" (открывает inline dropdown ролей) и "Снять роль" (если роль есть). Owner-lockout 409 показывается понятным сообщением.

### Удаляемые страницы

- **`/setup`** (вся директория `apps/web/src/app/setup/`) — wizard уходит.
- **Login redirect**: в `apps/web/src/app/login/` редирект на `/setup` (commit `9c938ca`) убирается.

### Sidebar / nav

Добавляются пункты:
- "Роли" под `role:view`
- "Пользователи" под `user:view`

В `apps/web/src/app/(dashboard)/layout.tsx` (или где живёт nav) — динамическая фильтрация по `req.user.permissions`.

---

## 7. Migration sequence

Текущий бранч `feat/steam-only-login` мержится в master (он ready, api-tokens завершены, decision-record написан). Новая работа — в бранче `feat/panel-rbac`. Серия коммитов:

1. **`feat(db): 0009_panel_rbac migration + drizzle schema rebuild`** — single-transaction SQL: drop org-таблиц + M:N + role\_server\_scopes, alter roles (drop org\_id/clearance, add color), alter players (add role\_id), create panel\_meta, truncate role\_permissions + player\_api\_tokens, INSERT 5 системных ролей и их permissions, `panel_meta.roles_seeded = true`. Drizzle schema: удалить/добавить/изменить файлы. Удалить `packages/db/src/seed/system-roles.ts`.
2. **`feat(shared-config): permission registry + role colors`** — registry-объекты, role-colors palette, `permissions.test.ts`, `role-defaults.test.ts`, `role-colors.test.ts`.
3. **`refactor(api/rbac): single-role lookup + invalidation`** — переписать `loadUserPermissions` под `players.role_id`, добавить `invalidatePermissionCacheForRole`, удалить `hasServerPermission`. Unit-тесты.
4. **`feat(api/roles): GET /permissions + CRUD /roles`** — endpoints с Owner-guard и audit'ом.
5. **`feat(api/users): GET /users + PUT /players/:id/role`** — удалить старые `/players/:id/roles` endpoints. Owner-lockout invariant.
6. **`feat(api/auth): first-login owner trick + drop /setup`** — advisory-lock сценарий в Steam-callback, удалить `routes/setup.ts`. Permission-rename'ы во всех `config.permissions`. `audit-coverage.test.ts` обновится автоматически.
7. **`feat(web/roles): /roles list + editor`** — color-picker, search над permissions, категории, ⚠️/unimplemented стили.
8. **`feat(web/users): /users table + assign modal`** — typeahead, dropdown ролей.
9. **`refactor(web): single-role PanelAccessSection + drop /setup + nav`** — переписать секцию на `/players/:id`, удалить `/setup`, добавить пункты в sidebar.
10. **`docs(rbac): component dir + decision record + cross-references`** — `docs/components/rbac/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`. Обновить `docs/architecture/rbac.md` (single-role + новый registry). Decision-record в `docs/architecture/decisions.md`. Удалить упоминания `/setup` и `clearance` из всех старых docs.

После каждого шага: `pnpm turbo run typecheck && pnpm turbo run test` зелёный AND **manual e2e на live стенде** по сценарию из секции 8.

---

## 8. Testing approach

### Tier 1 — unit

- **`permissions.test.ts`**: ключи уникальны, все категории из `PERMISSION_CATEGORIES` существуют (нет orphan), `dangerous`/`unimplemented` — `true | undefined`, никогда `false`.
- **`role-defaults.test.ts`**: каждый ключ в дефолтных permission-set'ах (Owner / Senior Admin / Admin / Moderator / Viewer) ∈ `PERMISSION_KEYS`. Owner = ALL. Viewer не содержит ничего кроме `*:view`.
- **`role-colors.test.ts`**: `ROLE_COLORS` совпадает с CHECK constraint в SQL миграции (читает текст файла миграции, парсит).
- **`rbac.test.ts`**: `loadUserPermissions(NULL role_id)` → пустой set; non-NULL → корректный set; cache hit/miss; `invalidatePermissionCache` чистит ключ; `invalidatePermissionCacheForRole` находит всех носителей и чистит их.

### Tier 2 — integration (apps/api/test/)

- **`roles-crud.test.ts`** — POST/GET/PUT/DELETE с разными permission-фикстурами. Owner read-only (PUT/DELETE → 400). UNIQUE name (POST дубликата → 409). `assigned_users_count` в GET корректный.
- **`player-role-assign.test.ts`** — PUT валидный role\_id; PUT с несуществующим → 404; PUT `null` снимает роль; Owner-lockout: попытка снять последнего Owner → 409. Cache invalidation: PUT, потом фейковый запрос с проверкой permissions — должен использовать новый set без TTL-ожидания.
- **`users-list.test.ts`** — GET фильтрует по `role_id NOT NULL`; join с roles работает; `assigned_at`/`assigned_by` присутствуют.
- **`permissions-list.test.ts`** — GET возвращает ровно `PERMISSIONS.length` объектов с правильными полями.
- **`first-owner-trick.test.ts`** — два concurrent логина дают одного Owner'а (advisory-lock). После `first_owner_claimed = true` следующий fresh-логин получает `role_id = NULL`.
- **`audit-coverage.test.ts`** — обновляется автоматически (route-walker).
- **`setup-removed.test.ts`** — `/api/v1/setup/check-env`, `/api/v1/setup/init` возвращают 404.
- **`permission-rename-coverage.test.ts`** — grep'ает все TS-файлы apps/api/src на старые ключи (`server:edit`, `server:config:write`, `role:manage` и т.д.) — должен возвращать 0 совпадений (защита от пропущенного rename).

### Tier 3 — e2e (apps/api/test/e2e/)

**`panel-rbac.e2e.test.ts`** — новый файл рядом с `install-lifecycle.e2e.test.ts`. Сценарий через HTTP с реальной cookie:

1. POST `/api/v1/roles` body `{name: "Test", color: "blue", permissions: ["server:view"]}` → 201, возвращает id.
2. PUT `/api/v1/players/:secondary/role` `{role_id: testId}` → 200.
3. GET `/api/v1/servers` от secondary user → 200 (есть `server:view`).
4. GET `/api/v1/audit` от secondary → 403 (нет `audit:view`).
5. PUT `/api/v1/roles/:testId` body `{permissions: []}` → 200.
6. GET `/api/v1/servers` от secondary → 403 (инвалидация сработала, не ждём TTL).
7. DELETE `/api/v1/roles/:testId` → 200.
8. GET `/api/v1/me` от secondary → role: null.
9. PUT `/api/v1/players/:owner/role` `{role_id: null}` → 409 `cannot_remove_last_owner`.

### Manual validation gate (требование пользователя)

После **каждого** из шагов 1-9 — оператор проходит руками:

1. Залогиниться как Owner. Видит `/roles`, `/users` в sidebar.
2. Создать роль "Test" цветом blue, выдать `server:view`.
3. Через `/users` назначить роль второму игроку (typeahead-поиском).
4. Залогиниться как этот игрок. Sidebar показывает только "Серверы" (никаких других пунктов).
5. Owner редактирует роль "Test" → убирает `server:view` → второй игрок при следующем нажатии получает 403/redirect.
6. Owner удаляет роль "Test" → второй игрок попадает на `/no-access` при следующем запросе.
7. Owner на `/players/:secondary` восстанавливает (выдаёт Viewer).

Без зелёных автотестов **И** ручного прохода — шаг не считается завершённым. Это блокирующий gate.

---

## 9. Out of scope

- **Иерархия / clearance levels** — отказались.
- **Per-server permission scoping** — отказались, таблица `role_server_scopes` дропается.
- **Multi-tenancy / orgs** — `organizations` дропается.
- **Setup wizard / env-check page** — удаляется, first-login Owner trick на Steam-callback заменяет.
- **Bulk-операции в `/users`** (mass assign/revoke) — будущий P1.
- **Composition of roles / inheritance** — роль плоская, никаких "Senior Admin extends Admin".
- **Expiring role assignments** — назначение бессрочное.
- **UI для управления permission registry** — registry это код, меняет программист.
- **Triggers / Scheduler / Whitelist / Backup / Discord / Moderation actions / Player notes** UI — permissions добавляются как `unimplemented` стабы; routes/UI — отдельные эпики.
- **Discord-link** — `discord:link` permission stub, UI/route — отдельный эпик.

---

## 10. Risks

- **Эскалация через `user:manage_roles`**: пользователь с этим правом может выдать кому-то Owner. Митigation: документировать как "give to trusted only"; в UI — confirm-dialog при назначении Owner'а ("Это даст полный доступ к панели. Подтвердить?"); ⚠️-бейдж на permission в редакторе.
- **In-memory кэш в multi-instance API**: точечная инвалидация работает только в одном процессе. На сейчас compose запускает один инстанс — не блокер. При горизонтальном масштабировании — Redis pub/sub в отдельном эпике.
- **Permission rename-расхождение**: если route ссылается на старое имя, типы поймают (PermissionKey union); `permission-rename-coverage.test.ts` подстраховывает.
- **Сидер ролей в SQL vs Drizzle types**: миграция INSERT'ит роли с фиксированными именами; типы Drizzle не знают про конкретные UUID. Тесты ожидают присутствие записей по `name`, не по id — это приемлемо, имена стабильные.
- **`is_system_role = true` только у Owner**: оператор может удалить, например, Moderator. После этого никто его не воссоздаёт автоматически (по дизайну). Документируется в `troubleshooting.md`.

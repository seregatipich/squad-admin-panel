# Server Deletion + Backup + Restore + Liveness

Status: in-progress
Owner: Sergei
Created: 2026-04-26

## Goal

1. **DELETE** удаляет файлы сервера (`/var/lib/squad-panel/{configs,saved}/{uuid}`) и контейнер.
2. **Бэкап конфигов** в БД (через существующую систему версий `config_versions`) — гарантировано, до любых деструктивных шагов.
3. **Архив удалённых серверов** — кликабельная страница в панели; конфиги читаемы read-only.
4. **Восстановление** — мастер: re-install → overlay backed-up `.cfg` → новая история.
5. **Liveness** — статус серверов / контейнеров / RCON / bridge приходит в UI без задержки через WebSocket; явный индикатор разрыва.

## Non-goals

- Восстановление контейнера в исходное состояние (используем re-install + overlay configs).
- Полное архивирование `Saved/` (логи, EOS marker, workshop cache) — только `.cfg`.
- Schedule-based purge (пока навсегда).
- DB-уровневый бэкап (вынесено в отдельный эпик).

## Bundles & dependency DAG

```
A (bridge directory_delete) ──┐
B (migration 0013)            ├─→ C (server-delete orchestrator) ──┬─→ D (archive + restore routes) ──┬─→ F (web)
                              │                                    │                                  │
                              │                                    └──→ H (e2e lifecycle)             │
                              │                                                                       │
E (live-bus WS)  ──────────────────────────────────────────────────────────────────────────────────────┘
                                                                                                      │
                                                                                                G (docs everywhere)
```

A, B, E независимы → стартуют параллельно.

## Bundle A — bridge `directory_delete`

**Files**
- `packages/shared-config/src/bridge-methods.ts` — добавить `directory_delete` в `BRIDGE_METHODS`.
- `packages/bridge-client/src/client.ts` — `directoryDelete = (p: {path: string}) => this.call<{removed: boolean}>('directory_delete', p, { timeoutMs: 60_000 })`.
- `packages/bridge-client/src/types.ts` — типы.
- `apps/bridge/internal/handlers/handlers.go` — case `"directory_delete"` + `directoryDelete()`.
- `apps/bridge/internal/validate/docker.go` — `PanelConfigsServerRoot(p) (string, error)` и `PanelSavedServerRoot(p) (string, error)`: путь должен быть **точно** `PanelConfigsRoot/{uuid}` или `PanelSavedRoot/{uuid}` (без trailing-slash, без файлов внутри). Используется при `directory_delete` и нигде больше.
- `apps/bridge/internal/handlers/handlers_test.go` — unit-tests forbidden cases (traversal, file path, unknown root, bad uuid).
- `apps/api/test/e2e/bridge-rpc.e2e.test.ts` — case `directory_delete` success x 2 (configs root, saved root) + forbidden x 4.

**Semantics**
- На входе `{path: string}`. Validator выбирает между `PanelConfigsServerRoot` и `PanelSavedServerRoot`. Если ни один не подходит — `forbidden`.
- `os.RemoveAll(cleaned)` (idempotent — отсутствие пути не ошибка, возвращаем `removed: false`).
- На успех — `{removed: true}`.

**Tests**
- Go unit: pass valid configs path → ok. Pass valid saved path → ok. Pass `/etc/passwd` → ErrForbidden. Pass `/var/lib/squad-panel/configs/019dc169-..-/ServerConfig` (file-level path) → ErrForbidden (не root). Pass traversal `/var/lib/squad-panel/configs/../etc` → ErrForbidden.
- E2E: создать пустую директорию `/var/lib/squad-panel/configs/0000.../`, удалить через bridge, убедиться отсутствует.

## Bundle B — migration 0013

**File**: `packages/db/drizzle/0013_servers_soft_delete.sql`

```sql
ALTER TABLE servers
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by_steam_id64 bigint NULL REFERENCES players(steam_id64) ON DELETE SET NULL,
  ADD COLUMN deletion_backup_marker_id uuid NULL REFERENCES config_versions(id) ON DELETE SET NULL;

CREATE INDEX servers_deleted_at_idx ON servers(deleted_at);

DROP INDEX IF EXISTS servers_slug_key;
CREATE UNIQUE INDEX servers_slug_active_key ON servers(slug) WHERE deleted_at IS NULL;
```

**Drizzle schema mirror** (`packages/db/src/schema/servers.ts`):
- `deletedAt`, `deletedBySteamId64`, `deletionBackupMarkerId`.
- `slugActiveKey` partial unique index.

**Regression test** (`packages/db/test/migrations.regression.test.ts`):
- Колонки существуют.
- Партиальный индекс позволяет два сервера с одинаковым slug если один deleted.

## Bundle C — server-delete orchestrator

**Files**
- `apps/api/src/lib/server-delete.ts` — orchestrator класс.
- `apps/api/src/routes/servers.ts` — переписать DELETE.
- Все list-queries и detail-queries в `routes/servers.ts` + `routes/server-configs.ts` + `routes/server-install.ts` + `routes/server-logs.ts` — добавить filter `deleted_at IS NULL` (если не filter по конкретному id, который уже учёт получает 404).

**`server-delete.ts` flow**

```ts
export interface DeleteResult {
  backup_marker_id: string;
  files_backed_up: number;
  container_removed: boolean;
  configs_dir_removed: boolean;
  saved_dir_removed: boolean;
  ufw_rules_removed: number;
  errors: Array<{phase: string; error: string}>;
}

export async function softDeleteServer(
  ctx: { db: DatabaseClient; bridge: BridgeClient; log: Logger },
  serverId: string,
  actor: { steamId64: bigint | null; ip: string | null },
): Promise<DeleteResult>;
```

**Phases (each best-effort except phase 1 which throws on fail)**:

1. **Backup configs** — read settings + creds → for each `ALLOWED_CONFIG_FILES` `bridge.fileRead({path: configPath})`. Inside one transaction: insert `config_versions` rows with `message = 'deletion-backup-marker'`. Use the first inserted row's id as `backup_marker_id`. If 0 files succeeded → throw (deletion aborted, server still alive).
2. **Container stop+rm** — `containerStop({timeout: 30})` + `containerRm()`. Errors logged + recorded in `errors`.
3. **directory_delete configs** + **saved**.
4. **ufw_rule delete** × {game,query,beacon,rcon} ports.
5. **DB update** — `UPDATE servers SET deleted_at=now(), deleted_by_steam_id64=$1, deletion_backup_marker_id=$2 WHERE id=$3`.
6. **Audit** (in route): `writeAuditEntry` with `before={status, slug, display_name}`, `after={deleted_at, backup_marker_id}`, `context={...DeleteResult}`.

**Rcon.cfg**: бэкапится с password как есть (нужно для restore символьно совпадающим). Audit логирует только sha256, не content.

**Idempotency**: повторный DELETE на уже soft-deleted сервере → 404 (с deleted_at filter).

**Unit tests**: bridge mocks (success всех phases, partial fail in phase 2, partial fail in phase 3, phase 1 fail aborts).

## Bundle D — archive + restore-configs routes

**Files**: `apps/api/src/routes/server-archive.ts` (новый), `apps/api/src/lib/server-restore.ts`.

**Endpoints**:

| Method | Path | Permission | What |
|---|---|---|---|
| GET | `/api/v1/servers/archive` | `server:view` | List soft-deleted servers (`WHERE deleted_at IS NOT NULL`) ordered DESC. |
| GET | `/api/v1/servers/archive/:id` | `server:view` | Server meta + list of backup `config_versions` rows (filenames, sha256, size). |
| GET | `/api/v1/servers/archive/:id/configs/:filename` | `config:view` | Read content of a backup config. |
| POST | `/api/v1/servers/archive/:id/restore` | `server:install` | Body: `{slug: string, display_name?: string, ports?: {...}}`. Creates new server (UUIDv7), copies metadata from archive. Returns `{new_server_id, status: 'pending'}`. Does NOT install. |
| POST | `/api/v1/servers/:newId/restore-configs` | `config:edit` | Body: `{from_archive_id: string}`. Reads backup `config_versions` rows for `from_archive_id`, for each (skipping `Rcon.cfg`) calls `bridge.fileAtomicWrite` overlay onto `${PANEL_CONFIGS_ROOT}/${newId}/ServerConfig/`, then inserts new `config_versions` row with `message = "restored from archive ${oldId} ${ts}"`. Audit. |

**Restore wizard logic** (lives in web Bundle F):
1. POST `/restore` → get `new_server_id`.
2. POST `/api/v1/servers/:new_server_id/install` (existing route) → seeds default `.cfg` from depot.
3. After install completes (status=`ready`), POST `/api/v1/servers/:new_server_id/restore-configs?from_archive_id=...`.
4. POST `/api/v1/servers/:new_server_id/start`.

## Bundle E — live-bus WebSocket

**Files**:
- `apps/api/src/plugins/live-bus.ts` — singleton EventEmitter + Redis subscriber.
- `apps/api/src/routes/live.ts` — `GET /api/v1/ws/live` (auth via session cookie, reuses authPlugin).
- `apps/api/src/plugins/status-reconciler.ts` — emit `live.publish('server.status', {...})` on edge transition.
- `apps/api/src/plugins/bridge-heartbeat.ts` — emit `live.publish('bridge.connection', {state})` on state change.
- `apps/workers/rcon/src/index.ts` — на каждое изменение `rcon:status:{id}` сделать `redis.publish('rcon:status:changed', JSON.stringify({server_id, ...payload}))`. API субскрайбится.

**Wire format** (server → client):
```json
{"type": "server.status", "ts": "...", "data": {"server_id": "...", "status": "running", "source": "reconciler"}}
{"type": "server.deleted", "ts": "...", "data": {"server_id": "...", "deleted_at": "...", "by": "..."}}
{"type": "rcon.status", "ts": "...", "data": {"server_id": "...", "state": "connected", "player_count": 42}}
{"type": "bridge.connection", "ts": "...", "data": {"state": "down", "down_for_s": 12}}
{"type": "ping", "ts": "..."}
```

Client → server: `{"type": "pong"}` (server pings every 10s, client must pong within 30s or socket dropped).

**Test** (apps/api/test/live-bus.test.ts): inject WS client, publish event, assert frame received.

## Bundle F — web

**Files**:
- `apps/web/src/lib/live-bus.ts` — singleton WS + reconnect + subscriber API.
- `apps/web/src/components/connection-banner.tsx` — fixed top banner: "Связь с панелью потеряна — переподключаемся…" / "Bridge не отвечает — операции с сервером временно недоступны".
- `apps/web/src/app/(dashboard)/layout.tsx` — render banner.
- `apps/web/src/app/(dashboard)/servers/page.tsx` — subscribe to `server.status` + `rcon.status`, instant updates; REST poll становится `120s` fallback (для refetch на focus).
- `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` — обновить confirm-модал на «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел "Архив серверов").»
- `apps/web/src/app/(dashboard)/servers/archive/page.tsx` — таблица soft-deleted.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/page.tsx` — детали + список backup .cfg файлов с просмотром.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` — мастер restore.

**Playwright** (`apps/web/test/e2e/server-archive-restore.spec.ts`): mocked, проверяет UI flow без реального bridge.

## Bundle G — docs

См. описание в TaskCreate #52. 8 файлов для нового компонента `live-bus`. Update остальных. Changelog records в каждом затронутом компоненте.

## Bundle H — e2e lifecycle

См. TaskCreate #53. Прогон на live stack как `install-lifecycle.e2e.test.ts`. Время: ~6-8 минут per run (install + delete + restore + install).

## Acceptance

- `pnpm turbo run typecheck && pnpm turbo run test` — green.
- `pnpm --filter @squad/api test:e2e` — green (включая `server-delete-restore-lifecycle.e2e.test.ts`).
- `pnpm --filter @squad/web test:e2e` — green.
- Manual: уделить сервер из UI → файлы исчезли с диска → архив показывает запись → restore создаёт новый сервер → конфиги совпадают с pre-delete версией.
- Liveness: `docker stop panel-host-bridge` → красный баннер в UI в течение 5s; `docker start` → баннер исчезает в течение 5s.

## Open risks / known caveats

- **Phase 2-4 partial fail**: contractual choice — мы фиксируем `errors[]` в audit, БД помечает deleted_at, оператор видит висящий контейнер/файлы и руками доделывает. Альтернатива (откат deleted_at) — сложно и опасно (могли быть состояния гонки с reconciler-ом).
- **Slug reuse**: партиальный unique index делает это возможным; restore mut предлагает `${old_slug}-restored-1` чтобы не путать пользователя.
- **WebSocket за reverse proxy**: Caddyfile уже умеет ws-upgrade; убедиться в `docker/Caddyfile`.
- **Worker heartbeat liveness**: пока не покрываем в UI (отдельный эпик), но API-side bridge.connection и server.status — основное.

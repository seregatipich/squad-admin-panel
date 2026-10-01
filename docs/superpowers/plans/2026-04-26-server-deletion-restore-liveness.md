# Server Deletion + Backup + Restore + Liveness

Status: in-progress
Owner: Sergei
Created: 2026-04-26

## Goal

1. **DELETE** removes the server's files (`/var/lib/squad-panel/{configs,saved}/{uuid}`) and the container.
2. **Config backup** in the DB (through the existing `config_versions` versioning system) — guaranteed, before any destructive step.
3. **Archive of deleted servers** — a clickable page in the panel; configs are readable read-only.
4. **Restore** — a wizard: re-install → overlay backed-up `.cfg` → fresh history.
5. **Liveness** — server / container / RCON / bridge status reaches the UI without delay over WebSocket; an explicit indicator when the connection drops.

## Non-goals

- Restoring the container to its original state (we use re-install + overlay configs).
- Full archiving of `Saved/` (logs, EOS marker, workshop cache) — only `.cfg` files.
- Schedule-based purge (for now, kept forever).
- DB-level backup (moved to a separate epic).

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

A, B, E are independent → they start in parallel.

## Bundle A — bridge `directory_delete`

**Files**
- `packages/shared-config/src/bridge-methods.ts` — add `directory_delete` to `BRIDGE_METHODS`.
- `packages/bridge-client/src/client.ts` — `directoryDelete = (p: {path: string}) => this.call<{removed: boolean}>('directory_delete', p, { timeoutMs: 60_000 })`.
- `packages/bridge-client/src/types.ts` — types.
- `apps/bridge/internal/handlers/handlers.go` — case `"directory_delete"` + `directoryDelete()`.
- `apps/bridge/internal/validate/docker.go` — `PanelConfigsServerRoot(p) (string, error)` and `PanelSavedServerRoot(p) (string, error)`: the path must be **exactly** `PanelConfigsRoot/{uuid}` or `PanelSavedRoot/{uuid}` (no trailing slash, no files inside). Used by `directory_delete` and nowhere else.
- `apps/bridge/internal/handlers/handlers_test.go` — unit-tests forbidden cases (traversal, file path, unknown root, bad uuid).
- `apps/api/test/e2e/bridge-rpc.e2e.test.ts` — case `directory_delete` success x 2 (configs root, saved root) + forbidden x 4.

**Semantics**
- Input is `{path: string}`. The validator chooses between `PanelConfigsServerRoot` and `PanelSavedServerRoot`. If neither matches — `forbidden`.
- `os.RemoveAll(cleaned)` (idempotent — a missing path is not an error, we return `removed: false`).
- On success — `{removed: true}`.

**Tests**
- Go unit: pass valid configs path → ok. Pass valid saved path → ok. Pass `/etc/passwd` → ErrForbidden. Pass `/var/lib/squad-panel/configs/019dc169-..-/ServerConfig` (file-level path) → ErrForbidden (not a root). Pass traversal `/var/lib/squad-panel/configs/../etc` → ErrForbidden.
- E2E: create an empty directory `/var/lib/squad-panel/configs/0000.../`, delete it through the bridge, verify it is gone.

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
- Columns exist.
- The partial index allows two servers with the same slug if one is deleted.

## Bundle C — server-delete orchestrator

**Files**
- `apps/api/src/lib/server-delete.ts` — orchestrator class.
- `apps/api/src/routes/servers.ts` — rewrite DELETE.
- All list-queries and detail-queries in `routes/servers.ts` + `routes/server-configs.ts` + `routes/server-install.ts` + `routes/server-logs.ts` — add the `deleted_at IS NULL` filter (unless filtering by a specific id, which already gets a 404).

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

**Rcon.cfg**: backed up with the password as is (needed so restore matches character for character). Audit logs only the sha256, not the content.

**Idempotency**: a repeated DELETE on an already soft-deleted server → 404 (with the deleted_at filter).

**Unit tests**: bridge mocks (success of all phases, partial fail in phase 2, partial fail in phase 3, phase 1 fail aborts).

## Bundle D — archive + restore-configs routes

**Files**: `apps/api/src/routes/server-archive.ts` (new), `apps/api/src/lib/server-restore.ts`.

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
- `apps/workers/rcon/src/index.ts` — on every `rcon:status:{id}` change, do `redis.publish('rcon:status:changed', JSON.stringify({server_id, ...payload}))`. The API subscribes.

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
- `apps/web/src/components/connection-banner.tsx` — fixed top banner: "Связь с панелью потеряна — переподключаемся…" (Connection to the panel lost — reconnecting…) / "Bridge не отвечает — операции с сервером временно недоступны" (Bridge is not responding — server operations are temporarily unavailable).
- `apps/web/src/app/(dashboard)/layout.tsx` — render banner.
- `apps/web/src/app/(dashboard)/servers/page.tsx` — subscribe to `server.status` + `rcon.status`, instant updates; the REST poll becomes a `120s` fallback (for refetch on focus).
- `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` — update the confirm modal to «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел "Архив серверов").» (Files will be erased from disk. The `.cfg` backup will be kept in the archive (the "Server archive" section).)
- `apps/web/src/app/(dashboard)/servers/archive/page.tsx` — table of soft-deleted servers.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/page.tsx` — details + a list of backup .cfg files with a viewer.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` — restore wizard.

**Playwright** (`apps/web/test/e2e/server-archive-restore.spec.ts`): mocked, checks the UI flow without a real bridge.

## Bundle G — docs

See the description in TaskCreate #52. 8 files for the new `live-bus` component. Update the rest. Changelog records in each affected component.

## Bundle H — e2e lifecycle

See TaskCreate #53. Run on the live stack as `install-lifecycle.e2e.test.ts`. Time: ~6-8 minutes per run (install + delete + restore + install).

## Acceptance

- `pnpm turbo run typecheck && pnpm turbo run test` — green.
- `pnpm --filter @squad/api test:e2e` — green (including `server-delete-restore-lifecycle.e2e.test.ts`).
- `pnpm --filter @squad/web test:e2e` — green.
- Manual: delete a server from the UI → files are gone from disk → the archive shows the entry → restore creates a new server → configs match the pre-delete version.
- Liveness: `docker stop panel-host-bridge` → red banner in the UI within 5s; `docker start` → banner disappears within 5s.

## Open risks / known caveats

- **Phase 2-4 partial fail**: a contractual choice — we record `errors[]` in the audit, the DB marks deleted_at, the operator sees the dangling container/files and finishes by hand. The alternative (rolling back deleted_at) is complex and dangerous (there could be race conditions with the reconciler).
- **Slug reuse**: the partial unique index makes this possible; the restore mutation suggests `${old_slug}-restored-1` so as not to confuse the user.
- **WebSocket behind a reverse proxy**: the Caddyfile already handles ws-upgrade; verify in `docker/Caddyfile`.
- **Worker heartbeat liveness**: not covered in the UI for now (separate epic), but the API-side bridge.connection and server.status are the main thing.

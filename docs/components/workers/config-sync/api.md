# worker-config-sync — API surface

Worker не имеет входящего HTTP/RPC. Он читает `events:admins-cfg-sync:<server_id>`,
а для новых outbox-сообщений подтверждает файл и точный результат worker-rcon,
не используя старый `rcon:status` как источник lifecycle-решения.

## Inputs (Redis Streams) — what the worker consumes

### `events:admins-cfg-sync:<server_id>`

Per-server stream. The API publishes one entry on every relevant DB mutation (role create/update/delete, player role assign/unassign, force-sync request).

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | JSON string | ✅ | Encoded `AdminsCfgSyncEvent` payload (see below). |

`AdminsCfgSyncEvent`:

```ts
interface AdminsCfgSyncEvent {
  reason: string;                // 'role.create' | 'role.update' | 'role.delete'
                                 // | 'player.role.assign' | 'player.role.unassign'
                                 // | 'role.member.add' | 'role.member.remove'
                                 // | 'force_sync' | 'drift_check' | 'unknown'
  actor_player_id: string|null;  // internal player id or null for system
  enqueued_at: string;           // ISO timestamp
  request_id?: string;
  forceWrite?: boolean;          // alternative to reason='force_sync'
  _outbox_id?: string;           // stable UUID added by the post-commit relay
}
```

Consumer group: `config-sync`. Новый `_outbox_id` связывает Redis-запись с
PostgreSQL. Успех сначала получает `applied_at`, затем один Lua-скрипт выполняет
`XACK` и точный `XDEL`. Ошибка остаётся unacked для reclaim; повреждённое или
старое успешно обработанное сообщение тоже удаляется, чтобы ACKed-хвост не рос.

A separate `XAUTOCLAIM` pass runs every `ADMINS_CFG_RECLAIM_INTERVAL_MS` (default 30s) per active server with `MIN-IDLE-TIME = ADMINS_CFG_RECLAIM_MIN_IDLE_MS` (default 60s) and a `COUNT 50` cap. It takes ownership of any messages stuck in another consumer's PEL — typically left behind by:
- a previous worker process that crashed before XACK,
- a previous worker process whose `consumer-${pid}-${rand}` name is now defunct,
- the `state='unreachable'` branch where the current consumer left the message intentionally pending until the bridge recovers.

The reclaim pass is invoked once at boot (catches messages orphaned across restarts) and on the periodic interval. Reclaimed messages take the same code path as freshly-delivered ones — successful sync acks; unreachable leaves them in the (now this-consumer's) PEL for the next cycle.

API и mutation-workers пишут одну PostgreSQL outbox-строку на сервер. Только
post-commit relay переносит её в Redis и добавляет `_outbox_id`.

## Outputs (Redis streams / keys) — what the worker writes

### `rcon:commands:<server_id>` (worker-rcon command stream)

Для нового outbox живого сервера worker отправляет команду даже при уже
совпавшем хеше файла: совпадение байтов не доказывает, что Squad перечитал файл.

```
XADD rcon:commands:<server_id> MAXLEN ~ 500 * request <json>
```

where `<json>` is a `rconCommandRequestSchema` document with deterministic
`request_id = admins-cfg-sync:<outbox_id>` and
`command = AdminReloadServerConfig`.

Worker ждёт до 4 секунд и принимает только `rconCommandResultSchema` с точными
`server_id`, `request_id`, `command=AdminReloadServerConfig` и `ok=true`.
`rejected|timeout|invalid_result|unavailable` сохраняются как безопасный код в
outbox, оставляют `applied_at=NULL` и не разрешают `XACK`/`XDEL`. Старые
сообщения без `_outbox_id` сохраняют прежний best-effort режим.

### `admins-cfg:status:<server_id>`

Per-server JSON document with the worker's view of sync state. TTL 24h, refreshed on every cycle.

```ts
interface AdminsCfgStatus {
  state: 'unknown' | 'in_sync' | 'drift' | 'unreachable' | 'syncing';
  last_synced_at: string | null;     // ISO; null if never synced
  last_segment_hash: string | null;  // sha256 of the segment last seen in the file
  last_db_hash: string | null;       // sha256 of the DB-derived segment
  groups_count?: number;
  admins_count?: number;
  error?: string | null;
}
```

Consumed by `GET /api/v1/admins-cfg/drift?server_id=<uuid>` and the `<AdminsCfgDriftBanner>` component on the server detail page.

### `config-drift:status:<server_id>`

Per-server JSON document from the generic CFG-2 (#64) drift sweep (`src/config-drift.ts`) over the 16 non-managed config files (allowlist minus `Admins.cfg`, `LayerRotation.cfg`, `License.cfg`). TTL 24h, refreshed on every sweep (`CONFIG_DRIFT_INTERVAL_MS`, default 5 min).

```ts
interface ConfigDriftStatus {
  checked_at: string; // ISO timestamp of the sweep
  files: {
    [name: string]: {
      state: 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';
      disk_sha256: string | null;    // sha256 of the on-disk bytes; null if unreadable
      version_sha256: string | null; // sha256 of the config_versions tip; null if never versioned
      tip_version_id: string | null; // config_versions.id of the tip
    };
  };
}
```

Informational/monitoring only — the config editor UI polls the API's live `GET /api/v1/servers/:id/configs/drift` instead, so drift resolution does not depend on the worker having run.

### `audit_log` rows (Postgres)

On every successful write, the worker appends a chained-hash audit row using `appendWorkerAudit` (`apps/workers/config-sync/src/audit.ts`):

```jsonc
{
  "actor_kind": "system",            // or "steam" if a user triggered the sync
  "actor_system_label": "worker-config-sync",
  "action_type": "admins_cfg.synced", // or "admins_cfg.force_synced"
  "target_type": "server",
  "target_id": "<server_uuid>",
  "before_snapshot": { "segment_hash": "<sha256-hex|null>" },
  "after_snapshot":  { "segment_hash": "<sha256-hex>" },
  "context": {
    "reason": "...",
    "groups_count": 5,
    "admins_count": 247,
    "reload": "enqueued"        // 'enqueued' | 'skipped_rcon_disconnected' | 'failed'
  }
}
```

On every **failed** sync attempt (bridge fileRead or fileAtomicWrite error), the worker appends `admins_cfg.sync_failed` per spec §2.7.7:

```jsonc
{
  "actor_kind": "steam | system",
  "action_type": "admins_cfg.sync_failed",
  "target_type": "server",
  "target_id": "<server_uuid>",
  "before_snapshot": { "segment_hash": "<sha256-hex|null>" },
  "after_snapshot":  null,
  "context": {
    "reason": "...",
    "phase": "file_read" | "file_atomic_write",
    "error": "<bridge error message>",
    "groups_count": 5,
    "admins_count": 247
  }
}
```

The hash chain (`row_hash = sha256(prev_hash || canonical_json(payload))`) is preserved across worker- and API-appended rows.

## Bridge methods used

The worker calls only two methods from `@squad/bridge-client`:

- `bridge.fileRead({ path })` — read the current `Admins.cfg`. `not_found` is treated as empty-file (first sync after install).
- `bridge.fileAtomicWrite({ path, content })` — atomic write (`.tmp` → `fsync` → `rename` → `fsync` directory).

The path is hard-derived as `/var/lib/squad-panel/configs/{server_id}/ServerConfig/Admins.cfg`; the bridge's allowlist already permits this path under the existing `file_read` / `file_atomic_write` rules — no Go-side changes were needed.

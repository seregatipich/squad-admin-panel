# worker-config-sync — Flows

## Main flow — event-driven sync

```
┌────────────────┐ INSERT in tx ┌──────────────────┐ post-commit XADD ┌─────────────────────┐
│ API / worker   │──────────────▶│ PostgreSQL       │─────────────────▶│ events:admins-cfg-  │
│ mutation       │               │ outbox           │ stable id        │ sync:<server_id>    │
└────────────────┘               └──────────────────┘                  └──────────┬──────────┘
                                                                                │ XREADGROUP
                                                                                ▼
                                                                      ┌──────────────────┐
                                                                      │ worker-config-   │
                                                                      │ sync             │
                                                                      └────────┬─────────┘
                                                                               │
                                                ┌──────────────────────────────┘
                                                ▼
        ┌──────────┐  fileRead    ┌──────────────┐  buildManagedSegment   ┌────────┐
        │ bridge   │◀─────────────│ syncer.ts    │───────────────────────▶│ sha256 │
        │ Go daemon│   path=…/    │              │       cmp DB hash      │ compare│
        │          │   Admins.cfg │              │       vs file hash     └───┬────┘
        └────┬─────┘              └──────┬───────┘                            │
             │                           │ noop if equal                      │
             │  fileAtomicWrite          │                                    │
             ▼                           ▼                                    ▼
        ┌──────────┐               ┌──────────────────┐               ┌──────────────┐
        │ host fs  │               │ admins-cfg:      │               │ audit_log    │
        │ Admins.  │               │ status:<srv_id>  │               │ admins_cfg.  │
        │ cfg      │               │ (Redis)          │               │ synced row   │
        └──────────┘               └──────────────────┘               └──────────────┘
```

Для каждого нового outbox-сообщения worker подтверждает не только файл, но и
его применение с учётом свежего состояния сервера. Старый режим прямого
best-effort RCON сохранён только для сообщений без `_outbox_id`.

Step-by-step:

1. The API or a mutation worker records the domain change and one `admins_cfg_sync_outbox` row per active-server snapshot in the same PostgreSQL transaction. Force-sync inserts one single-server row; server installation commits its final `running` transition and row atomically.
2. A single-flight relay sees rows only after commit, performs bounded `XADD` calls with stable `_outbox_id`, then records `relayed_at`/`stream_id`. Failure leaves the row pending. The relay does not use `MAXLEN`; cleanup is allowed only after durable apply/`XACK`.
3. Worker создаёт новые consumer group с `0`, поэтому запись, опубликованная до создания группы, остаётся видимой. `XREADGROUP` возвращает `_outbox_id` вместе с исходным payload.
4. `syncServerAdminsCfg(ctx, serverId, opts)` сверяет свежий снимок БД с файлом. Для нового outbox он не запускает старый best-effort RCON:
   - Publish `state: 'syncing'` to `admins-cfg:status:<server_id>`.
   - Snapshot DB: `roles` (with `role_squad_permissions`) + `players WHERE role_id IS NOT NULL` mapped to role names.
   - `buildManagedSegment(snapshot)` produces the deterministic byte body + sha256.
   - `bridge.fileRead({ path })` reads the current file; `findManagedSegment` extracts the existing managed slice.
   - Если хеши совпали и `forceWrite=false`, запись файла пропускается, но подтверждение RCON для живого сервера всё равно обязательно.
   - Otherwise `bridge.fileAtomicWrite({ path, content })` with the spliced body.
   - Update status to `in_sync` with the fresh hash, group/admin counts, and a timestamp.
   - Append an `admins_cfg.synced` (or `admins_cfg.force_synced`) row to `audit_log`.
5. После файловой операции worker дважды читает `servers.status`. Стабильно неживой сервер получает `file_ready_for_restart`. Для `running|starting` отправляется `AdminReloadServerConfig` с `request_id=admins-cfg-sync:<outbox_id>` и принимается только точный валидный `ok=true` результат. Переход `stopped -> running` включает RCON-ветку, а `running -> stopped` завершается как готовый файл.
6. Успешный итог сначала сохраняется в PostgreSQL (`applied_at` и allowlisted `reload_outcome`). Затем Lua-скрипт атомарно выполняет `XACK` и точный `XDEL`. Уже applied replay и устойчивый lifecycle `superseded` пропускают файл/RCON и выполняют только очистку. Ошибка сохраняет безопасный код и оставляет запись в PEL без `XDEL`.

### Подтверждение VIP lifecycle

Каждая строка снимка VIP-события хранит `correlation_id=event_id`, время
`relayed_at`, Redis `stream_id`, устойчивое `applied_at`, безопасный
`last_error` и нормализованный `reload_outcome`. API создаёт эти строки в той
же PostgreSQL-транзакции, что роль и lifecycle; Redis relay запускается только
после commit. Поэтому ответ lifecycle `202` подтверждает приём, но не доставку.

Подписанный `POST /api/v1/integrations/vip/status` агрегирует только эти поля:
не начавшийся relay — `accepted`, relay/частичный итог/временные
`unavailable|timeout` — `applying`, полный непустой снимок с `applied_at` —
`applied`, постоянные `rejected|invalid_result` — `failed`. Терминальный
`server_removed` входит в число применённых серверов. Если lifecycle уже
помечен `superseded`, это состояние имеет приоритет над агрегатом outbox:
позднее подтверждение старой строки не доказывает применение устаревшего
желания.
Lifecycle и агрегат читаются одним SQL-снимком, без READ COMMITTED-разрыва
между отдельными запросами.
Ни outbox, ни status не сохраняют и не отдают SteamID64, EOS, путь,
содержимое файла или сырой ответ RCON.

## Drift detection flow (every 5 min)

A separate `setInterval` ticks every `ADMINS_CFG_DRIFT_INTERVAL_MS` (default 5 min). For each active server it runs `syncServerAdminsCfg(... { reason: 'drift_check', forceWrite: false })`. The passive `drift_check` reason changes behaviour vs. the event-driven path:

- If the file's managed segment matches the DB hash → no-op, status stays `in_sync`.
- **If they differ (someone edited the segment by hand) → the worker DOES NOT auto-overwrite. It publishes `state: 'drift'` with both hashes and a warn log `admins.cfg drift detected — awaiting force-sync`. The operator decides via the UI banner.** This matches spec §2.7.6: panel surfaces the divergence and asks the operator to "Force sync" or accept the change manually (P0 acceptance is "copy values into the UI").
- If the bridge errors → status flips to `unreachable` and the server enters per-server backoff (5s → 10s → ... capped at 5 min).

Active mutations (role.create/update/delete, player.role.assign/unassign, role.member.add/remove, force_sync) skip this passive branch after their committed outbox row is consumed — those are panel-initiated changes, not drift.

The UI's `<AdminsCfgDriftBanner>` polls `/api/v1/admins-cfg/drift?server_id=...` every 30 s. When state ∈ {`drift`, `unreachable`}, the banner offers a "Force sync" button that POSTs to `/api/v1/admins-cfg/sync?server_id=...`. That endpoint inserts a durable single-server `force_sync` outbox row; after relay the worker picks it up and overwrites unconditionally (`opts.forceWrite=true`).

## Config drift detection flow (generic)

CFG-2 (#64) adds a second, independent sweep (`src/config-drift.ts`, `setInterval` every `CONFIG_DRIFT_INTERVAL_MS`, default 5 min) covering the **16 non-managed config files** — the 19-file allowlist minus `Admins.cfg` (managed segment above), `LayerRotation.cfg` (ROT-2 managed segment) and `License.cfg` (panel-managed, #45). For each active server it:

1. Reads each file's `config_versions` tip sha256 from Postgres (one `DISTINCT ON (filename)` query per server).
2. Reads the file via `bridge.fileRead` and hashes the on-disk bytes.
3. Publishes per-file state to `config-drift:status:<server_id>` (TTL 24h): `in_sync` | `drift` (shas differ — e.g. hand-edited over SSH) | `missing` (file absent) | `unreachable` (bridge read failed) | `unknown` (file never versioned).

Like the Admins.cfg sweep, it **detects, never auto-corrects** — the worker only publishes status. Resolution is operator-driven on the config editor page (`/servers/:id/configs`): the drift banner offers «Принять» (`POST .../configs/:name/drift/accept` — records the disk bytes as a new version), «Откатить» (`POST .../configs/:name/drift/revert` — repairs the disk byte-for-byte back to the DB tip, no duplicate history row) and a unified diff (`GET .../configs/:name/drift/diff`). The API's `GET .../configs/drift` reads live via the bridge, so the UI works even before the first sweep.

## Error / retry flow

| Failure mode | Outcome | Recovery |
|---|---|---|
| `bridge.fileRead` returns `not_found` | Treated as empty file; managed segment is prepended on next write. | First-sync-after-install path. |
| `bridge.fileRead` returns generic error | Status = `unreachable`, message **NOT** acked, per-server backoff (5s → 5min). `admins_cfg.sync_failed` audit row appended with `phase=file_read`. | Bridge comes back, next periodic reclaim (or drift sweep) retries. |
| `bridge.fileAtomicWrite` fails | Same as above — status `unreachable`, no `XACK`, audit `phase=file_atomic_write`. | Auto-retry via reclaim. |
| Audit append throws | Logged at error level, but the sync itself is committed. | Operator investigates DB connectivity; sync proceeds. |
| Server deleted (`servers.deleted_at` set) | Worker drops it from the active set on next refresh (every 30 s); no further reads. | n/a |
| `XREADGROUP` returns `NOGROUP` / "no such key" (a per-server stream+group was destroyed by the API on soft-delete, SYNC-5) | The multiplexed read rejects for the WHOLE batch, so the worker cannot tell which stream vanished. It logs `xreadgroup NOGROUP — refreshing server list`, calls `refreshServerList()` immediately (dropping the vanished id and pruning its `backoffByServer` entry), and resumes on the next loop iteration — instead of the pre-SYNC-5 behaviour of sleeping 1 s and re-hitting the same error until the 30-s refresh. | Self-heals within one loop iteration. |
| Worker crash / SIGTERM | Heartbeat key expires within 30 s. In-flight messages stay in the crashed consumer's PEL. The next worker process — even with a fresh `consumer-${pid}-${rand}` name — picks them up via the periodic `XAUTOCLAIM` pass once they exceed `RECLAIM_MIN_IDLE_MS` (default 60 s). | systemd restart. |

## Pending-message reclaim (XAUTOCLAIM)

Spec §2.7.7 mandates that "при временной недоступности сервера … worker retry'ит with exponential backoff". Two layers cooperate:

1. **In-flight retry inside the consumer**: when a message returns `state: 'unreachable'`, the worker logs the failure, records audit, and explicitly DOES NOT call `XACK`. The message stays in the current consumer's PEL.
2. **Cross-consumer reclaim**: every `ADMINS_CFG_RECLAIM_INTERVAL_MS` (default 30 s), and once at boot, the worker runs `XAUTOCLAIM <stream> config-sync <self> MIN-IDLE-TIME=60000 0-0 COUNT 50` against every active server's stream. Any pending message older than 60 s — whether owned by a defunct consumer (process restart) or by the same consumer (still-unreachable) — is reclaimed by the calling consumer and replayed.

Together they guarantee:
- A persistently-unreachable server's messages keep retrying every reclaim cycle until the bridge recovers.
- A consumer that crashed mid-handle does not orphan messages; the next process picks them up at boot.
- Неприменённый backlog не обрезается и может расти, пока сервер недоступен. После устойчивого успеха consumer атомарно делает `XACK` + точный `XDEL`; failed/unacked запись никогда не удаляется. Операторский контроль долгого PEL остаётся необходимым.

## Per-server lifecycle

- **Server install** — when a new server's row appears in DB, the next 30-s `refreshServerList` tick adds it to the active set and creates the consumer group with `MKSTREAM`. The API enqueues an initial sync event so the file is populated before Squad first boots.
- **Server soft-delete** — the API's `softDeleteServer` now tears the per-server sync queue down synchronously (SYNC-5, #38): it `XGROUP DESTROY`s the `config-sync` group, `UNLINK`s the `events:admins-cfg-sync:<id>` stream, `DEL`s the `admins-cfg:status:<id>` key, and terminally completes every unapplied outbox row with `applied_at` and `reload_outcome=server_removed`, preserving any existing `relayed_at`/`stream_id`. The worker reacts two ways: (1) the destroyed stream makes the next multiplexed `XREADGROUP` reject `NOGROUP`, which triggers an immediate `refreshServerList()` (see the retry table) so the id is dropped without waiting for the 30-s tick; (2) even without that, the id falls out of `activeServerIds` on the next refresh. The **outbox relay** ([`relayAdminsCfgSyncOutbox`](../../../../packages/db/src/admins-cfg-outbox.ts)) additionally joins `servers` and, for a pending row whose server is already soft-deleted, records the same terminal `server_removed` result and stamps `relayed_at` **without** an `XADD` — so a mutation that raced the delete cannot resurrect the torn-down stream.
- **Server restore** — re-appears on the active list, the consumer group is (re-)created with `MKSTREAM`, the next reconcile rewrites the managed segment from current DB.

## Background flow — heartbeat

`startHeartbeat` from `@squad/shared-config` writes `worker:heartbeat:config-sync` to Redis with TTL 30 s; the panel `/api/v1/health/workers` endpoint reads this to surface liveness.

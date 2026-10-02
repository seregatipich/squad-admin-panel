# worker-ban-sync - API surface

No HTTP surface. The worker reads and writes Postgres, consumes one Redis stream, and writes Redis keys and streams.

## Redis stream consumed: `bansync:manual`

Appended to by the API's `POST /api/v1/ban-sources/:id/sync` (`XADD bansync:manual MAXLEN ~ 1000 * job <json>`); the constant is `BAN_SYNC_MANUAL_STREAM` in `packages/shared-types/src/external-bans.ts`.

| Aspect | Value |
|---|---|
| Consumer group | `ban-sync` (created with `XGROUP CREATE ... $ MKSTREAM`; `BUSYGROUP` is ignored) |
| Consumer name | `ban-sync-<pid>` |
| Read | `XREADGROUP ... BLOCK 5000 STREAMS bansync:manual >` on a dedicated duplicate connection |
| Entry field | `job`, a JSON object |
| Acknowledgement | `XACK` after every handled job, whatever the outcome |

Job shape (`ManualJob`):

```json
{ "source_id": "<uuid>", "actor_player_id": "<uuid|null>", "request_id": "<id>", "enqueued_at": "<ISO 8601>" }
```

Only `source_id` is used by the worker. A job without a `job` field, with invalid JSON, or without `source_id` is logged at `warn` (`malformed bansync:manual job; acked without a sync`) and acknowledged. A job for a source that no longer exists is logged and acknowledged. The API also holds the key `bansync:manual:pending:<sourceId>` (`SET NX EX 60`) to reject duplicate requests for 60 s; the worker does not touch that key.

## Redis writes

| Key / stream | Operation | Purpose |
|---|---|---|
| `worker:heartbeat:ban-sync` | `SET ... EX 30` every 5 s | Liveness, status text `running` |
| `external-bans:version` | `INCR` after every successful sync | Invalidates the external-ban cache in `worker-log-ingest` |
| `dedup:worker-ban-sync:v1:<event_id>` | `SET '1' EX 86400 NX` | Producer-side dedup for `events:global` |
| `events:global` | `XADD MAXLEN ~ 10000 * envelope <json>` | Domain events `bansync.completed` / `bansync.failed` |
| `diag:queue` | via `@squad/diag` | Diagnostic events |

## Domain events (`events` table and `events:global` stream)

`buildBansyncEnvelope` produces an `EventEnvelope` with `version: 1`, `server_id: null`, `actor: { kind: 'system', id: 'ban-sync' }`, `correlation_id: null` and a UUID v7 `event_id`.

| Type | Payload |
|---|---|
| `bansync.completed` | `{ source_id, added, updated, revoked, skipped, duration_ms, bytes }` - `duration_ms` and `bytes` describe the download; `skipped` is the adapter's skipped records plus duplicate keys inside the list |
| `bansync.failed` | `{ source_id, error, consecutive_failures, duration_ms }` - `duration_ms` is the elapsed time until the failure |

`persistAndPublish` inserts the envelope into `events` (`ON CONFLICT (event_id, occurred_at) DO NOTHING`, no `processed_events` row), then claims the dedup key and appends to `events:global`. The events are never published to the `live-bus` pub/sub channel, because they name sources and fetch errors and would reach every WebSocket viewer.

## Diagnostic events (`diag:queue` Redis Stream)

Every event carries `component: 'worker-ban-sync'`.

| Kind | Severity | Trigger | Payload |
|---|---|---|---|
| `ban_sync.started` | `info` | After wiring, before the first tick. | `{ pid }` |
| `ban_sync.stopped` | `info` | Inside the SIGTERM/SIGINT handler. | `{ sig }` |
| `ban_sync.completed` | `info` | A source synced successfully. | `{ sourceId, added, updated, revoked, skipped }` |
| `ban_sync.failed` | `error` | A source sync failed. | `{ sourceId, error, consecutiveFailures }` |

## Alert rows

On exactly the third consecutive failure of a source, `raiseBanSyncFailureAlert` inserts one `alert_events` row for every enabled `alert_rules` row with `type = 'custom'` and `config.eventKind = 'bansync.failed'` (severity from `config.severity`, default `warning`). Without such a rule nothing is raised. The row's payload is `{ source_id, source_name, error, consecutive_failures }`. It is not broadcast on the live bus.

## Exported functions

| Module | Exports |
|---|---|
| `tick.ts` | `runBanSyncTick`, `isDue`, `backoffDelayMs`, `syncExclusively`, `createTickDeps` |
| `sync-source.ts` | `syncSource`, `createSyncSourceDeps`, `ALERT_CONSECUTIVE_FAILURE_THRESHOLD` (3) |
| `fetch-source.ts` | `fetchBanList`, `FetchSourceError`, `DEFAULT_FETCH_TIMEOUT_MS`, `DEFAULT_MAX_BYTES`, `MAX_REDIRECTS` (5) |
| `adapters/index.ts` | `parseBanList(format, text, parserConfig)` and the individual `parseSquadBansCfg`, `parseBattlemetrics`, `parseJsonGeneric`, `parseCsv` |
| `merge.ts` | `planMerge`, `applyMergePlan`, `MERGE_BATCH_SIZE` (1000) |
| `manual-queue.ts` | `runManualQueueLoop`, `MANUAL_STREAM`, `MANUAL_GROUP` |
| `events.ts` | `buildBansyncEnvelope`, `persistAndPublish`, `EVENT_PERSIST_GROUP` (`worker-ban-sync:v1`) |
| `alerts.ts` | `raiseBanSyncFailureAlert` |
| `crypto.ts` | `loadEncryptionKey`, `deserialize`, `decrypt` |

The process entry point is [`src/index.ts`](../../../../apps/workers/ban-sync/src/index.ts); importing it from a test does not start the worker.

## Related HTTP routes (served by the API)

`/api/v1/ban-sources` (list, create, update, delete, `POST /:id/sync`) manages the sources this worker reads, and `/api/v1/external-bans` lists the imported bans. A source's `parser_config` is validated by the API with the same shape the adapters read (see [flows.md](./flows.md)).

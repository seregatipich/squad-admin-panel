# worker-ban-sync

## Purpose

Keeps the panel's copy of third-party ban lists current. For every enabled row of `external_ban_sources` it downloads the list over HTTP(S), parses it with the adapter for the source's format, and merges the result into `external_bans` without ever deleting a row. It polls on a timer and also serves "sync now" requests that the API appends to a Redis stream.

## Responsibilities

- Run a sync pass at startup and then every `BAN_SYNC_INTERVAL_MS` (default 60 000 ms). A pass syncs each enabled source that is due (never synced, or `last_sync_at + poll_interval_minutes` has passed), one source at a time.
- Consume manual sync jobs from the Redis stream `bansync:manual` (consumer group `ban-sync`) and sync the requested source regardless of its due time or backoff.
- Fetch with a hard timeout, a hard byte cap, an outbound address policy that refuses private destinations, manual redirect handling and an auth header that never leaves the source's origin.
- Parse `squad_bans_cfg`, `battlemetrics_json`, `json_generic` and `csv` lists.
- Merge in one transaction: insert new bans, update changed ones (clearing `revoked_at` when a ban reappears), revoke bans that disappeared from the list by setting `revoked_at`.
- Record the outcome on the source row (`last_sync_*`, `imported_count`, `consecutive_failures`), persist and publish `bansync.completed` / `bansync.failed` events, and bump `external-bans:version` after a successful sync.
- Raise an `alert_events` row on exactly the third consecutive failure when an enabled `custom` alert rule with `config.eventKind = 'bansync.failed'` exists.
- Publish `worker:heartbeat:ban-sync` every 5 s and emit `ban_sync.*` diagnostic events.

## What it does not do

- Does not delete `external_bans` rows; absent bans are revoked.
- Does not act on bans (kicks, alerts on player match); that is done by `worker-log-ingest` using the data and the `external-bans:version` cache key.
- Does not create or edit sources; the API (`/api/v1/ban-sources`) does, and is the only writer of `auth_header_encrypted`.
- Does not use the `@squad/worker-kit` `runWorker` lifecycle: it keeps its own `main()` because it runs a scheduled tick and a blocking stream consumer side by side.
- Exposes no HTTP API and opens no port.

## Code location

```
apps/workers/ban-sync/
  src/
    index.ts          - main(): env, Postgres/Redis, heartbeat, shutdown, tick timer, manual loop
    env.ts            - re-exports positiveIntEnv from @squad/worker-kit
    tick.ts           - runBanSyncTick(), isDue(), backoff, syncExclusively(), createTickDeps()
    sync-source.ts    - syncSource(): decrypt -> fetch -> parse -> merge -> record outcome
    fetch-source.ts   - fetchBanList(): timeout, byte cap, SSRF policy, redirects
    adapters/         - index.ts (dispatch), squad-bans-cfg.ts, battlemetrics-json.ts, json-generic.ts, csv.ts
    merge.ts          - planMerge() (pure diff) and applyMergePlan() (transaction)
    manual-queue.ts   - runManualQueueLoop(): XREADGROUP consumer for bansync:manual
    events.ts         - bansync.* envelopes, persistAndPublish()
    alerts.ts         - raiseBanSyncFailureAlert()
    crypto.ts         - AES-256-GCM decryption of auth_header_encrypted
  test/               - 13 files, see testing.md
  vitest.config.ts
```

## Dependencies

- `@squad/db` - Drizzle client and schema (`externalBanSources`, `externalBans`, `events`, `alertRules`, `alertEvents`)
- `@squad/shared-config` - `startHeartbeat`, `createGracefulShutdownController`, `checkOutboundUrl`, `isPublicUnicastAddress`
- `@squad/shared-types` - `BAN_SYNC_MANUAL_STREAM`, `EXTERNAL_BAN_CACHE_VERSION_KEY`, `STREAM_NAME`, `DEDUP_KEY`, `DEDUP_TTL_SECONDS`, `EventEnvelope`
- `@squad/worker-kit` - `positiveIntEnv`
- `@squad/diag` - diagnostic events
- `undici` (HTTP client), `postgres`, `drizzle-orm`, `ioredis`, `pino`, `uuid`

## Components that depend on it

- API `POST /api/v1/ban-sources/:id/sync` - appends manual jobs to `bansync:manual`.
- `worker-log-ingest` - reads `external-bans:version` to invalidate its in-memory external-ban cache after a sync.
- Consumers of `events:global` - receive the `bansync.*` envelopes (this worker's own consumer group name is only used for the dedup key).
- API routes under `/api/v1/ban-sources` and `/api/v1/external-bans`, which read `external_ban_sources` / `external_bans`.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)

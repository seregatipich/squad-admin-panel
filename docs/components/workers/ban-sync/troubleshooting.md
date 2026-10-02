# worker-ban-sync - Troubleshooting

## A source never syncs

**Diagnostic:**

```bash
redis-cli GET worker:heartbeat:ban-sync
docker compose logs worker-ban-sync --since 10m | grep -E 'ban-sync|failed|skipped'
```

```sql
SELECT name, enabled, poll_interval_minutes, last_sync_at, last_sync_status,
       last_sync_error, consecutive_failures, imported_count
FROM external_ban_sources;
```

**Possible causes:**

1. The worker is not running (heartbeat key absent).
2. The source is disabled (`enabled = false`): the scheduled tick lists only enabled sources.
3. The source is not due yet: `last_sync_at + poll_interval_minutes` is still in the future. A failed sync also sets `last_sync_at`, so a failing source waits for its poll interval (minimum 15 minutes) before the next attempt. The tick log line `ban-sync tick` shows `{ synced, failed, skippedBackoff }`.
4. The source is inside its in-memory backoff window after a failure (`skippedBackoff` in the tick log). A restart clears the backoff, and a manual sync bypasses it.
5. A sync of that source is already running in this process (the pass skips it silently).

## `last_sync_error` explained

| Message | Meaning |
|---|---|
| `source URL refused: <reason>` | The URL failed the static outbound policy: `invalid_url`, `unsupported_scheme` (only `http`/`https`), `credentials_in_url`, `internal_host` (single-label or internal-suffix host name, `localhost`), `forbidden_address` (private or non-public IP literal). The error class is `FetchSourceError` with reason `forbidden_destination`. |
| `<host> resolves to <ip>, which is not allowed` / `destination <ip> is not allowed` | The host name resolves to, or a redirect points at, a non-public address. Sources on private networks cannot be fetched by design. |
| `unexpected HTTP status <code>` | The final response was not 2xx. |
| `HTTP <code> without a Location` / `more than 5 redirects` | Redirect handling failed. |
| `content-length <n> exceeds <cap> byte cap` / `body exceeded <cap> byte cap mid-stream` | The list is larger than `BAN_SYNC_MAX_BYTES` (20 MiB by default). |
| `fetch timed out after <ms>ms` | Download (headers and body) exceeded `BAN_SYNC_FETCH_TIMEOUT_MS` (30 s by default). |
| `unsupported ban source format: <format>` | The `format` column holds a value no adapter handles. |
| `<format>: invalid JSON (...)` | The body is not JSON. |
| `<format>: parser_config...` | The source's `parser_config` has a wrongly typed key. |
| `unsupported encryption version: <v>` or a GCM authentication failure | `auth_header_encrypted` cannot be decrypted, usually because `APP_ENCRYPTION_KEY` differs from the key that encrypted it. |

Note that a list that downloads fine but contains only unparseable lines is not an error: the sync succeeds with a high `skipped` count and revokes every ban that is no longer present. Check the `bansync.completed` event payload (`skipped`) when a source suddenly loses all its bans.

## A manual sync does nothing

- The API answers `409 sync_already_queued` when a request for the same source arrived in the last 60 s (key `bansync:manual:pending:<sourceId>`).
- Check that the worker is consuming: `redis-cli XINFO GROUPS bansync:manual` shows group `ban-sync`, its consumers, `pending` and `last-delivered-id`. The group is created with `$`, so jobs added before the group existed are not delivered.
- `manual ban-sync skipped: source already syncing` in the logs means the scheduled tick (or an earlier manual job) had the source in flight; the job was acknowledged without a second sync.
- `manual sync requested for unknown source` or `malformed bansync:manual job; acked without a sync` means the job was dropped (and acknowledged).
- Entries that stay `pending` after an `XACK` failure (`manual ban-sync job could not be acknowledged; left pending`) are not re-read by this worker.

## Failure alert did not arrive

The alert is raised only on exactly the third consecutive failure and only when an enabled `custom` alert rule with `config.eventKind = 'bansync.failed'` exists; it is stored in `alert_events` and not broadcast on the live bus. A source that fails a fourth time does not raise it again, and a success resets the streak.

## `ban-sync side effect failed` warnings

Logged with `{ step, sourceId }`. These steps (`cache_invalidation`, `publish_completed`, `diag_completed`, `status_error`, `publish_failed`, `diag_failed`, `failure_alert`) never change the sync outcome; a failing `status_error` step means the error could not be written to the source row (database trouble) and `last_sync_error` will be stale.

## Worker exits or restarts in a loop

- `DATABASE_URL is required`, `REDIS_URL is required` or `APP_ENCRYPTION_KEY is required` (exit code 1): the variable is missing.
- `APP_ENCRYPTION_KEY must decode to 32 bytes, got <n>`: wrong key length.
- `<NAME> must be a positive integer, got "<value>"`: an invalid `BAN_SYNC_INTERVAL_MS`, `BAN_SYNC_FETCH_TIMEOUT_MS` or `BAN_SYNC_MAX_BYTES`.
- `manual-queue loop crashed; exiting` (fatal): the manual loop rejected, which the code treats as a bug; the process exits so the supervisor restarts it instead of heartbeating without consuming jobs.

## `previous ban-sync tick still running; this tick skipped`

A pass took longer than `BAN_SYNC_INTERVAL_MS`. Sources are synced one at a time and each fetch can take up to the 30 s timeout, so many slow sources lengthen a pass. The skipped call is dropped.

## Useful commands

```bash
docker compose logs worker-ban-sync -f --since 2m
redis-cli GET worker:heartbeat:ban-sync
redis-cli XINFO GROUPS bansync:manual
redis-cli GET external-bans:version
```

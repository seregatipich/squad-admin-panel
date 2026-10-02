# worker-ban-sync - Flows

## Startup

`main()` in `src/index.ts` (the worker does not use `runWorker`):

1. Read `DATABASE_URL`, `REDIS_URL` and `APP_ENCRYPTION_KEY`; a missing one is logged as fatal and the process exits with code 1.
2. Open the Postgres pool (`max: 4`, `prepare: false`) and a Drizzle client. Connect Redis with `maxRetriesPerRequest: null`, and create a duplicate connection (`manualRedis`) reserved for the blocking stream read.
3. Create the diag emitter and the sync dependencies (`createSyncSourceDeps` decodes `APP_ENCRYPTION_KEY`; a wrong length throws and exits with code 1).
4. Start the heartbeat (`worker:heartbeat:ban-sync`, every 5 s).
5. Install the SIGINT/SIGTERM handlers, then emit `ban_sync.started` with `{ pid }`.
6. Run the first tick. Tick errors are caught and logged (`ban-sync tick failed`), so a failing first tick does not stop the worker.
7. Mark the worker ready; if a signal arrived meanwhile, shutdown runs now and nothing is armed. Otherwise start the interval (`BAN_SYNC_INTERVAL_MS`) and the manual-queue loop.

## Scheduled tick

`runBanSyncTick` lists every source with `enabled = true` and walks them sequentially (a slow source must not consume another's timeout budget). For each source:

1. Stop if shutdown was requested (`shouldStop`).
2. Skip it when it is not due: `last_sync_at` is null (due immediately) or `last_sync_at + poll_interval_minutes` is in the future.
3. Skip it (counted as `skippedBackoff`) when its in-memory backoff entry is still in the future.
4. Run `syncSource` through `syncExclusively`; if the same source is already being synced in this process, the pass skips it silently.
5. On success, delete its backoff entry and count `synced`. On failure, set the entry to `now + min(60 min, 1 min * 2^(consecutive_failures + 1))` (the source's failure count before this attempt, plus one) and count `failed`.

The tick logs `ban-sync tick` at `info` with `{ synced, failed, skippedBackoff }`. If the interval fires while a tick is still running, `previous ban-sync tick still running; this tick skipped` is logged at `warn`.

## Syncing one source (`syncSource`)

Outcome-deciding stages, in one `try`:

1. Decrypt `auth_header_encrypted` when present.
2. `fetchBanList(url, authHeader)`.
3. `parseBanList(format, text, parser_config)`; an unknown format throws `unsupported ban source format: <format>`.
4. Load the source's existing `external_bans` rows and compute `planMerge`.
5. `applyMergePlan` (one transaction).
6. Update the source row to `ok`.

`skipped` in the report is the adapter's skipped count plus `plan.skippedDuplicateKeys`.

After a success, best-effort steps run (a failure is logged at `warn` as `ban-sync side effect failed` with `{ step, sourceId }` and never changes the outcome, #856): `INCR external-bans:version`, persist and publish `bansync.completed`, emit `ban_sync.completed`.

After any failure in stages 1 to 6, `recordFailure` runs the best-effort steps: write the error status and increment `consecutive_failures`, persist and publish `bansync.failed`, emit `ban_sync.failed`, and, when the new failure count is exactly 3, raise the alert. `syncSource` never throws; it returns a `SyncReport` (`ok`, counts, `durationMs`, `bytes`, `error`).

## Fetching (`fetchBanList`)

- The URL must pass `checkOutboundUrl`: `http:` or `https:` only, no credentials in the URL, and a public IP literal or a fully qualified host name (single-label names such as `redis` and internal-only suffixes are refused). Otherwise `forbidden_destination`.
- Every address a host name resolves to is checked with `isPublicUnicastAddress` inside the connection's DNS hook (so there is no gap between the check and the connect); one non-public address refuses the connection (`forbidden_destination`). IP literals are checked directly.
- Redirects (301, 302, 303, 307, 308) are followed by hand, at most 5 hops. Each target is re-checked, and the `Authorization` header is sent only while the request stays on the source's origin. A redirect response without `Location`, or a sixth redirect response, fails with `http_status`.
- A non-2xx final status fails with `http_status` (`unexpected HTTP status <code>`).
- A `content-length` above the cap fails immediately with `size_limit_exceeded`; the body is also counted while streaming and cut off once it exceeds the cap.
- One `AbortController` timeout (default 30 s) covers the whole fetch including the body (`timeout`). Other transport errors are `network`.
- The body is decoded as UTF-8. The result is `{ text, bytes, durationMs }`.

## Adapters

| Format | Reads |
|---|---|
| `squad_bans_cfg` | One ban per line: `[<prefix>]Banned:<17-digit SteamID64>:<unix expiry>[ // reason]`. Expiry `0` means permanent (`expires_at` NULL). The admin name comes from the prefix (surrounding brackets or parentheses removed), the reason from the `//` comment. Blank lines and lines starting with `//` or `#` are ignored; non-matching lines, non-17-digit ids and out-of-range expiries are counted as skipped. `issued_at` is NULL and `raw` is `{ line }`. |
| `battlemetrics_json` | `list_path` default `data`. `steam_id64`, `eos_id` and `nickname` are taken from the `attributes.identifiers` entries of type `steamID`, `eosID` and `name`; reason from `attributes.reason`, admin from `attributes.note`, `issued_at` from `attributes.timestamp`, `expires_at` from `attributes.expires` (null is permanent). Every field can be overridden with `parser_config.fields` dot-paths. `raw` is the whole record. |
| `json_generic` | `parser_config = { list_path?, fields? }`. Default field names `steam_id64`, `eos_id`, `nickname`, `reason`, `admin_name`, `issued_at`, `expires_at`, each remappable by a dot-path. `list_path` defaults to the root array. `raw` is the whole record. |
| `csv` | `parser_config.csv = { delimiter?, has_header?, columns }`. Delimiter is one character (default `,`), `has_header` defaults to true, each column is a numeric index or a header name. Quoted fields with `""` escapes are supported; an unterminated quote skips the row. Fields are trimmed and empty values become null. `raw` is `{ fields }`. |

Common rules: a record with neither `steam_id64` nor `eos_id` is skipped; numeric timestamps are unix seconds and strings are parsed as dates (out-of-range values become null); invalid JSON throws `<format>: invalid JSON (...)`; a malformed `parser_config` throws a descriptive error such as `json_generic: parser_config.list_path must be a string`.

## Merge (`planMerge`, `applyMergePlan`)

`planMerge` is a pure diff keyed like the database unique index (`steam_id64`, `eos_id`, `issued_at`, with the same coalesce rules):

- Incoming records whose key repeats inside the list are counted in `skippedDuplicateKeys` and not inserted twice.
- A key with no existing row is inserted.
- A key with an existing row is updated only when `nickname`, `reason`, `admin_name`, `expires_at` or `raw` differ (`raw` is compared with sorted keys at every depth, because Postgres reorders jsonb keys, #34), or when the row is currently revoked (the update clears `revoked_at`).
- Existing, not yet revoked rows whose key is absent from the list are revoked. Nothing is deleted.

`applyMergePlan` runs everything in one transaction (#854): inserts in batches of 1 000 with `ON CONFLICT DO NOTHING` (so a manual sync overlapping a scheduled one cannot fail on a ban the other just inserted, #853; `added` counts rows actually inserted), updates in batches of 500 through `UPDATE ... FROM (VALUES ...)`, and revokes in batches of 1 000 ids. Batching keeps each statement under the driver's bound-parameter limit (a list of about 6 500 new rows would otherwise fail every sync). `updated` and `revoked` in the report are the plan's counts.

## Manual sync queue

`runManualQueueLoop` runs until shutdown:

1. Create the group `ban-sync` on `bansync:manual` (`$`, `MKSTREAM`); retry every second while creation fails; recreate it after a `NOGROUP` read error.
2. `XREADGROUP ... BLOCK 5000 ... >` on the dedicated connection; on a read error (other than during shutdown) log at `warn` and retry after 1 s.
3. For each entry: parse the `job`, load the source by id, run `syncExclusively` (the sync is skipped, logged `manual ban-sync skipped: source already syncing`, when the scheduled tick is syncing that source), clear the source's backoff entry when the sync succeeded, log `manual ban-sync`. The entry is then acknowledged with `XACK`, whatever the outcome: a failed manual sync is recorded on the source like any other and the scheduled tick retries it.
4. If `XACK` fails the loop logs it and continues; that entry stays pending for the consumer. Only new entries (`>`) are read, so pending entries are not re-read by this worker.

A manual sync ignores the due time and the backoff window and works for a disabled source. If the loop itself rejects (a bug, since it contains its own failures), the worker logs `fatal` and exits with code 1 rather than heartbeat while manual jobs go unconsumed (#1292).

## Graceful shutdown (SIGTERM / SIGINT)

1. Set `stopped`, clear the tick interval.
2. Emit `ban_sync.stopped` with `{ sig }`.
3. Stop the heartbeat.
4. Disconnect `manualRedis`, which ends the blocked read at once instead of waiting up to 5 s, and wait for the manual loop to return.
5. Wait for the tick in progress (it stops between sources once `stopped` is set), so a merge is not cut off by closing the pool.
6. `sql.end({ timeout: 5 })`, then `redis.quit()`.
7. Exit with code 0 (code 1 if the cleanup itself threw).

A signal received during the first tick is remembered and the cleanup runs after it.

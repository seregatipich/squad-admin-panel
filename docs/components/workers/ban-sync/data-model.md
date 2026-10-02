# worker-ban-sync - Data model

## Postgres

### `external_ban_sources`

Read: all columns, for sources with `enabled = true` (tick) or by id (manual job).

Written by `syncSource`:

| Outcome | Columns set |
|---|---|
| Success | `last_sync_at` = completion time, `last_sync_status = 'ok'`, `last_sync_error = NULL`, `imported_count = added + updated` **of this sync** (not the total number of imported bans), `consecutive_failures = 0` |
| Failure | `last_sync_at` = failure time, `last_sync_status = 'error'`, `last_sync_error` = the error message, `consecutive_failures` = previous value + 1 |

Because a failure also sets `last_sync_at`, a failed source waits for its poll interval before it is due again, in addition to the in-memory backoff.

Constraints that matter: `format` is one of `squad_bans_cfg`, `battlemetrics_json`, `json_generic`, `csv`; `poll_interval_minutes >= 15`; `last_sync_status` is `NULL`, `ok` or `error`.

### `external_bans`

Read: the rows of the source being synced (`id`, `steam_id64`, `eos_id`, `nickname`, `reason`, `admin_name`, `issued_at`, `expires_at`, `raw`, `revoked_at`).

Written by `applyMergePlan`, in one transaction per sync:

- **Insert** `id` (UUID v7), `source_id`, `steam_id64`, `eos_id`, `nickname`, `reason`, `admin_name`, `issued_at`, `expires_at`, `raw` (`{}` when missing). `imported_at` takes its default.
- **Update** `nickname`, `reason`, `admin_name`, `expires_at`, `raw` and `revoked_at = NULL` of changed rows. `issued_at` is part of the identity and never updated.
- **Revoke** sets `revoked_at` on rows missing from the fetched list. Rows are never deleted by the worker (they are removed only by `ON DELETE CASCADE` when the API deletes the source).

Identity: a unique index `external_bans_dedup_key` on `(source_id, coalesce(steam_id64, ''), coalesce(eos_id, ''), coalesce(issued_at, 'epoch'))`. The in-memory merge key is built with the same coalesce rules. A row needs a `steam_id64` or an `eos_id` (`external_bans_identity_chk`).

### `events`

One row per `bansync.completed` / `bansync.failed`: `event_id`, `server_id = NULL`, `occurred_at`, `kind` (the event type), `version = 1`, `actor_kind = 'system'`, `actor_id = 'ban-sync'`, `correlation_id = NULL`, `payload`. Idempotent on the primary key `(event_id, occurred_at)`. See [api.md](./api.md) for the payloads.

### `alert_rules` / `alert_events`

`alert_rules` is read (enabled rules of type `custom`) when a source reaches its third consecutive failure. `alert_events` receives `id` (UUID v7), `rule_id`, `severity` and `payload`.

## Redis keys

| Key | Retention | Description |
|---|---|---|
| `worker:heartbeat:ban-sync` | TTL 30 s | Liveness heartbeat |
| `bansync:manual` (stream, consumed) | capped by the API at `MAXLEN ~ 1000` | Manual sync jobs; group `ban-sync` |
| `external-bans:version` | none | Counter incremented after each successful sync |
| `dedup:worker-ban-sync:v1:<event_id>` | 24 h | Producer-side dedup for `events:global` |
| `events:global` (stream) | `MAXLEN ~ 10000` | Domain events |
| `diag:queue` (stream) | `MAXLEN` managed by `@squad/diag` | Diagnostic events |

## In-memory state

- `backoff`: `Map<sourceId, { nextAttemptAt }>`. Lost on restart; after a restart the tick relies on `last_sync_at` and `poll_interval_minutes` only.
- `inFlight`: the set of source ids being synced right now, shared by the scheduled tick and the manual-queue consumer so one source is never synced twice at once.

## Encryption format

`auth_header_encrypted` (`bytea`) holds a UTF-8 JSON blob `{ v: 1, kv, iv, tag, ct }` with base64 `iv`, `tag` and `ct`, encrypted with AES-256-GCM (16-byte auth tag). The worker only decrypts; the API is the only writer. A blob with `v` other than 1 fails the sync with `unsupported encryption version: <v>`.

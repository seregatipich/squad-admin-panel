# worker-clan-priority-expirer - Data model

## Postgres

### Read

| Table | Columns | Why |
|---|---|---|
| `clans` | `id`, `name`, `priority_expires_at`, `priority_expiry_processed`, `deleted_at` | Select clans whose deadline has passed and that are not yet processed. |
| `clan_members` | `clan_id`, `has_priority` | A clan is "non-empty" when at least one member has `has_priority = true`. |
| `servers` | `id`, `deleted_at`, `runtime` | Read inside `enqueueAdminsCfgSyncForAllServers` to choose the target servers. |

### Written

| Table | Change |
|---|---|
| `clans` | `priority_expiry_processed` set to `true`. No other column is touched (`updated_at` is not bumped). |
| `audit_log` | One row per expired clan, `action_type = 'clan.priority.expire'` (see [api.md](./api.md)). `row_hash` is inserted as an empty buffer; the `audit_log` append trigger computes the hash chain. |
| `admins_cfg_sync_outbox` | One row per active panel-hosted server (`deleted_at IS NULL AND runtime = 'container'`) with the payload shown in [api.md](./api.md). `correlation_id` is not set. |

`clan_members.has_priority` is never written.

### Selection predicate

A clan is expired when `deleted_at IS NULL AND priority_expires_at <= now AND priority_expiry_processed = false`, where `now` is the tick time (`deps.now`, defaulting to `new Date()`). Clans with a `NULL` deadline never match.

### Reset path

`PATCH /api/v1/clans/:id/expire` (API) sets `priority_expiry_processed = false` whenever it clears the deadline or moves it into the future. The worker treats the flag as restart-safe bookkeeping: it survives restarts because it lives in Postgres.

## Redis keys written

| Key | Retention | Description |
|---|---|---|
| `worker:heartbeat:clan-priority-expirer` | TTL 30 s | Liveness heartbeat |
| `diag:queue` (stream) | `MAXLEN` managed by `@squad/diag` | Diagnostic events |

The worker does not write `events:admins-cfg-sync:<serverId>`; `worker-config-sync` does, from the outbox.

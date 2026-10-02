# worker-clan-priority-expirer - API surface

No HTTP surface. The worker is driven by its timer and by the `clans` table; it consumes no Redis stream.

## Exported functions

All exports are in [`src/tick.ts`](../../../../apps/workers/clan-priority-expirer/src/tick.ts).

| Function | Purpose |
|---|---|
| `runClanPriorityExpiryTick(deps)` | One pass. Finds expired unprocessed clans, expires them through `deps.expireClans`, emits `run_ok`, and returns `{ expiredClans, enqueued }`. Emits `run_failed` and rethrows on any error. |
| `createClanPriorityExpiryDeps(db)` | Binds `findExpiredUnprocessedClans` and `expireClans` to a Drizzle client. |
| `findExpiredUnprocessedClans(db, now)` | Marks empty expired clans processed, then returns the expired clans that still have a `has_priority` member, oldest `priority_expires_at` first. |
| `expireClans(db, candidates, now, event)` | The single transaction described in [flows.md](./flows.md). Returns `{ expired, enqueued }`; `expired` contains only the clans the update actually changed. |
| `buildClanPriorityExpiryAuditEntry(clan, now)` | Builds the audit entry for one clan. |
| `writeClanPriorityExpiryAuditEntry(db, entry)` | Inserts the entry into `audit_log`. |

The process entry point is [`src/index.ts`](../../../../apps/workers/clan-priority-expirer/src/index.ts); importing it from a test does not start the worker.

## Postgres outbox: `admins_cfg_sync_outbox`

One row per active panel-hosted server per expiry pass (servers with `deleted_at IS NULL` and `runtime = 'container'`). The `payload` is:

```json
{
  "reason": "clan.priority.expire",
  "actor_player_id": null,
  "enqueued_at": "<tick time, ISO 8601>",
  "request_id": "clan-priority-expirer:<tick time, ISO 8601>"
}
```

`worker-config-sync` relays pending rows onto `events:admins-cfg-sync:<serverId>` (adding `_outbox_id`) and applies them. This worker never writes to that stream itself.

## Audit entry (`audit_log`)

| Field | Value |
|---|---|
| `actor_kind` | `system` |
| `actor_system_label` | `clan-priority-expirer` |
| `action_type` | `clan.priority.expire` |
| `target_type` / `target_id` | `clan` / the clan UUID |
| `before_snapshot` | `{ "priority_expires_at": "<ISO>", "priority_expiry_processed": false }` |
| `after_snapshot` | `{ "priority_expiry_processed": true }` |
| `context` | `{ "clan_name": "<name>", "expired_at": "<tick time, ISO>" }` |
| `status_code` | `200` |

## Heartbeat key: `worker:heartbeat:clan-priority-expirer`

Published every 5 s with TTL 30 s and status text `running`.

## Diagnostic events (`diag:queue` Redis Stream)

Emitted through `@squad/diag`; every event carries `component: 'worker-clan-priority-expirer'`.

| Kind | Severity | Trigger | Payload |
|---|---|---|---|
| `clan_priority_expirer.started` | `info` | After startup wiring, before the first pass. | `{ pid }` |
| `clan_priority_expirer.stopped` | `info` | Inside the SIGTERM/SIGINT handler. | `{ sig }` |
| `clan_priority_expirer.run_ok` | `info` | End of every successful pass, including passes that expire nothing (`expired 0 clan priority windows`). | `{ expiredClans, enqueued }` |
| `clan_priority_expirer.run_failed` | `error` | Any error inside a pass, before it is rethrown. | `{ err }` |

## Related HTTP routes (served by the API)

`PATCH /api/v1/clans/:id/expire` sets or clears `clans.priority_expires_at`. When the new deadline is `null` or in the future it also sets `priority_expiry_processed = false`; it writes a `clan.expire.update` audit entry and enqueues its own Admins.cfg sync (`reason: clan.expire.update`).

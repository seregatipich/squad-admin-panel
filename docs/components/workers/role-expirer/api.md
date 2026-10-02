# API

The worker has no direct HTTP API and opens no port. It is driven only by its
three timers. Role grants, subscriptions, reminder windows and alerts are read
and written by the API; this worker only reacts to the stored dates.

## Exported functions

| Module | Function | Purpose |
|---|---|---|
| [`src/tick.ts`](../../../../apps/workers/role-expirer/src/tick.ts) | `runRoleExpiryTick(deps)` | One expiry pass. Returns `{ expired, enqueued }`. |
| `src/tick.ts` | `createRoleExpiryDeps(db, redis, { batchSize? })` | Builds the DB and Redis dependencies; `batchSize` defaults to 500. |
| `src/tick.ts` | `findExpiredAssignments(db, now, limit)` | Expired, non-Owner, non-renewing assignments ordered by `role_expires_at`. |
| `src/tick.ts` | `clearExpiredAssignments(db, assignments, now, event)` | One transaction: clear, audit, delete sessions, enqueue Admins.cfg sync. |
| `src/tick.ts` | `notifySessionsRevoked(redis, playerId, sessionIds)` | Redis cache delete and `session.revoked` live-bus frames. |
| `src/tick.ts` | `revokeAllSessionsForPlayer(db, redis, playerId)` | Delete a player's sessions and notify; mirrors the API helper. Not called by the tick. |
| [`src/reminders.ts`](../../../../apps/workers/role-expirer/src/reminders.ts) | `runRoleExpiryReminderTick(deps)` | One reminder pass. Returns `{ notified }`. |
| `src/reminders.ts` | `createRoleExpiryReminderDeps(db, redis, { batchSize? })` | `batchSize` defaults to 1000. |
| `src/reminders.ts` | `loadReminderWindows`, `findExpiringGrants`, `claimExpiryNotification` | The reminder queries. |
| [`src/renewal.ts`](../../../../apps/workers/role-expirer/src/renewal.ts) | `runSubscriptionRenewalTick(deps)` | One renewal pass. Returns `{ renewed, expired, enqueued }`. |
| `src/renewal.ts` | `createSubscriptionRenewalDeps(db, redis, { batchSize? })` | `batchSize` defaults to 500. |
| `src/renewal.ts` | `findDueSubscriptions`, `chargeRenewal`, `expireSubscription`, `notifySubscriptionExpired` | The renewal queries and writes. |
| [`src/env.ts`](../../../../apps/workers/role-expirer/src/env.ts) | `positiveIntEnv(value)`, `requiredTickIntervalMs(name, value, fallback)` | Interval parsing; an invalid non-empty value throws at startup. |
| [`src/system-events.ts`](../../../../apps/workers/role-expirer/src/system-events.ts) | `writeSystemAuditEntry`, `publishAlertFrame`, `LIVE_BUS_CHANNEL` | Shared audit insert and live-bus publish. |

`src/index.ts` re-exports `guardAgainstOverlap` from `@squad/worker-kit` for the
overlap regression test.

## Redis surfaces

| Surface | Direction | Details |
|---|---|---|
| `worker:heartbeat:role-expirer` | write | Published every 5 s with a 30 s TTL; status `running`. |
| `diag:queue` stream | write | Diagnostic events (see below). |
| `session:<sessionId>` | `DEL` | One key per revoked session, after the database delete commits. |
| `live-bus` pub/sub channel | publish | `session.revoked` frames and `alert.triggered` frames. |

`session.revoked` frames carry `{ type: 'session.revoked', ts, data: { player_id, session_id } }`.
`alert.triggered` frames carry `{ type: 'alert.triggered', ts, data: <payload> }`,
where the payload is either the `role_expiring` or the `subscription_expired`
shape below. The API fans `alert.triggered` frames with these `event_kind`
values out only to sockets that hold `can_assign_roles`.

The worker publishes no domain event on a Redis stream. Admins.cfg sync work is
inserted into the `admins_cfg_sync_outbox` table (see [data-model.md](data-model.md));
`worker-config-sync` relays it to `events:admins-cfg-sync:<serverId>`.

### Alert payloads

`role_expiring` (reminder tick):

```json
{
  "event_kind": "role_expiring",
  "player_id": "<uuid>",
  "player_name": "<canonical name>",
  "role_id": "<uuid>",
  "role_name": "<role name>",
  "expires_at": "<ISO 8601>",
  "window_days": 3
}
```

`subscription_expired` (renewal tick):

```json
{
  "event_kind": "subscription_expired",
  "player_id": "<uuid>",
  "player_name": "<canonical name>",
  "subscription_id": "<uuid>",
  "tier_id": "<uuid>",
  "tier_name": "<tier name>",
  "reason": "insufficient_balance",
  "price_bonuses": 100,
  "balance": 40
}
```

`reason` is one of `insufficient_balance`, `role_conflict`, `role_permanent`,
`player_not_found`, `role_grants_panel_access`. `balance` is set only for
`insufficient_balance` and is `null` otherwise.

### Admins.cfg sync payload

The payload stored in each outbox row:

```json
{
  "reason": "player.role.expire",
  "actor_player_id": null,
  "enqueued_at": "<ISO 8601>",
  "request_id": "role-expirer:<ISO 8601>"
}
```

The renewal tick uses `reason: "player.role.assign"` and
`request_id: "role-expirer:renewals:<ISO 8601>"`.

## Diagnostic events

All events use `component: 'worker-role-expirer'`.

| Kind | Severity | Emitted when |
|---|---|---|
| `role_expirer.started` | `info` | Startup, with payload `{ pid }`. |
| `role_expirer.stopped` | `info` | On SIGINT or SIGTERM, with payload `{ sig }`. |
| `role_expirer.run_ok` | `info` | Every expiry pass that finishes, including an empty one. Payload `{ expired, enqueued }`. |
| `role_expirer.run_failed` | `error` | The expiry pass threw; the error is rethrown to the runner. |
| `role_expirer.session_notify_failed` | `warn` | The Redis fan-out for one player failed after the commit. |
| `role_expirer.reminders_ok` | `info` | A reminder pass finished. Payload `{ notified, windows }`. |
| `role_expirer.reminders_failed` | `error` | The reminder pass threw. |
| `role_expirer.renewals_ok` | `info` | A renewal pass finished. Payload `{ renewed, expired, enqueued }`. |
| `role_expirer.renewals_failed` | `error` | The renewal scan threw. |
| `role_expirer.renewal_failed` | `error` | One subscription failed inside the batch; the rest continue. Payload `{ subscription_id, player_id }`. |

## HTTP routes that feed the worker

The worker reads data written by these API areas; it never calls them.

| Data | Written by |
|---|---|
| `players.role_expires_at`, `players.role_comment` | Player role assignment routes. |
| `vip_subscriptions` rows | VIP subscription routes (`apps/api/src/routes/vip-subscriptions.ts`). |
| `economy_settings.vip_expiry_windows_days`, `vip_expiry_warn_in_game` | `PUT /api/v1/settings/economy`. |

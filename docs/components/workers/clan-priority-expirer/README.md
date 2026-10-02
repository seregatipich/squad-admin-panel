# worker-clan-priority-expirer

## Purpose

Detects clans whose reserved-slot priority window (`clans.priority_expires_at`) has passed and records that fact exactly once: it marks the clan processed, writes one audit row per clan, and enqueues one Admins.cfg sync per active server so `worker-config-sync` rewrites the managed segment without the expired clan's members. It runs once at startup and then every 60 s.

## Responsibilities

- Run `runClanPriorityExpiryTick` at startup and on every `CLAN_PRIORITY_EXPIRER_INTERVAL_MS` tick (default 60 000 ms).
- Silently mark expired clans that have no `has_priority` member as processed (no audit row, no sync).
- For expired, unprocessed clans that do have a `has_priority` member, in **one transaction**: set `clans.priority_expiry_processed = true`, insert one `clan.priority.expire` row per clan into `audit_log`, and insert one `admins_cfg_sync_outbox` row per active panel-hosted server.
- Publish `worker:heartbeat:clan-priority-expirer` every 5 s (via `@squad/worker-kit`).
- Emit `clan_priority_expirer.*` diagnostic events.

## What it does not do

- Does not modify `clan_members.has_priority`. The per-member toggle is preserved so that extending the deadline brings priorities back without re-toggling. The expiry takes effect because the Admins.cfg builder skips members of clans whose `priority_expires_at` is in the past (`packages/db/src/admins-cfg-sync.ts`).
- Does not write `Admins.cfg` and does not talk to the bridge or RCON. It only enqueues outbox rows; `worker-config-sync` relays them to `events:admins-cfg-sync:<serverId>` and applies them.
- Does not process soft-deleted clans (`clans.deleted_at IS NOT NULL`).
- Does not enqueue syncs for external servers (`servers.runtime = 'external'`) or soft-deleted servers.
- Exposes no HTTP API and opens no port.

## Code location

```
apps/workers/clan-priority-expirer/
  src/
    index.ts    - runWorker() wiring: env, tick interval, overlap guard
    env.ts      - re-exports positiveIntEnv from @squad/worker-kit
    tick.ts     - runClanPriorityExpiryTick(), find/expire queries, audit entry builder
  test/
    contract.test.ts
    tick.test.ts
    tick.integration.test.ts
    tick-atomicity.integration.test.ts
  vitest.config.ts
```

## Dependencies

- `@squad/worker-kit` - `createWorkerLog`, `runWorker`, `positiveIntEnv`
- `@squad/db` - Drizzle client, `enqueueAdminsCfgSyncForAllServers`, schema (`clans`, `clanMembers`, `auditLog`)
- `@squad/diag` - `Diag` type for diagnostic events
- `drizzle-orm`, `ioredis` (Redis is used by the kit for the heartbeat and diagnostics only)

## Components that depend on it

- `worker-config-sync` - relays the outbox rows and rewrites Admins.cfg for each server.
- API `PATCH /api/v1/clans/:id/expire` - resets `priority_expiry_processed` when a deadline is cleared or moved into the future, so this worker will expire the clan again later.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [config-sync worker](../config-sync/README.md)

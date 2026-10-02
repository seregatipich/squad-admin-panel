# `shared-types` — flows

## EventEnvelope flow

```
Producers                           Redis Streams              Consumers
─────────────────────────────────── ─────────────────────────  ──────────────────────────────────
worker-rcon                         events:server:{uuid}       apps/api XREVRANGE
  rcon.players_polled       ──────►                    ──────► GET /api/v1/servers/:id/events
  rcon.connected/disconnected        events:global             web polling (SSE or fetch)

worker-log-ingest                   events:server:{uuid}       worker-discord, worker-automation
  player.connected          ──────►                    ──────► notifications / automation rules
  player.disconnected                                          (persisted to `events` by log-ingest
  player.name_changed                                          itself, not by a stream consumer)
  match.started / ended

apps/api (install flow)             events:server:{uuid}       web install WebSocket
  server.install.started    ──────►                    ──────► progress bar, log lines
  server.install.progress
  server.install.failed
  server.install.completed

apps/api (status-reconciler)        events:server:{uuid}       web status polling
  server.starting           ──────►                    ──────► status badge update
  server.running
  server.stopping
  server.stopped

apps/api (bridge plugin)            events:global              web health card
  bridge.connected          ──────►                    ──────► bridge status indicator
  bridge.disconnected
```

### EventEnvelope ID ordering

`event_id` is UUIDv7 (time-based, sortable). Redis Stream IDs (`{ms}-{seq}`) are the physical sort key; `event_id` provides logical identity for deduplication and cross-stream correlation. Both are monotonically increasing under normal conditions.

### Idempotency protocol

Idempotency is a single Redis layer, per consumer group (`worker-discord`, `worker-automation`, ...):

1. Before acting, the consumer checks `dedup:{group}:{event_id}`; if present it only `XACK`s.
2. After the side effect succeeds it runs `SET dedup:{group}:{event_id} 1 EX 86400 NX`, then `XACK`s.

If the consumer crashes after the side effect but before the key is set or the `XACK`, the event is redelivered and the effect can run again, so side effects should tolerate a repeat. The `processed_events` table is no longer written by any producer or consumer (#62); `worker-event-partition` only prunes leftover rows. `events` rows are deduplicated by their `(event_id, occurred_at)` primary key.

Producers (`worker-log-ingest`, `worker-ban-sync`) also set a `dedup:` key under their own group so a replayed log line is not appended to the stream twice; it is released when `XADD` fails.

### Reclaim

Consumer group names, the `XAUTOCLAIM` idle threshold and the tick interval are owned by each worker (for example `DISPATCH_CONSUMER_GROUP` in `apps/workers/automation/src/dispatch.ts`); this package no longer exports shared constants for them. `STREAM_NAME.eventsDlq()` names the `events:dlq` stream, but nothing writes it today: a consumer that keeps failing stays pending, except that `worker-discord` acks an entry after `MAX_DELIVERY_ATTEMPTS` failed deliveries.

---

## Zod schema validation flow (API requests)

```
HTTP request body
  │
  └─ Fastify route handler
       └─ z.parse / z.safeParse
            └─ serverCreateInput.parse(body)   → ServerCreateInput (typed)

On parse failure:
  └─ Zod throws ZodError → Fastify error handler → 400 with issues array
```

Schemas are `.strict()` — unknown keys cause a validation error, preventing accidental field exposure.

---

## `validatePayload` dispatch

Available to producers and consumers that want to check a payload against its registered schema. It is currently called only from tests: worker consumers narrow `event.payload` with type assertions instead of validating it.

```ts
import { validatePayload } from '@squad/shared-types/events';

const result = validatePayload(envelope.type, envelope.payload);
if (!result.ok) {
  // skip or log: no DLQ writer exists today
}
```

For event types without a registered payload schema (e.g. `server.updated`, `bridge.connected`), `validatePayload` returns `{ ok: true }` unconditionally — forward-compat for new event types added by future producers.

# `shared-types` — flows

## EventEnvelope flow

```
Producers                           Redis Streams              Consumers
─────────────────────────────────── ─────────────────────────  ──────────────────────────────────
worker-rcon                         events:server:{uuid}       apps/api XREVRANGE
  rcon.players_polled       ──────►                    ──────► GET /api/v1/servers/:id/events
  rcon.connected/disconnected        events:global             web polling (SSE or fetch)

worker-log-ingest                   events:server:{uuid}       players-projector consumer group
  player.connected          ──────►                    ──────► UPSERT players, player_name_history
  player.disconnected
  player.name_changed                                          audit-archiver consumer group
  match.started / ended     ──────► events:server:{uuid} ───► cold-archive rows older than 90d

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

Every consumer follows the dual-layer idempotency pattern before acting:

1. `SET dedup:{group}:{event_id} 1 EX 86400 NX` — fast path, survives Redis restart only up to TTL.
2. `INSERT INTO processed_events (event_id, group_name) ON CONFLICT DO NOTHING` — durable guarantee.

`XACK` runs only after the side-effect commits. If the consumer crashes after commit but before `XACK`, the event is redelivered; idempotency prevents double-processing.

### Reclaim

Consumer group names, the `XAUTOCLAIM` idle threshold and the tick interval are owned by each worker (for example `DISPATCH_CONSUMER_GROUP` in `apps/workers/automation/src/dispatch.ts`); this package no longer exports shared constants for them. `STREAM_NAME.eventsDlq()` names the `events:dlq` stream, but no consumer moves messages into it today.

---

## Zod schema validation flow (API requests)

```
HTTP request body
  │
  └─ Fastify route handler
       └─ z.parse / z.safeParse
            ├─ serverCreateInput.parse(body)   → ServerCreateInput (typed)
            ├─ serverRow.parse(dbRow)           → ServerRow
            └─ paginated(serverRow).parse(...)  → { items, total, page, page_size }

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
  // move to DLQ or skip
}
```

For event types without a registered payload schema (e.g. `server.updated`, `bridge.connected`), `validatePayload` returns `{ ok: true }` unconditionally — forward-compat for new event types added by future producers.

# Event envelope

Every event flowing through Redis Streams between workers and the API uses the same envelope shape, defined by `packages/shared-types/src/events.ts`.

## Shape

```ts
interface EventEnvelope {
  event_id: string;           // UUIDv7; sortable so streams stay chronological
  version: number;            // schema version; starts at 1, bumps on breaking change
  type: EventType;            // discriminator; enum from shared-types
  server_id: string | null;   // null for host-scope events
  ts: string;                 // ISO-8601 UTC when the event occurred
  actor: { kind: 'user' | 'system' | 'external'; id: string | null } | null;
  correlation_id: string | null;  // request trace id when the event was caused by an HTTP request
  payload: unknown;           // typed per type; see PAYLOAD_SCHEMAS
}
```

## Types (Phase 0)

| Type                         | Producer         | Consumer                               |
|------------------------------|------------------|----------------------------------------|
| `server.ready`               | log-ingest       | players-projector, API state updater   |
| `server.starting`            | API              | —                                      |
| `server.running`             | API (on-verify)  | —                                      |
| `server.stopped`             | log-ingest       | API state updater                      |
| `server.crashed`             | log-ingest       | API state updater (plus metric)        |
| `server.restarted`           | systemd (log)    | API state updater                      |
| `server.install.*`           | API install flow | UI (WebSocket mirror)                  |
| `player.connected`           | log-ingest       | players-projector (UPSERT players)     |
| `player.disconnected`        | log-ingest       | players-projector (last_seen)          |
| `match.started` / `.ended`   | log-ingest       | stats (Phase 2)                        |
| `rcon.players_polled`        | worker-rcon      | players-projector (UPSERT name history)|
| `rcon.connected` / `.disconnected` | worker-rcon | UI (health card)                       |

## Streams & consumer groups

```
events:server:{uuid}  — per-server pipeline
events:global         — host-scope events (bridge connect/disconnect, partman)
events:dlq            — messages that exhausted the retry budget
```

Consumer groups are named `<service>:v<schema-version>`, e.g. `players-projector:v1`. Bumping the version starts a fresh group that replays the stream from the tail.

## Idempotency (dual-layer)

Every consumer does both:

1. `SET dedup:${group}:${event_id} 1 EX 86400 NX` — fast short-circuit when a message is redelivered.
2. `INSERT INTO processed_events (event_id, group_name) ON CONFLICT DO NOTHING` — durable guarantee that survives Redis restarts.

Only after both succeed does the consumer act on the event. `XACK` runs only after the side-effect commits. On failure, the Redis dedup key is `DEL`-ed so XAUTOCLAIM's retry can proceed.

## Reclaim / DLQ

- `XAUTOCLAIM` runs every 30 s with a 120 s idle threshold in every consumer.
- After five deliveries to the same pending entry, the reclaimer moves the message to `events:dlq` and `XACK`s the original.

## Upcasting (when version changes)

When a new field becomes required:

1. Bump `version` to 2 in producers.
2. Consumers of both versions **must** pass a read-time `upcast(envelope)` that fills in the new field from v1 defaults.
3. Once every producer is on v2, mark v1 as deprecated. Remove upcast a release later.

The upcast pipeline lives per-consumer (not shared) so each team moves on its own cadence.

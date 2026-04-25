# `shared-types` — data model

Source of truth: [`packages/shared-types/src/events.ts`](../../../packages/shared-types/src/events.ts).

## `EventEnvelope`

```ts
interface EventEnvelope {
  event_id: string;          // UUIDv7, sortable so streams stay chronological
  version: number;           // schema version; starts at 1
  type: EventType;           // discriminator
  server_id: string | null;  // null for host-scope events
  ts: string;                // ISO-8601 UTC when the event occurred
  actor: { kind: 'user' | 'system' | 'external'; id: string | null } | null;
  correlation_id: string | null;  // request trace id when caused by an HTTP request
  payload: unknown;          // typed per `type`
}
```

Validated with `eventEnvelope` (Zod, `.strict()`).

## `EventType` (current)

| Type | Producer | Consumer |
|---|---|---|
| `server.starting` | `api` | UI mirror |
| `server.running` | `api` (status-reconciler) | UI mirror |
| `server.stopping` | `api` | UI mirror |
| `server.stopped` | `worker-log-ingest` / `api` | API state updater |
| `server.crashed` | `worker-log-ingest` | API state updater (plus metric) |
| `server.restarted` | `api` | UI mirror |
| `server.ready` | `worker-log-ingest` | players-projector, API |
| `server.installed` | `api` install flow | UI mirror |
| `server.updated` | `api` (post `depot_update`) | UI mirror |
| `server.install.started` | `api` install WS | UI |
| `server.install.progress` | `api` install WS | UI |
| `server.install.failed` | `api` install WS | UI |
| `server.install.completed` | `api` install WS | UI |
| `player.connected` | `worker-log-ingest` | players-projector (UPSERT players) |
| `player.disconnected` | `worker-log-ingest` | players-projector (last_seen) |
| `player.name_changed` | `worker-log-ingest` / `worker-rcon` | players-projector (`player_name_history`) |
| `match.started` / `match.ended` | `worker-log-ingest` | future stats projector |
| `rcon.connected` / `rcon.disconnected` | `worker-rcon` | UI health card |
| `rcon.players_polled` | `worker-rcon` | players-projector |
| `bridge.connected` / `bridge.disconnected` | `api` (bridge plugin) | UI health card |

`EVENT_TYPES` in [`events.ts`](../../../packages/shared-types/src/events.ts) is the authoritative tuple.

## Per-`type` payload examples

```ts
// player.connected
{
  steam_id64: '76561198000000000',
  eos_id: 'a1b2c3...32hex',
  name: 'Player One',
  ip: '203.0.113.5'
}

// rcon.players_polled
{
  players: [
    {
      steam_id64: '76561198000000000',
      eos_id: 'a1b2c3...32hex',
      name: 'Player One',
      team_id: 1,
      squad_id: 2,
      is_leader: true,
      role: 'Rifleman'
    }
  ],
  polled_at: '2026-04-25T12:34:56.789Z'
}
```

## Streams and consumer groups

```
events:server:{uuid}  — per-server pipeline
events:global         — host-scope events (bridge connect/disconnect)
events:dlq            — messages that exhausted the retry budget
```

Consumer groups are named `<service>:v<schema-version>`, e.g. `players-projector:v1`. Bumping the version starts a fresh group that replays the stream from the tail.

## Idempotency (dual-layer)

Every consumer does both before acting:

1. `SET dedup:${group}:${event_id} 1 EX 86400 NX` — fast short-circuit on redelivery.
2. `INSERT INTO processed_events (event_id, group_name) ON CONFLICT DO NOTHING` — durable guarantee that survives Redis restarts.

`XACK` runs only after the side-effect commits. On consumer failure the Redis dedup key is `DEL`-ed so `XAUTOCLAIM`'s retry can proceed.

## Reclaim and DLQ

- `XAUTOCLAIM` runs every 30 s with a 120 s idle threshold.
- After five deliveries to the same pending entry, the reclaimer moves the message to `events:dlq` and `XACK`s the original.

## Upcasting (when `version` changes)

When a new field becomes required:

1. Bump `version` to `2` in producers.
2. Consumers of both versions **must** pass a read-time `upcast(envelope)` that fills in the new field from v1 defaults.
3. Once every producer is on v2, mark v1 deprecated. Remove upcast a release later.

The upcast pipeline lives per-consumer (not shared) so each consumer moves on its own cadence.

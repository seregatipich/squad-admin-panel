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
  actor: { kind: 'user' | 'system' | 'external' | 'player'; id: string | null } | null;  // 'player': id is an in-game EOS id
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
| `server.ready` | `worker-log-ingest` | API |
| `server.installed` | `api` install flow | UI mirror |
| `server.updated` | `api` (post `depot_update`) | UI mirror |
| `server.install.started` | `api` install WS | UI |
| `server.install.progress` | `api` install WS | UI |
| `server.install.failed` | `api` install WS | UI |
| `server.install.completed` | `api` install WS | UI |
| `player.connected` | `worker-log-ingest` | worker-discord, worker-automation |
| `player.disconnected` | `worker-log-ingest` | worker-discord, worker-automation |
| `player.name_changed` | `worker-log-ingest` / `worker-rcon` | worker-discord, worker-automation |
| `match.started` / `match.ended` | `worker-log-ingest` | worker-discord, worker-automation |
| `rcon.connected` / `rcon.disconnected` | `worker-rcon` | UI health card |
| `rcon.admin_command` | `worker-log-ingest` | Events journal (admin command seen in SquadGame.log) |
| `rcon.players_polled` | `worker-rcon` | none (events journal only) |
| `squad.created` / `squad.leader_changed` / `squad.disbanded` | `worker-rcon` (squad history; also inserted into `events`) | events journal, per-player lookups by `actor_id` |
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
events:dlq            — reserved name; nothing writes it today
```

Consumer groups are named `<service>:v<schema-version>`, e.g. `automation-dispatch:v1`, `discord-notify:v1` (a few groups, such as `config-sync` and `diag-flush`, are unversioned). Bumping the version starts a fresh group that replays the stream from the tail.

## Idempotency

A single Redis layer per consumer group: the consumer skips an event whose `dedup:${group}:${event_id}` key exists, runs the side effect, then `SET`s that key (`EX 86400 NX`) and `XACK`s. A failed side effect leaves the entry pending and sets no key, so the reclaim retries it. `processed_events` is no longer written (#62); `events` rows rely on their `(event_id, occurred_at)` primary key. See [flows.md](flows.md#idempotency-protocol).

## Reclaim and retries

- `worker-discord`, `worker-automation` and `worker-config-sync` run `XAUTOCLAIM` on a 30 s tick; the idle threshold is 30 s (60 s for config-sync) and each worker owns its constants.
- There is no DLQ writer. `worker-discord` acks an entry after `MAX_DELIVERY_ATTEMPTS` (10) failed deliveries; the other consumers leave it pending until it succeeds.

## Upcasting (when `version` changes)

When a new field becomes required:

1. Bump `version` to `2` in producers.
2. Consumers of both versions **must** pass a read-time `upcast(envelope)` that fills in the new field from v1 defaults.
3. Once every producer is on v2, mark v1 deprecated. Remove upcast a release later.

The upcast pipeline lives per-consumer (not shared) so each consumer moves on its own cadence.

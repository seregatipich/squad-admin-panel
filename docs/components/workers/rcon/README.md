# worker-rcon

## Purpose

Maintains authenticated Valve-RCON connections to every Squad server whose DB status is `starting` or `running`. Polls player and server-info data on a fixed interval, persists results to Postgres, and publishes events and status keys to Redis.

## Responsibilities

- Reconcile the set of RCON targets against live DB rows every 15 s.
- Open TCP connections and authenticate using the Squad two-packet AUTH quirk.
- Poll `ListPlayers` every 30 s and `ShowServerInfo` every 90 s (keepalive).
- Write `rcon:status:{serverId}` Redis key (TTL 300 s) after every poll.
- Publish `rcon.connected`, `rcon.disconnected`, `rcon.players_polled` envelopes to `events:server:{serverId}`.
- Emit `rcon.connected` / `rcon.auth_failed` / `rcon.disconnected` / `rcon.reconnect_attempt` / `rcon.targets.changed` diag events to the `diag:queue` Redis Stream via `@squad/diag`.
- Upsert `players` and `player_name_history` rows in Postgres.
- Publish `worker:heartbeat:rcon` every 5 s (TTL 30 s).

## What it does not do

- Does not accept inbound RCON commands from the panel — the API sends commands directly via its own short-lived RCON connections.
- Does not manage container lifecycle or server start/stop.
- Does not decrypt credentials itself; decryption uses an inline AES-256-GCM routine seeded from `APP_ENCRYPTION_KEY`.

## Code location

```
apps/workers/rcon/
  src/
    index.ts          — entry point, reconcile loop, shutdown, createDiag wiring
    supervisor.ts     — RconSupervisor + PerServerSupervisor (diag emits)
    client.ts         — RconClient (TCP + multi-packet framing)
    protocol.ts       — Valve RCON encoder/decoder, RconPacketStream
    parse-list-players.ts
    parse-server-info.ts
    persist.ts        — upsertPlayers (players + player_name_history)
  test/
    parse-list-players.test.ts
    parse-server-info.test.ts
    protocol.test.ts
    supervisor.test.ts
    supervisor-diag.test.ts
    contract.test.ts
```

## Dependencies

- `@squad/db` — Drizzle client, `servers`, `serverCredentials`, `serverSettings` tables
- `@squad/diag` — `createDiag({ redis, log })` for per-target lifecycle + targets-changed emits to `diag:queue`
- `@squad/shared-config` — `startHeartbeat`, `resolveRconHost`, `redisSinkStream`
- `@squad/shared-types` — `EventEnvelope`, `STREAM_NAME`, `CONSUMER_GROUP`
- `ioredis` — Redis client
- `pino` — structured logging with multistream (stdout + `panel:logs` Redis sink)

## Components that depend on it

- API — reads `rcon:status:{id}` to build the per-server RCON status response.
- Web — displays RCON state badge from the API.

## Components it depends on

- `packages/db` — schema + migrations
- `packages/shared-config` — heartbeat, metrics, log sink
- `packages/shared-types` — event envelope shapes

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)

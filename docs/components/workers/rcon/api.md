# worker-rcon — API surface

The worker has no HTTP surface. Its public contracts are Redis keys and stream entries.

## Redis key: `rcon:status:{serverId}`

Written by `PerServerSupervisor.writeStatus()` after every state transition and every successful poll.

**TTL:** 300 s. Absence means the server is not being polled (stopped or worker crashed).

**Value shape:**

```json
{
  "state": "connected" | "connecting" | "disconnected",
  "ts": "<ISO-8601>",
  "player_count": 42,
  "last_poll_at": "<ISO-8601>",
  "tickrate_rt": 49.5,
  "current_map": "CAF_Goose_Bay_AAS_v1",
  "next_layer": "Fallujah_RAAS_v1",
  "game_mode": "AAS",
  "backoffMs": 2000,
  "reason": "reconnect-backoff"
}
```

Fields `player_count`, `last_poll_at`, `tickrate_rt`, `current_map`, `next_layer`, `game_mode` are present only when `state = "connected"`.
Fields `backoffMs` and `reason` are present only when `state = "connecting"`.

The API returns `{ state: "not_polled" }` when the key is absent. The UI renders `"— (сервер не запущен)"`.

## Redis stream: `events:server:{serverId}`

Three event types are published by this worker. All entries use field name `envelope` containing JSON-encoded `EventEnvelope`.

### `rcon.connected`

Emitted when AUTH succeeds.

```json
{ "payload": {} }
```

### `rcon.disconnected`

Emitted when the TCP connection drops or the supervisor stops.

```json
{ "payload": {} }
```

### `rcon.players_polled`

Emitted after every successful `ListPlayers` + `ShowServerInfo` cycle.

```json
{
  "payload": {
    "players": [
      {
        "steam_id64": "76561198012345678",
        "eos_id": "abcdef0123456789abcdef0123456789",
        "name": "Alpha",
        "team_id": 1,
        "squad_id": 2,
        "is_leader": true,
        "role": "USA_Rifleman_01"
      }
    ],
    "polled_at": "<ISO-8601>",
    "latency_ms": 45
  }
}
```

## Heartbeat key: `worker:heartbeat:rcon`

Published every 5 s, TTL 30 s. Value is a `HeartbeatPayload` JSON object (see `packages/shared-config/src/heartbeat.ts`). The `status` field contains `"targets=N"` where N is the number of active RCON connections.

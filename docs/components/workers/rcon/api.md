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
  "next_level": "Fallujah",
  "next_layer": "Fallujah_RAAS_v1",
  "game_mode": "AAS",
  "squad_count": 12,
  "backoffMs": 2000,
  "reason": "reconnect-backoff"
}
```

Fields `player_count`, `last_poll_at`, `tickrate_rt`, `current_map`, `next_level`, `next_layer`, `game_mode`, and `squad_count` are present only when `state = "connected"`.
Fields `backoffMs` and `reason` are present only when `state = "connecting"`.

The API returns `{ state: "not_polled" }` when the key is absent. The UI renders `"— (сервер не запущен)"`.

## Redis key: `rcon:squads:{serverId}`

Written after every successful poll.

**TTL:** 90 s.

**Value shape:**

```json
{
  "server_id": "<uuid>",
  "polled_at": "<ISO-8601>",
  "squads": [
    {
      "team_id": 1,
      "team_name": "United States Army",
      "squad_id": 2,
      "name": "INF",
      "size": 9,
      "locked": false,
      "creator_name": "Alpha",
      "creator_eos_id": "abcdef0123456789abcdef0123456789",
      "creator_steam_id64": "76561198012345678",
      "is_command_squad": false
    }
  ]
}
```

## Redis stream: `rcon:commands:{serverId}`

Consumed by `RconCommandQueue` only while the per-server supervisor has an authenticated RCON session. The API writes P0 operator commands here first and uses direct TCP RCON only when the worker is not connected or the stream write fails before the command is accepted.

**Consumer group:** `worker-rcon:commands:v1`.

**Entry shape:** field `request` with JSON:

```json
{
  "request_id": "<uuid-or-request-id>",
  "command": "AdminBroadcast" | "AdminEndMatch" | "AdminReloadServerConfig",
  "args": ["Server is shutting down in 15 seconds"],
  "actor_player_id": "76561198012345678",
  "enqueued_at": "<ISO-8601>"
}
```

Validation is intentionally narrow:

- `AdminBroadcast` requires exactly one non-empty message argument, max 300 chars, with no CR/LF/NUL control characters.
- `AdminEndMatch` accepts no args.
- `AdminReloadServerConfig` accepts no args.
- Other RCON commands are rejected and acknowledged with an error result.

## Redis key: `rcon:command-result:{requestId}`

Written by `RconCommandQueue` after a queued operator command finishes or is rejected.

**TTL:** 120 s.

**Value shape:**

```json
{
  "ok": true,
  "server_id": "<uuid>",
  "request_id": "<uuid-or-request-id>",
  "command": "AdminBroadcast",
  "response": "Broadcast sent",
  "completed_at": "<ISO-8601>",
  "duration_ms": 42
}
```

Failed results use `ok: false` and `error` instead of `response`.

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

Emitted after every successful poll cycle.

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

## Diagnostic events (`diag:queue` Redis Stream)

The worker emits structured `DiagEvent`s via `@squad/diag` (`createDiag({ redis, log })` constructed once at startup, passed into the supervisor). Every emit is fire-and-forget — failures are swallowed so telemetry never derails the supervisor. All five kinds carry `component: 'worker-rcon'`. Lifecycle kinds carry `serverId` so the bundle's per-server brief can group them.

| Kind | Severity | `serverId` | Trigger | Payload fields |
|---|---|---|---|---|
| `rcon.connected` | `info` | yes | AUTH succeeded against the target | `host`, `port` |
| `rcon.auth_failed` | `error` | yes | `RconClient.authenticate()` raised `rcon auth rejected` (id=-1) or `rcon auth timeout` (5 s) | `host`, `port`, `err` |
| `rcon.disconnected` | `warn` | yes | TCP close (remote-close / explicit-close), 3-strike poll-failure circuit-breaker, or supervisor stop | `host`, `port`, `reason` |
| `rcon.reconnect_attempt` | `warn` | yes | Before each backoff sleep that precedes a reconnect | `host`, `port`, `backoffMs` |
| `rcon.targets.changed` | `info` | no | Net delta in the polling set during `RconSupervisor.reconcile()` (no emit when the set is unchanged) | `added: string[]`, `removed: string[]`, `total: number` |

Manual command timeouts are surfaced to the API through `rcon:command-result:{requestId}`. Polling commands (`ListPlayers`, `ListSquads`, `ShowServerInfo`, `ShowNextMap`) still avoid noisy per-command diag emits.

The `events:server:{serverId}` stream still carries the existing `rcon.connected` / `rcon.disconnected` envelope events for the live-bus fan-out — those are unchanged and orthogonal to the new `diag:queue` emits documented above.

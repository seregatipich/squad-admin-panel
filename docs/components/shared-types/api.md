# `shared-types` — API reference

Import paths:

```ts
import { ... } from '@squad/shared-types';          // full barrel
import { ... } from '@squad/shared-types/events';   // event schemas only
import { ... } from '@squad/shared-types/api';      // API DTO schemas only
```

---

## `events.ts`

### Constants

| Export | Type | Description |
|---|---|---|
| `EVENT_TYPES` | `readonly string[]` | 24-element tuple of all event type strings |
| `PAYLOAD_SCHEMAS` | `Partial<Record<EventType, ZodTypeAny>>` | Zod schema per event type that has a typed payload |
| `STREAM_NAME.eventsServer(serverId)` | `string` | `events:server:{serverId}` |
| `STREAM_NAME.eventsGlobal()` | `string` | `events:global` |
| `STREAM_NAME.eventsDlq()` | `string` | `events:dlq` |
| `CONSUMER_GROUP.playersProjector` | `string` | `players-projector:v1` |
| `CONSUMER_GROUP.auditArchiver` | `string` | `audit-archiver:v1` |
| `CONSUMER_GROUP.stats` | `string` | `stats:v1` |
| `DEDUP_TTL_SECONDS` | `number` | `86_400` |
| `XAUTOCLAIM_IDLE_MS` | `number` | `120_000` |
| `XAUTOCLAIM_TICK_MS` | `number` | `30_000` |
| `DLQ_DELIVER_THRESHOLD` | `number` | `5` |

### `eventEnvelope` (Zod schema)

Validates the outer `EventEnvelope` wrapper. Strict (no extra keys).

```ts
import { eventEnvelope, type EventEnvelope } from '@squad/shared-types/events';

const envelope = eventEnvelope.parse(rawRedisPayload);
```

Fields: `event_id` (UUID), `version` (positive int), `type` (EventType), `server_id` (UUID | null), `ts` (ISO datetime), `actor` (`{ kind, id }` | null), `correlation_id` (UUID | null), `payload` (unknown).

### `validatePayload<T extends EventType>(type, payload): { ok: true; data } | { ok: false; errors }`

Validates a payload against the registered schema for the given event type. Returns `ok: true` for unknown types (forward-compat).

```ts
const result = validatePayload('player.connected', body);
if (!result.ok) throw new Error(result.errors[0].message);
```

### `DEDUP_KEY(group, eventId): string`

Returns `dedup:{group}:{eventId}`.

### Per-type payload schemas

| Zod schema | EventType(s) | TypeScript type |
|---|---|---|
| `playerConnectedPayload` | `player.connected` | `PlayerConnectedPayload` |
| `playerDisconnectedPayload` | `player.disconnected` | `PlayerDisconnectedPayload` |
| `rconPlayersPolledPayload` | `rcon.players_polled` | `RconPlayersPolledPayload` |
| `matchStateChangedPayload` | `match.started`, `match.ended` | `MatchStateChangedPayload` |
| `serverLifecyclePayload` | `server.ready`, `server.starting`, `server.running`, `server.stopping`, `server.stopped`, `server.crashed` | `ServerLifecyclePayload` |

#### `playerConnectedPayload`

```ts
{ steam_id64: string; eos_id: string | null; name: string; ip: string | null }
```

`steam_id64` is validated as `/^\d{17}$/`; `eos_id` as `/^[a-f0-9]{32}$/`.

#### `playerDisconnectedPayload`

```ts
{ steam_id64: string; eos_id: string | null; reason: string | null }
```

#### `rconPlayersPolledPayload`

```ts
{
  players: Array<{
    steam_id64: string; eos_id: string | null; name: string;
    team_id: number | null; squad_id: number | null;
    is_leader?: boolean; role?: string;
  }>;
  polled_at: string;  // ISO datetime
  latency_ms: number;
}
```

#### `matchStateChangedPayload`

```ts
{ from_state: string; to_state: string; layer: string | null; game_mode: string | null }
```

#### `serverLifecyclePayload`

```ts
{ pid: number | null; reason: string | null; exit_code: number | null }
```

---

## `api.ts`

Zod schemas for API request/response bodies. Import as `@squad/shared-types/api` or via the barrel.

### `uuidString`

`z.string().uuid()` — reusable UUID validator.

### `hostInfo`

Strict schema for bridge `host_info` response. Fields: `hostname`, `os_name`, `os_version`, `kernel`, `arch`, `cpu_model`, `cpu_cores` (positive int), `ram_total_bytes` (nonneg int).

```ts
import { hostInfo, type HostInfo } from '@squad/shared-types/api';
const info: HostInfo = hostInfo.parse(bridgeResult);
```

### `hostMetrics`

Strict schema for live metrics snapshot. Fields: `cpu_percent` (0–100), `ram_used_bytes`, `ram_total_bytes`, `disk_used_bytes`, `disk_total_bytes`, `net_rx_bytes_per_sec`, `net_tx_bytes_per_sec`, `sampled_at` (ISO datetime).

### `bridgeStatus`

```ts
{ connected: boolean; version: string | null; uptime_seconds: number | null; last_error: string | null }
```

### `serverStatus`

Enum schema: `'pending' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'`.

### `serverCreateInput`

Input schema for `POST /api/v1/servers`. All required unless noted:

| Field | Type / constraints |
|---|---|
| `display_name` | string, 1–120 chars |
| `slug` | string, regex `/^[a-z0-9][a-z0-9-]{0,63}$/` |
| `description` | string, max 500, nullable, optional |
| `game_port` | int, 1024–65535 |
| `query_port` | int, 1024–65535 |
| `beacon_port` | int, 1024–65535 |
| `rcon_port` | int, 1024–65535 |
| `multihome` | string, default `'0.0.0.0'` |
| `max_players` | int, 1–100, default 100 |
| `tickrate` | int, 10–120, default 50 |
| `extra_args` | string, default `''` |
| `launch_args_override` | string, nullable, optional |
| `cpu_affinity` | string, nullable, optional |
| `cpu_weight` | int, 1–10000, nullable, optional |
| `niceness` | int, −20–19, nullable, optional |
| `memory_high_mb` | positive int, nullable, optional |
| `memory_max_mb` | positive int, nullable, optional |
| `io_weight` | int, 1–10000, nullable, optional |

### `serverRow`

Response schema for a server record as returned by `GET /api/v1/servers` and related endpoints.

| Field | Type |
|---|---|
| `id` | UUID string |
| `display_name` | string |
| `slug` | string |
| `description` | string \| null |
| `status` | ServerStatus |
| `tags` | string[] (default []) |
| `game_port`, `query_port`, `beacon_port`, `rcon_port` | int |
| `max_players`, `tickrate` | int |
| `multihome` | string |
| `created_at`, `updated_at` | ISO datetime string |

### `playerRow`

Response schema for a player record.

```ts
{
  steam_id64: string;          // 17-digit regex
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
  is_online?: boolean;
}
```

### `auditEntry`

Response schema for a single audit log row.

```ts
{
  id: string;                  // bigserial, serialized as string
  created_at: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_ip: string | null;
  actor_kind: 'user' | 'system' | 'external';
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
  duration_ms: number | null;
}
```

Note: `id` is `string` because `bigserial` exceeds JavaScript's safe integer range (`JSON.stringify` would lose precision on a bare number).

### `paginated<T>(item)`

Generic paginated response schema factory:

```ts
const paginatedServers = paginated(serverRow);
type PaginatedServers = z.infer<typeof paginatedServers>;
// { items: ServerRow[]; total: number; page: number; page_size: number }
```

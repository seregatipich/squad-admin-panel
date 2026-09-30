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
| `PAYLOAD_SCHEMAS` | `{ [type]: ZodSchema }` (`satisfies Partial<Record<EventType, ZodTypeAny>>`) | Zod schema per event type that has a typed payload; keeps each entry's exact schema type |
| `STREAM_NAME.eventsServer(serverId)` | `string` | `events:server:{serverId}` |
| `STREAM_NAME.eventsGlobal()` | `string` | `events:global` |
| `STREAM_NAME.eventsDlq()` | `string` | `events:dlq` |
| `DEDUP_TTL_SECONDS` | `number` | `86_400` |

### `eventEnvelope` (Zod schema)

Validates the outer `EventEnvelope` wrapper. Strict (no extra keys).

```ts
import { eventEnvelope, type EventEnvelope } from '@squad/shared-types/events';

const envelope = eventEnvelope.parse(rawRedisPayload);
```

Fields: `event_id` (UUID), `version` (positive int), `type` (EventType), `server_id` (UUID | null), `ts` (ISO datetime), `actor` (`{ kind, id }` | null), `correlation_id` (UUID | null), `payload` (unknown).

### `validatePayload(type, payload): { ok: true; data } | { ok: false; errors }`

Validates a payload against the registered schema for the given event type. For a type in `PAYLOAD_SCHEMAS`, `data` is typed as that schema's inferred payload (e.g. `PlayerConnectedPayload`); for any other type it returns `ok: true` with `data: unknown` (forward-compat). Not called by the worker consumers: they still narrow `event.payload` with assertions, and wiring validation in would send events from a newer producer to the DLQ, so it stays opt-in.

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

## `plugins.ts`

Contract for the automation worker's plugin/event-hook system (`INT-4`, see `apps/workers/automation`).

### `PLUGIN_PERMISSIONS` / `PluginPermission`

`['events:read', 'events:payload'] as const`. Enforced by the automation worker's dispatcher, not merely documented:

| Permission | Effect if a plugin's manifest omits it |
|---|---|
| `events:read` | The plugin is never dispatched to at all. |
| `events:payload` | The plugin is dispatched to, but `payload` is redacted to `null` in the envelope it receives. |

### `pluginManifest` (Zod schema) / `PluginManifest`

Strict schema for a plugin's manifest:

```ts
{
  id: string;                        // lowercase kebab-case slug, regex-validated, 2-64 chars
  name: string;                      // 1-128 chars
  version: string;                   // 1-32 chars
  subscribedEventKinds: EventType[]; // non-empty; each must be a value from EVENT_TYPES
  requestedPermissions: PluginPermission[]; // subset of PLUGIN_PERMISSIONS
}
```

```ts
import { pluginManifest, type PluginManifest } from '@squad/shared-types';

const manifest: PluginManifest = pluginManifest.parse(rawManifest);
```

### `hasPluginPermission(manifest, permission): boolean`

Returns whether `manifest.requestedPermissions` includes `permission`.

### `PluginHandler` (TS interface, not a Zod schema)

```ts
interface PluginHandler {
  onEvent(envelope: EventEnvelope): void | Promise<void>;
}
```

Invoked once per matching event by the automation worker's dispatcher, under a try/catch and a per-invocation timeout — implementations must not assume they run to completion.

---

## `api.ts`

Zod schemas for API request/response bodies. Import as `@squad/shared-types/api` or via the barrel.

### `uuidString`

`z.string().uuid()` — reusable UUID validator.

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
| `multihome` | IPv4/IPv6 literal (`z.string().ip()`), default `'0.0.0.0'` — the bridge puts it on the Squad command line |

| `multihome` | IPv4/IPv6 literal (`z.string().ip()`), default `'0.0.0.0'` |
| `max_players` | int, 1–100, default 100 |
| `tickrate` | int, 10–120, default 50 |
| `extra_args` | literal `''`, optional — any other value is rejected (#53) |
| `launch_args_override`, `cpu_affinity`, `cpu_weight`, `niceness`, `memory_high_mb`, `memory_max_mb`, `io_weight` | `null`, optional — a value is rejected: the container is never started with these (#53) |


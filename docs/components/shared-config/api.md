# `shared-config` — API reference

Import paths:

```ts
import { ... } from '@squad/shared-config';               // full barrel (Node only)
import { ... } from '@squad/shared-config/permissions';   // browser-safe
import { ... } from '@squad/shared-config/role-colors';   // browser-safe
```

---

## `bridge-methods.ts`

### Constants

| Export | Type | Value |
|---|---|---|
| `BRIDGE_METHODS` | `readonly string[]` | 19-element tuple of all allowed RPC method names |
| `BRIDGE_STREAMING_METHODS` | `readonly BridgeMethod[]` | `['container_logs_follow', 'depot_update']` |
| `BRIDGE_SOCKET_DEFAULT` | `string` | `/run/panel-host-bridge.sock` |
| `BRIDGE_MAX_FRAME_BYTES` | `number` | `16777216` (16 MiB) |
| `SQUAD_APP_ID` | `number` | `403240` (Steam app ID) |
| `PANEL_DATA_ROOT` | `string` | `/var/lib/squad-panel` |
| `PANEL_CONFIGS_ROOT` | `string` | `/var/lib/squad-panel/configs` |
| `PANEL_SAVED_ROOT` | `string` | `/var/lib/squad-panel/saved` |
| `DEPOT_VOLUME_NAME` | `string` | `squad-depot` |
| `SERVER_IMAGE` | `string` | `squad-server:latest` |
| `DEPOT_INIT_IMAGE` | `string` | `squad-panel/depot-init:latest` |
| `SERVER_CONTAINER_PREFIX` | `string` | `squad-` |
| `SERVER_CONTAINER_REGEX` | `RegExp` | Validates `squad-{uuid}` container names |
| `ALLOWED_CONFIG_FILES` | `readonly AllowedConfigFile[]` | 19 `.cfg` filenames editable via the config editor |
| `HOT_RELOAD_FILES` | `readonly AllowedConfigFile[]` | Files Squad re-reads live: `Admins.cfg`, `Bans.cfg`, `RemoteAdminListHosts.cfg`, `RemoteBanListHosts.cfg` |
| `ROTATION_FILES` | `readonly AllowedConfigFile[]` | 9 layer/rotation/voting config files |

### Types

| Export | Description |
|---|---|
| `BridgeMethod` | Union of the 19 method name strings |
| `AllowedConfigFile` | Union of the 19 allowed `.cfg` filenames |

### `configFileClass(name: AllowedConfigFile): 'hot_reload' | 'rotation' | 'requires_restart'`

Returns the reload class for a config file. Used by the web UI to show a "restart required" badge.

```ts
import { configFileClass } from '@squad/shared-config';

configFileClass('Admins.cfg');      // 'hot_reload'
configFileClass('LayerRotation.cfg'); // 'rotation'
configFileClass('Server.cfg');      // 'requires_restart'
```

---

## `heartbeat.ts`

### Constants

| Export | Type | Value |
|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | `number` | `5_000` |
| `HEARTBEAT_TTL_SECONDS` | `number` | `30` |
| `HEARTBEAT_PREFIX` | `string` | `worker:heartbeat:` |

### `heartbeatKey(name: string): string`

Returns the Redis key `worker:heartbeat:{name}`.

### `startHeartbeat(opts: StartHeartbeatOptions): () => void`

Starts a periodic heartbeat publisher. Returns a stop function.

```ts
import { startHeartbeat } from '@squad/shared-config';

const stop = startHeartbeat({
  redis,
  name: 'worker-rcon',
  version: '1.2.3',
  statusFn: () => `connected:${serverId}`,
  onError: (err) => logger.error(err, 'heartbeat failed'),
});

// on shutdown:
stop();
```

**Options:**

| Field | Type | Default | Description |
|---|---|---|---|
| `redis` | `HeartbeatRedis` | required | Minimal Redis interface: `set(key, value, 'EX', ttl)` |
| `name` | `string` | required | Worker name (e.g. `worker-rcon`) |
| `intervalMs` | `number` | `HEARTBEAT_INTERVAL_MS` | Publish frequency |
| `ttlSeconds` | `number` | `HEARTBEAT_TTL_SECONDS` | Redis key TTL |
| `version` | `string` | undefined | Binary version published in the heartbeat |
| `onError` | `(err: Error) => void` | undefined | Called on Redis set failure |
| `statusFn` | `() => string \| undefined` | undefined | Returns a short ad-hoc status string |

**HeartbeatPayload** written to Redis (JSON-serialized):

```ts
{
  name: string;
  ts: string;          // ISO-8601 UTC
  pid: number;
  hostname?: string;
  version?: string;
  started_at: string;  // ISO-8601 UTC, when startHeartbeat was called
  status?: string;
}
```

---

## `log-stream.ts`

### Constants

| Export | Type | Value |
|---|---|---|
| `LOG_SOURCES` | `readonly LogSource[]` | `['bridge','rcon','log-ingest','worker','depot','install','api']` |
| `LOG_LEVELS` | `readonly LogLevel[]` | `['debug','info','warn','error']` |
| `PANEL_LOGS_STREAM` | `string` | `panel:logs` |
| `PANEL_LOGS_MAXLEN` | `number` | `100_000` |

### `encodeLogEntry(e: Omit<LogEntry, 'ts'>): Record<string, string>`

Encodes a log entry into Redis Stream field map using single-letter keys (`s`, `l`, `m`, `i`, `c`).

```ts
encodeLogEntry({ source: 'rcon', level: 'info', msg: 'auth ok', serverId: '...' })
// { s: 'R', l: 'I', m: 'auth ok', i: '...' }
```

### `decodeLogEntry(streamId: string, fields: Record<string, string>): LogEntry`

Decodes a Redis Stream entry back to `LogEntry`. Extracts the timestamp from the stream ID prefix.

Throws if `fields.s` or `fields.l` are unknown codes.

### `sourceCode(s: LogSource): string`

Maps a source name to its single-letter code. `bridge → 'B'`, `rcon → 'R'`, `log-ingest → 'L'`, `worker → 'W'`, `depot → 'D'`, `install → 'I'`, `api → 'A'`.

### `sourceFromCode(c: string): LogSource`

Reverse lookup. Throws on unknown code.

---

## `log-stream-sink.ts`

### `redisSinkStream(opts: RedisSinkOptions): Writable`

Creates a `node:stream.Writable` that accepts newline-delimited pino JSON and writes each log line as a Redis Stream entry to `PANEL_LOGS_STREAM`.

```ts
import { redisSinkStream } from '@squad/shared-config';
import pino from 'pino';

const sink = redisSinkStream({ redis, defaultSource: 'api', minLevel: 'info' });
const logger = pino({ level: 'info' }, pino.multistream([{ stream: sink }]));
```

**Options:**

| Field | Type | Default | Description |
|---|---|---|---|
| `redis` | `RedisLike` | required | `xadd(...args)` interface |
| `defaultSource` | `LogSource` | required | Used when the log line has no `src` field |
| `minLevel` | `LogLevel` | `'debug'` | Lines below this level are dropped |

The sink strips pino-http metadata keys (`req`, `res`, `responseTime`, `reqId`, `name`, `pid`, `hostname`, `time`, `v`, `service`) from the `ctx` field to avoid leaking PII or verbose HTTP objects.

On `redis.xadd` failure the error is written to `process.stderr` once per sink instance (latch prevents log storms).

---

## `metrics-pack.ts`

### Constants

| Export | Type | Value |
|---|---|---|
| `HOST_METRICS_STREAM` | `string` | `host:metrics` |
| `HOST_METRICS_MAXLEN` | `number` | `5760` (48 h at 30 s intervals) |

### `packHostMetrics(m: HostMetricsSample): number[]`

Encodes a metrics sample into an 8-element integer array for compact Redis Stream storage. Percentages and load averages are multiplied by 100; byte counts are stored as raw integers.

```ts
packHostMetrics({ cpu_percent: 73.51, ram_used_bytes: 1234567890, ... })
// [7351, 1234567890, 55667788, 1234, 567, 53, 71, 89]
```

Tuple order: `[cpu×100, ram_used, disk_used, net_rx, net_tx, load1m×100, load5m×100, load15m×100]`.

### `unpackHostMetrics(v: number[]): HostMetricsSample`

Inverse of `packHostMetrics`. Divides indices 0, 5, 6, 7 by 100.

---

## `permissions.ts`

### Constants

| Export | Type | Description |
|---|---|---|
| `PERMISSIONS` | `readonly PermissionDef[]` | 48-entry registry (see [data-model.md](data-model.md) for full list) |
| `PERMISSION_KEYS` | `readonly PermissionKey[]` | All 48 key strings derived from `PERMISSIONS` |
| `PERMISSION_CATEGORIES` | `readonly PermissionCategory[]` | 16 category strings |

### `isPermissionKey(x: string): x is PermissionKey`

Type guard. Returns `true` if `x` is a valid permission key.

```ts
if (isPermissionKey(req.body.key)) { /* narrowed to PermissionKey */ }
```

---

## `rcon-host.ts`

### `resolveRconHost(credsHost, env?): string`

Resolves the RCON host to dial for a server. Priority: explicit credential value → `RCON_HOST_DEFAULT` env var → `'127.0.0.1'`.

```ts
import { resolveRconHost } from '@squad/shared-config';

// In apps/api (compose bridge network): RCON_HOST_DEFAULT=host.docker.internal
resolveRconHost(null, process.env);       // 'host.docker.internal'

// In worker-rcon (--network host):       RCON_HOST_DEFAULT=127.0.0.1
resolveRconHost(null, process.env);       // '127.0.0.1'

// Pinned remote instance:
resolveRconHost('203.0.113.5', process.env); // '203.0.113.5'
```

Empty string is treated as `null/undefined` — it does not short-circuit resolution.

---

## `role-colors.ts`

### Constants

| Export | Type | Value |
|---|---|---|
| `ROLE_COLORS` | `readonly RoleColor[]` | 16-entry palette (see [data-model.md](data-model.md)) |
| `ROLE_COLOR_SET` | `ReadonlySet<string>` | Set for O(1) lookup |

### `isRoleColor(x: string): x is RoleColor`

Type guard. Returns `true` if `x` is one of the 16 palette colors.

```ts
import { isRoleColor } from '@squad/shared-config/role-colors';

isRoleColor('emerald');  // true
isRoleColor('magenta');  // false
```

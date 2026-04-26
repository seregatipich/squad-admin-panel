# `shared-config` — flows

## Permissions registry → route RBAC gate

```
@squad/shared-config/permissions
  └─ PERMISSIONS, PermissionKey
       │
       ├─ apps/api route definitions
       │    config.permissions: PermissionKey[]
       │    e.g. { permissions: ['server:start', 'server:restart'] }
       │
       └─ apps/api/src/plugins/rbac.ts
            preHandler hook:
              1. extract session user_id
              2. SELECT role permissions from DB
              3. for each key in config.permissions:
                   if not in user permission set → 403
```

The RBAC doc lives at [`docs/architecture/rbac.md`](../../architecture/rbac.md). `PermissionKey` is the TypeScript type that enforces at compile time that only known keys appear in route configs.

## Log-stream-sink → Redis Stream `panel:logs`

```
Worker / API process
  │
  └─ pino logger
       multistream:
         [process.stdout, redisSinkStream({ redis, defaultSource, minLevel })]
              │
              └─ each newline-delimited JSON log line:
                   1. JSON.parse
                   2. pinoLevelToLog (numeric level → LogLevel)
                   3. drop if LEVEL_RANK[level] < minRank
                   4. read src field → LogSource; fall back to defaultSource
                   5. strip pino-http meta keys from ctx
                   6. encodeLogEntry → Redis field map {s,l,m,i?,c?}
                   7. redis.xadd('panel:logs', 'MAXLEN', '~', '100000', '*', ...fields)
```

Log consumers (e.g. `apps/api/src/routes/logs.ts`) read from `panel:logs` using `XREVRANGE` for the last N entries, then `decodeLogEntry` to reconstruct `LogEntry` objects with timestamps.

## Metrics-pack → Redis Stream `host:metrics`

```
worker-metrics-sampler (or API status-reconciler)
  │
  ├─ call bridge.hostMetrics() → HostMetrics
  ├─ packHostMetrics(metrics) → number[8]
  └─ redis.xadd('host:metrics', 'MAXLEN', '~', '5760', '*',
                 'v', JSON.stringify(packed))

apps/api GET /api/v1/host/metrics/history
  └─ redis.xrange('host:metrics', '-', '+', 'COUNT', n)
       └─ unpackHostMetrics(JSON.parse(entry.v)) → HostMetricsSample[]
```

## Heartbeat → `/api/v1/health/workers`

```
Worker process startup
  └─ startHeartbeat({ redis, name: 'worker-rcon', ... })
       └─ setInterval(5s):
            redis.set('worker:heartbeat:worker-rcon', JSON.stringify(payload), 'EX', 30)

GET /api/v1/health/workers (apps/api)
  └─ for each known worker name:
       redis.get('worker:heartbeat:{name}')
         present  → worker alive; parse payload; check ts < 10 s ago
         absent   → worker dead (key expired)
```

## configFileClass → web UI "restart required" banner

```
apps/web config editor component
  ├─ import { configFileClass } from '@squad/shared-config'
  ├─ configFileClass(filename)
  │    'hot_reload'      → no banner (Squad re-reads live)
  │    'rotation'        → informational hint ("rotation will apply on next map")
  │    'requires_restart' → warning banner "Restart required to apply changes"
  └─ displayed below the Monaco editor save button
```

## Sub-path exports and browser bundles

`log-stream-sink.ts` imports `node:stream` (a Node.js built-in). Next.js 15's bundler cannot resolve `node:stream` in client components. The `./role-colors` and `./permissions` sub-path exports are browser-safe and contain only pure TypeScript with no Node.js imports.

```
apps/web/src/components/RoleEditor.tsx
  └─ import { ROLE_COLORS, isRoleColor } from '@squad/shared-config/role-colors'
       OK: no node:stream dependency

apps/api/src/plugins/rbac.ts
  └─ import { PERMISSIONS, isPermissionKey } from '@squad/shared-config'
       OK: server-side only
```

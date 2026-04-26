# `shared-config` — troubleshooting

## Web build fails: `Module not found: Can't resolve 'node:stream'`

**Symptom**: `next build` or `next dev` errors on a client component that imports from `@squad/shared-config`.

**Cause**: The full barrel (`@squad/shared-config`) re-exports `log-stream-sink.ts`, which imports `node:stream`. Next.js cannot bundle Node.js built-ins in browser bundles.

**Fix**: Switch to the browser-safe sub-paths:

```ts
// Before (breaks in client components):
import { ROLE_COLORS } from '@squad/shared-config';

// After:
import { ROLE_COLORS } from '@squad/shared-config/role-colors';
import { PERMISSIONS, isPermissionKey } from '@squad/shared-config/permissions';
```

Server components, API routes, and workers can continue using `@squad/shared-config` without restriction.

## `role-colors.test.ts` fails with "CHECK constraint not found in migration"

**Symptom**: The test that reads `0009_panel_rbac.sql` cannot locate the `roles_color_palette` CHECK constraint.

**Cause**: The SQL migration was renamed, regenerated, or the constraint format changed.

**Diagnostic**:
```bash
grep -n 'roles_color_palette' packages/db/drizzle/*.sql
```

**Fix**: If the migration was split or renumbered, update the filename in `role-colors.test.ts`. If the constraint format changed, update the regex that extracts the color list.

## `BridgeError('forbidden')` from `fileAtomicWrite` despite using `PANEL_CONFIGS_ROOT`

**Symptom**: A config write is rejected even though the path starts with `/var/lib/squad-panel/configs/`.

**Cause**: The Go bridge path allowlist is hardcoded and may have drifted from `PANEL_CONFIGS_ROOT`.

**Diagnostic**:
```bash
grep -n 'PANEL_CONFIGS_ROOT\|/var/lib/squad-panel' packages/shared-config/src/bridge-methods.ts
grep -n 'AllowedPath\|allowedPath\|squad-panel' apps/bridge/internal/handlers/handlers.go
```

**Fix**: Ensure the Go allowlist and `PANEL_CONFIGS_ROOT` agree on the path prefix.

## `rcon.players_polled` not appearing in `panel:logs`

**Symptom**: The log stream has entries from `api` but not from `rcon` source.

**Cause**: Either `worker-rcon` is not running, or its pino logger is not wired to `redisSinkStream`.

**Diagnostic**:
```bash
redis-cli GET worker:heartbeat:worker-rcon    # check liveness
docker compose logs worker-rcon --since 2m    # check for startup errors
```

**Fix**: Verify `startHeartbeat` and `redisSinkStream` are both called in `apps/workers/rcon/src/index.ts`.

## Heartbeat key missing despite worker being alive

**Symptom**: `/api/v1/health/workers` shows a worker as dead, but its container is running.

**Cause**: TTL is 30 s; if `setInterval` fires late (GC pause, event loop stall) the key can expire before the next publish.

**Diagnostic**:
```bash
redis-cli TTL worker:heartbeat:worker-rcon
docker compose logs worker-rcon --since 1m
```

**Fix**: If the worker is genuinely running and this is intermittent, it is a normal observation. If persistent, check for blocking I/O or uncaught exceptions preventing the heartbeat tick.

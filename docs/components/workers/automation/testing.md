# worker-automation — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-automation build
pnpm --filter @squad/worker-automation test
```

(`build` is required before `contract.test.ts`, which spawns `dist/index.js`.)

## Test files

All tests live under `apps/workers/automation/test/`.

### `registry.test.ts`

Unit tests for `PluginRegistry`: manifest validation at registration, per-kind indexing, duplicate-id rejection, `list()`.

### `loader.test.ts`

Unit tests for `loadPlugins`/`BUILTIN_PLUGINS`.

### `dispatch.test.ts`

Unit tests for `dispatchEnvelope` and `parseStreamEnvelope` against a fake registry/logger (no Redis): permission gating (`events:read`, `events:payload` redaction), unsubscribed-kind exclusion, and isolation of a throwing / async-rejecting / hanging (past timeout) plugin handler.

### `plugin-dispatch.test.ts` (integration — real Redis, real wiring)

Runs `runDispatchLoop` against a real Redis instance (`redis://127.0.0.1:6379/14`), `XADD`s an `EventEnvelope` onto `events:global`, and asserts on what registered test plugins actually received:

| Test | What it verifies |
|---|---|
| Delivers the exact envelope to a subscribed plugin | End-to-end wiring: `XADD` → consumer loop → dispatch → plugin handler |
| A plugin not subscribed to the kind never receives it | Per-kind subscription filtering |
| A throwing plugin and a hanging plugin are isolated | Neither crashes the loop nor blocks a third subscriber; the loop keeps processing a second event afterward |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:automation` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path (dispatch loop stop flag + `redis.quit()`) |

## Coverage gaps

No first-party automation plugin exists yet (`AUTO-1`..`AUTO-4` are separate backlog items) — this pass only covers the host (registry, loader, dispatch, permission gate). A future filesystem/dynamic plugin loader will need its own test coverage when it lands.

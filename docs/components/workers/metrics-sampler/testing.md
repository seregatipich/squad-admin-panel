# worker-metrics-sampler — Testing

## Running tests

```bash
pnpm --filter @squad/worker-metrics-sampler test
# or from the repo root:
pnpm turbo run test --filter=@squad/worker-metrics-sampler
```

## Test files

### `sampler.test.ts`

Unit tests for `runSampler` using fake timers and mock bridge/Redis.

| Test | What it verifies |
|---|---|
| XADDs one packed sample per tick to `host:metrics` | Correct stream name, field `v`, 3 ticks in 305 ms with interval=100 ms |
| Packed array matches expected encoding | `cpu_percent=50 → 5000`, `load_avg_1m=0.5 → 50`, etc. |
| Continues sampling after a bridge error | First call throws; subsequent calls succeed; at least 2 XADD calls |

### `maxlen.test.ts`

Unit tests for MAXLEN enforcement in `runSampler`.

| Test | What it verifies |
|---|---|
| Every `xadd` call passes `MAXLEN ~ HOST_METRICS_MAXLEN` | Stream trimming arguments are present on all calls |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:metrics-sampler` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

- Bridge reconnection after socket failure is covered by the e2e suite in `apps/api/test/e2e/bridge-rpc.e2e.test.ts`.

## Test data

Tests use vitest fake timers (`vi.useFakeTimers`) to advance time without wall-clock delay. Mock bridge returns a full `HostMetrics` struct; mock Redis records `xadd` calls in an array for assertions.
